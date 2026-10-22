/** Bounded, durable output-limit continuation with conservative exact-call protection. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { ContinuationState } from './types.ts'
import { callKey, continuationProjection, markerOf } from './state.ts'

export const name = 'output-continuation'
export const inject = ['agents', 'tools', 'sessionProjections']

/** Same-turn automatic output-limit budget. Zero disables continuation and its tool guard. */
export interface Config {
  /** Integer from 0 through 10; default 2. Tool successes do not replenish it. */
  maxContinuations?: number
}

export const Config: z<Config> = z.object({ maxContinuations: z.number().default(2) })

function continuationText(attempt: number, limit: number): string {
  return `Your previous response reached its output limit. Continue the unfinished task from the recorded history. This is automatic continuation ${attempt} of ${limit} for this turn.\n`
    + 'Keep completed work and recorded tool results; do not repeat tool calls that already ran or may have run. Tool calls in the truncated response were not executed; issue any still-needed calls again with complete arguments. Do not reconstruct or execute partial tool arguments.\n'
    + (attempt === limit
      ? 'This is the last automatic continuation. Finish concisely if possible; otherwise explain the remaining work and ask the user to continue.\n'
      : 'Continue concisely and finish when the task is complete.\n')
    + 'Exact repeated tool calls are blocked during automatic continuation, including calls whose earlier outcome is uncertain. Different arguments do not guarantee that a repeated side effect is safe.'
}

const DUPLICATE_REASON = 'Automatic continuation blocked an identical tool call that already ran or may have run in this turn. Inspect the recorded result and continue without repeating that operation. No previous success result has been substituted.'

/** Install disposable listeners, projection, and executor guard without changing model budgets. */
export function apply(ctx: Context, config: Config): void {
  const limit = config.maxContinuations ?? 2
  if (!Number.isInteger(limit) || limit < 0 || limit > 10) {
    throw new Error('output-continuation: maxContinuations must be an integer from 0 through 10')
  }
  ctx.sessionProjections.register(continuationProjection)
  const subscriptions = new Map<Agent, { signal: AbortSignal; detach: () => void }>()

  function stateOf(agent: Agent): ContinuationState {
    const state = ctx.sessionProjections.stateOf(agent.session, 'outputContinuation')
    if (state === undefined) throw new Error('output-continuation projection is not registered')
    return state
  }

  function removePending(agent: Agent, all = true): void {
    const state = stateOf(agent)
    for (const message of [...agent.inbox.nextStep, ...agent.inbox.nextTurn]) {
      if (message.source.kind !== name) continue
      const marker = markerOf(message)
      if (all || marker === undefined || state.closed || state.manual || marker.turn !== state.turn) agent.inbox.remove(message.id)
    }
  }

  function bindSignal(agent: Agent, signal: AbortSignal): void {
    const previous = subscriptions.get(agent)
    if (previous?.signal === signal) return
    previous?.detach()
    const abort = (): void => { removePending(agent) }
    signal.addEventListener('abort', abort, { once: true })
    subscriptions.set(agent, { signal, detach: () => { signal.removeEventListener('abort', abort) } })
    if (signal.aborted) abort()
  }
  ctx.effect(() => () => { for (const entry of subscriptions.values()) entry.detach(); subscriptions.clear() })

  ctx.on('agent/created', ({ agent }) => { removePending(agent, false); return undefined })
  for (const agent of ctx.agents.list()) removePending(agent, false)
  ctx.on('agent/status', ({ agent, status }) => {
    if (status !== 'idle') return
    removePending(agent)
    subscriptions.get(agent)?.detach()
    subscriptions.delete(agent)
  })

  ctx.on('agent/pre-step', async ({ agent, messages, turn, signal }, next): Promise<PreStepDecision> => {
    bindSignal(agent, signal)
    removePending(agent, false)
    const decision = await next()
    signal.throwIfAborted()
    if (decision.kind === 'reject') return decision
    const state = stateOf(agent)
    const human = [...messages, ...decision.messages].some(message => message.source.kind === 'user')
    let admitted: ReturnType<typeof markerOf>
    const filtered = decision.messages.filter((message) => {
      if (message.source.kind !== name) return true
      const marker = markerOf(message)
      if (limit === 0 || human || state.manual || state.closed || marker === undefined
        || marker.turn !== turn || marker.turn !== state.turn || marker.attempt > limit
        || state.latest?.finish !== 'max-tokens' || marker.triggerAssistantSeq !== state.latest.seq
        || !state.markers.some(receipt => receipt.id === message.id) || admitted !== undefined) return false
      admitted = marker
      return true
    })
    if (admitted === undefined) return { ...decision, messages: filtered }
    return { ...decision, messages: filtered, resumesAfterMaxTokens: admitted.triggerAssistantSeq }
  })

  ctx.on('agent/turn-stopping', ({ agent, turn, signal }) => {
    bindSignal(agent, signal)
    signal.throwIfAborted()
    const state = stateOf(agent)
    if (limit === 0 || state.closed || state.manual || state.turn !== turn || state.latest?.finish !== 'max-tokens') return
    if (agent.inbox.nextTurn.some(message => message.source.kind === 'user')
      || agent.inbox.nextStep.some(message => message.source.kind === 'user')) { removePending(agent); return }
    if (state.markers.some(marker => marker.triggerAssistantSeq === state.latest?.seq)) return
    const attempt = Math.max(0, ...state.markers.map(marker => marker.attempt)) + 1
    if (attempt > limit) return
    signal.throwIfAborted()
    agent.inject(createUserMessage({
      content: [{ type: 'text', text: continuationText(attempt, limit) }],
      source: { kind: name, turn, triggerAssistantSeq: state.latest.seq, attempt, form: 'notice', summary: `Output continuation ${attempt}/${limit}` },
    }))
  })

  function duplicate(exec: Readonly<ToolExecution>): string | undefined {
    const agent = exec.agent
    if (agent === undefined || limit === 0) return
    const state = stateOf(agent)
    if (!state.active || state.manual || state.closed) return
    const key = callKey(exec.name, exec.arguments)
    const own = state.calls.findLast(call => !call.dispatched && call.id === exec.callId && call.key === key
      && state.latest !== null && call.seq > state.latest.seq)
    if (state.calls.some(call => call.key === key && (call.dispatched || own === undefined || call.seq < own.seq))) return DUPLICATE_REASON
  }
  ctx.tools.guard(duplicate)
  ctx.on('tools/execute', (exec, next) => {
    const agent = exec.agent
    if (agent !== undefined) {
      const state = stateOf(agent)
      const key = callKey(exec.name, exec.arguments)
      const logged = state.calls.some(call => !call.dispatched && call.id === exec.callId && call.key === key
        && state.latest !== null && call.seq > state.latest.seq)
      // A dispatch receipt follows the guard, so it cannot identify this execution
      // as its own duplicate. Keep all active-chain receipts across HMR, including
      // calls whose ids are reused by an alternate caller while a body is in flight.
      if (!state.closed && state.turn !== null && (!logged || state.active && !state.manual)) {
        agent.session.append('output-continuation/tool-dispatched', { turn: state.turn, callId: exec.callId, key })
      }
    }
    return next()
  })
}
