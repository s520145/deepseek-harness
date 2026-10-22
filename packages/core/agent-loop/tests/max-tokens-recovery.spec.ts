import { describe, expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage, expandAssistantStream, ToolCallId, type ContextFormed, type MessageId, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { MockAdapter, maxTokensResponse, textResponse, toolCallResponse } from './mock-adapter.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'max-tokens-recovery-test': { kind: 'max-tokens-recovery-test' } & ContextFormed
  }
}

async function harness(script: ConstructorParameters<typeof MockAdapter>[0]) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new MockAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await ctx.agentLoop.create(SessionId('max-tokens-recovery'), { provider: 'mock', model: 'mock' })
  return { ctx, adapter, agent }
}

function latestTruncated(agent: Agent, turn: number): SessionEvent<'assistant/message'> {
  const event = agent.session.snapshotEvents().findLast(event => event.type === 'assistant/message'
    && event.data.turn === turn && expandAssistantStream(event.data.stream)
    .some(member => member.chunk.type === 'finish' && member.chunk.reason.kind === 'max-tokens'))
  if (event?.type !== 'assistant/message') throw new Error('fixture expected a truncated Assistant')
  return event
}

function installRecovery(ctx: Context, agent: Agent, {
  attempts = 1,
  reference = (latest: SessionSeq, _triggers: readonly SessionSeq[]) => latest,
}: { attempts?: number; reference?: (latest: SessionSeq, triggers: readonly SessionSeq[]) => SessionSeq } = {}) {
  const markers = new Map<MessageId, SessionSeq>()
  const triggers: SessionSeq[] = []
  ctx.on('agent/turn-stopping', ({ agent: subject, turn, signal }) => {
    if (subject !== agent || signal.aborted || triggers.length >= attempts) return
    const latest = latestTruncated(agent, turn)
    triggers.push(latest.seq)
    const message = createUserMessage({ content: [{ type: 'text', text: 'continue the unfinished task' }],
      source: { kind: 'max-tokens-recovery-test' } })
    markers.set(message.id, reference(latest.seq, triggers))
    agent.inject(message)
  })
  ctx.on('agent/pre-step', async ({ agent: subject }, next) => {
    const decision = await next()
    if (subject !== agent || decision.kind !== 'enter') return decision
    for (const message of decision.messages) {
      const seq = markers.get(message.id)
      if (seq !== undefined) return { ...decision, resumesAfterMaxTokens: seq }
    }
    return decision
  })
  return triggers
}

async function send(agent: Agent) {
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'finish the task' }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

function endings(agent: Agent) {
  return agent.session.snapshotEvents().flatMap(event => event.type === 'turn/end' ? [event.data.reason] : [])
}

describe('explicit max-token recovery admission', () => {
  it('completes after the acknowledged truncation and preserves its original stream', async () => {
    const { ctx, agent, adapter } = await harness([maxTokensResponse('first half'), textResponse('second half')])
    const triggers = installRecovery(ctx, agent)
    await send(agent)
    expect(adapter.requests).toHaveLength(2)
    expect(endings(agent)).toEqual([{ kind: 'completed' }])
    expect(latestTruncated(agent, 1).seq).toBe(triggers[0])
    expect(agent.session.deriveMessages().flatMap(message => message.content)
      .filter(block => block.type === 'text').map(block => block.text)).toContain('first half')
  })

  it('continues through a normal tool step without dispatching the truncated tool', async () => {
    const truncated: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 0, id: ToolCallId('old-call'),
        name: 'probe', argumentsDelta: '{"value":' },
      { type: 'finish', reason: { kind: 'max-tokens' } },
    ]
    const { ctx, agent, adapter } = await harness([truncated,
      toolCallResponse('new-call', 'probe', { value: 'once' }), textResponse('done')])
    const executions: string[] = []
    ctx.tools.register(defineContentToolFixture({ name: 'probe', description: '',
      parameters: { value: { type: 'string' } }, async execute(_args, exec) {
        executions.push(exec.callId)
        return [{ type: 'text', text: 'recorded once' }]
      } }))
    installRecovery(ctx, agent)
    await send(agent)
    expect(adapter.requests).toHaveLength(3)
    expect(executions).toEqual(['new-call'])
    expect(endings(agent)).toEqual([{ kind: 'completed' }])
    expect(latestTruncated(agent, 1).data.message.content).toEqual([])
  })

  it('keeps a renewed limit sticky when a later decision cites the older truncation', async () => {
    const { ctx, agent, adapter } = await harness([
      maxTokensResponse('first'), maxTokensResponse('second'), textResponse('last'),
    ])
    let first: SessionSeq | undefined
    installRecovery(ctx, agent, { attempts: 2, reference: latest => first ??= latest })
    await send(agent)
    expect(adapter.requests).toHaveLength(3)
    expect(endings(agent)).toEqual([{ kind: 'max-tokens' }])
    expect(latestTruncated(agent, 1).data.step).toBe(2)
  })

  it('does not clear a limit for a sequence that never identified its Assistant', async () => {
    const { ctx, agent } = await harness([maxTokensResponse('first'), textResponse('later')])
    installRecovery(ctx, agent, { reference: () => SessionSeq(999999) })
    await send(agent)
    expect(endings(agent)).toEqual([{ kind: 'max-tokens' }])
  })

  it('does not accept a truncation reference from another turn', async () => {
    const { ctx, agent, adapter } = await harness([
      maxTokensResponse('old turn'), maxTokensResponse('current turn'), textResponse('later'),
    ])
    await send(agent)
    const old = latestTruncated(agent, 1).seq
    installRecovery(ctx, agent, { reference: () => old })
    await send(agent)
    expect(adapter.requests).toHaveLength(3)
    expect(endings(agent)).toEqual([{ kind: 'max-tokens' }, { kind: 'max-tokens' }])
  })

  it('does not acknowledge a recovery decision whose message batch becomes empty', async () => {
    const { ctx, agent, adapter } = await harness([maxTokensResponse('first')])
    installRecovery(ctx, agent)
    ctx.on('agent/pre-step', async ({ step }, next) => {
      const decision = await next()
      return step === 2 && decision.kind === 'enter' ? { ...decision, messages: [] } : decision
    }, { prepend: true })
    await send(agent)
    expect(adapter.requests).toHaveLength(1)
    expect(endings(agent)).toEqual([{ kind: 'max-tokens' }])
  })

  it('keeps a recovery error as the real turn outcome', async () => {
    const failure: StreamChunk[] = [{ type: 'finish',
      reason: { kind: 'error', failure: { code: 'SERVER', message: 'fixture failed' } } }]
    const { ctx, agent, adapter } = await harness([maxTokensResponse('first'), failure])
    installRecovery(ctx, agent)
    await send(agent)
    expect(adapter.requests).toHaveLength(2)
    expect(endings(agent)).toEqual([{ kind: 'error', error: { code: 'SERVER', message: 'fixture failed' } }])
    expect(latestTruncated(agent, 1).data.step).toBe(1)
  })

  it('clears the acknowledged limit only after a recovery request retry succeeds', async () => {
    const failure: StreamChunk[] = [{ type: 'finish',
      reason: { kind: 'error', failure: { code: 'SERVER', message: 'retry this fixture' } } }]
    const { ctx, agent, adapter } = await harness([maxTokensResponse('first'), failure, textResponse('done')])
    installRecovery(ctx, agent)
    ctx.on('agent/request-error', () => Promise.resolve({ kind: 'retry' as const }))
    await send(agent)
    expect(adapter.requests).toHaveLength(3)
    expect(endings(agent)).toEqual([{ kind: 'completed' }])
    expect(latestTruncated(agent, 1).data.step).toBe(1)
  })

  it('keeps cancellation during the recovery stream as an aborted turn', async () => {
    const { ctx, agent, adapter } = await harness([
      maxTokensResponse('first'), { hangAfter: textResponse('partial').slice(0, 2) },
    ])
    installRecovery(ctx, agent)
    ctx.on('agent/assistant-stream', ({ frame }) => {
      if (frame.type === 'chunk' && adapter.requests.length === 2 && frame.chunk.type === 'text-delta') {
        agent.cancel({ kind: 'user' })
      }
    })
    await send(agent)
    expect(adapter.requests).toHaveLength(2)
    expect(endings(agent)).toEqual([{ kind: 'aborted', reason: { kind: 'user' } }])
    expect(latestTruncated(agent, 1).data.step).toBe(1)
  })
})
