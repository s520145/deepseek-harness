import { describe, expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { PtcRuntime } from '@deepseek-ai/dsh-ptc-runtime'
import type { PtcRunRequest, PtcRunResult, PtcRunSpec } from '@deepseek-ai/dsh-ptc-runtime'
import * as Guard from '../src/index.ts'
import { callKey, markerOf } from '../src/state.ts'
import { MockAdapter, textResponse, toolCallResponse, maxTokensResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

function user(text = 'work') {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

async function setup(config: Guard.Config = {}, ptc = false) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx, ptc ? { workingDirectory: true, tools: { mode: 'ptc' } } : {})
  await ctx.plugin(AgentLoop, { agents: [] })
  const fiber = await ctx.plugin(Guard, config)
  const executed: unknown[] = []
  ctx.tools.register(defineContentToolFixture({
    name: 'effect', description: 'record a side effect', parameters: {}, isConcurrencySafe: () => true,
    async execute(args) { executed.push(args); return [{ type: 'text', text: 'committed' }] },
  }))
  return { ctx, fiber, executed }
}

async function run(ctx: Context, script: ConstructorParameters<typeof MockAdapter>[0]) {
  const adapter = new MockAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await ctx.agentLoop.create(SessionId('continuation-test'), { provider: 'mock', model: 'mock' })
  agent.followup(user())
  await agent.whenIdle()
  return { adapter, agent }
}

function markers(agent: Agent) {
  return agent.session.snapshotEvents().flatMap(event => event.type === 'user/message' && markerOf(event.data) !== undefined ? [event.data] : [])
}

function endings(agent: Agent) {
  return agent.session.snapshotEvents().flatMap(event => event.type === 'turn/end' ? [event.data.reason.kind] : [])
}

function cappedTools(partial = false): StreamChunk[] {
  const chunks = toolCallResponse('truncated', 'effect', { n: 'not-executed' })
  return [...chunks.filter(chunk => chunk.type !== 'finish' && (!partial || chunk.type !== 'block-end')),
    { type: 'finish', reason: { kind: 'max-tokens' } }]
}

describe('durable bounded output continuation', () => {
  it('advances a long tool turn, never executes capped tools, and ends completed', async () => {
    const { ctx, executed } = await setup()
    const { agent, adapter } = await run(ctx, [
      ...Array.from({ length: 12 }, (_, n) => toolCallResponse(`before-${n}`, 'effect', { n })),
      cappedTools(true), toolCallResponse('after', 'effect', { n: 'after' }), textResponse('finished'),
    ])
    expect(executed).toHaveLength(13)
    expect(executed).not.toContainEqual({ n: 'not-executed' })
    expect(adapter.requests).toHaveLength(15)
    expect(markers(agent).map(message => message.source)).toEqual([expect.objectContaining({ turn: 1, attempt: 1 })])
    expect(endings(agent)).toEqual(['completed'])
    const state = ctx.sessionProjections.stateOf(agent.session, 'outputContinuation')!
    expect(state.markers).toHaveLength(1)
    expect(state.active).toBe(false)
  })

  it('counts two continuations across successful intermediate tool steps', async () => {
    const { ctx } = await setup()
    const { agent, adapter } = await run(ctx, [
      maxTokensResponse('one'), toolCallResponse('middle', 'effect', { n: 1 }),
      maxTokensResponse('two'), toolCallResponse('middle2', 'effect', { n: 2 }), maxTokensResponse('three'),
    ])
    expect(adapter.requests).toHaveLength(5)
    expect(markers(agent).map(message => markerOf(message)?.attempt)).toEqual([1, 2])
    expect(endings(agent)).toEqual(['max-tokens'])
    expect(markers(agent)[1]!.content.map(block => block.type === 'text' ? block.text : '').join('')).toContain('last automatic continuation')
  })

  it('fails closed on full canonical repeats, including reused call ids and uncertain outcomes', async () => {
    const { ctx, executed } = await setup()
    const { agent } = await run(ctx, [
      toolCallResponse('same-id', 'effect', { z: 2, a: { b: 1 } }), maxTokensResponse('cut'),
      toolCallResponse('same-id', 'effect', { a: { b: 1 }, z: 2 }), textResponse('done'),
    ])
    expect(executed).toHaveLength(1)
    const results = agent.session.snapshotEvents().filter(event => event.type === 'tool/result')
    expect(results).toHaveLength(2)
    expect(results[1]!.data.message.isError).toBe(true)
    expect(results[1]!.data.message.content.map(block => block.type === 'text' ? block.text : '').join('')).toContain('No previous success result has been substituted.')
  })

  it('blocks same-batch duplicates without excluding concurrency-safe tools', async () => {
    const { ctx, executed } = await setup()
    const first = toolCallResponse('batch1', 'effect', { n: 1 }).filter(chunk => chunk.type !== 'finish' && chunk.type !== 'usage')
    const second = toolCallResponse('batch2', 'effect', { n: 1 }).map(chunk => 'index' in chunk ? { ...chunk, index: 1 } : chunk)
    const { agent } = await run(ctx, [maxTokensResponse('cut'), [...first, ...second], textResponse('done')])
    expect(executed).toEqual([{ n: 1 }])
    expect(endings(agent)).toEqual(['completed'])
  })

  it.each([false, true])('does not execute tool blocks from a capped response (partial=%s)', async (partial) => {
    const { ctx, executed } = await setup()
    const { agent } = await run(ctx, [cappedTools(partial), textResponse('done')])
    expect(executed).toEqual([])
    expect(markers(agent)).toHaveLength(1)
  })

  it.each(['stop', 'error', '429', 'aborted'])('never continues %s', async (kind) => {
    const { ctx } = await setup()
    const chunks: StreamChunk[] = kind === 'stop' ? textResponse('done') : [{ type: 'finish', reason: kind === 'aborted'
      ? { kind: 'aborted', failure: { message: 'aborted', code: 'ABORTED' } }
      : { kind: 'error', failure: { message: 'failed', code: kind === '429' ? 'RATE_LIMIT' : 'SERVER' } } }]
    const { agent, adapter } = await run(ctx, [chunks])
    expect(markers(agent)).toHaveLength(0)
    expect(adapter.requests).toHaveLength(1)
  })

  it('disables automatic continuation at zero', async () => {
    const { ctx } = await setup({ maxContinuations: 0 })
    const { agent, adapter } = await run(ctx, [maxTokensResponse('cut')])
    expect(markers(agent)).toHaveLength(0)
    expect(adapter.requests).toHaveLength(1)
  })

  it('removes its pending input on cancel with keepInbox and does not revive it after HMR', async () => {
    const { ctx, fiber } = await setup()
    let canceled = false
    ctx.on('agent/turn-stopping', ({ agent }) => {
      if (canceled) return
      canceled = true
      expect(agent.inbox.nextStep.some(message => markerOf(message) !== undefined)).toBe(true)
      agent.cancel({ kind: 'user' }, { keepInbox: true })
    })
    const { agent, adapter } = await run(ctx, [maxTokensResponse('cut')])
    expect(agent.inbox.nextStep).toEqual([])
    await fiber.dispose()
    await ctx.plugin(Guard, {})
    expect(agent.inbox.nextStep).toEqual([])
    expect(ctx.sessionProjections.stateOf(agent.session, 'outputContinuation')?.markers).toHaveLength(1)
    expect(adapter.requests).toHaveLength(1)
  })

  it('lets a queued human take over and permits the same tool on the new input', async () => {
    const { ctx, executed } = await setup()
    let queued = false
    ctx.on('agent/turn-stopping', ({ agent }) => {
      if (queued) return
      queued = true
      agent.followup(user('take over'))
    })
    const { agent, adapter } = await run(ctx, [
      toolCallResponse('before', 'effect', { n: 1 }), maxTokensResponse('cut'),
      toolCallResponse('manual', 'effect', { n: 1 }), textResponse('done'),
    ])
    expect(executed).toEqual([{ n: 1 }, { n: 1 }])
    expect(markers(agent)).toEqual([])
    expect(adapter.requests).toHaveLength(4)
    expect(endings(agent)).toEqual(['max-tokens', 'completed'])
  })

  it('rebuilds pending receipts through HMR without replenishing the budget', async () => {
    const { ctx, fiber } = await setup()
    let current = fiber
    let reloads = 0
    ctx.on('agent/turn-stopping', async ({ agent }) => {
      if (reloads >= 1) return
      reloads++
      const before = ctx.sessionProjections.stateOf(agent.session, 'outputContinuation')!
      const ids = agent.inbox.nextStep.map(message => message.id)
      await current.dispose()
      current = await ctx.plugin(Guard, {})
      expect(ctx.sessionProjections.stateOf(agent.session, 'outputContinuation')).toEqual(before)
      expect(agent.inbox.nextStep.map(message => message.id)).toEqual(ids)
    })
    const { agent, adapter } = await run(ctx, [maxTokensResponse('one'), maxTokensResponse('two'), maxTokensResponse('three')])
    expect(adapter.requests).toHaveLength(3)
    expect(markers(agent).map(message => markerOf(message)?.attempt)).toEqual([1, 2])
  })

  it('rebuilds a closed turn from events and discards stale injected input on remount', async () => {
    const { ctx, fiber } = await setup()
    const { agent } = await run(ctx, [maxTokensResponse('cut'), textResponse('done')])
    const saved = agent.session.snapshotEvents()
    const restored = Session.create(agent.id, saved, agent.session.header)
    expect(ctx.sessionProjections.stateOf(restored, 'outputContinuation')).toEqual(ctx.sessionProjections.stateOf(agent.session, 'outputContinuation'))
    const previous = markers(agent)[0]!
    agent.inject(createUserMessage({ content: previous.content, source: previous.source }))
    expect(agent.inbox.nextStep).toHaveLength(1)
    await fiber.dispose()
    await ctx.plugin(Guard, {})
    expect(agent.inbox.nextStep).toEqual([])
    expect(ctx.sessionProjections.stateOf(agent.session, 'outputContinuation')?.closed).toBe(true)
  })

  it('denies repeated nested PTC calls and same-program siblings before their bodies', async () => {
    const { ctx, executed } = await setup({}, true)
    let programs = 0
    class Runtime extends PtcRuntime {
      readonly language = 'typescript'
      readonly isolation = 'test'
      resolve(request: PtcRunRequest): PtcRunSpec { return { ...request, cwd: process.cwd(), timeoutMs: 1000 } }
      async run(request: PtcRunRequest): Promise<PtcRunResult> {
        const effect = request.bindings[0]!.functions.effect!
        if (++programs === 1) {
          await effect({ n: 1 })
        } else {
          await expect(effect({ n: 1 })).rejects.toThrow('identical tool call')
          const siblings = await Promise.allSettled([effect({ n: 2 }), effect({ n: 2 })])
          expect(siblings.map(result => result.status)).toEqual(['fulfilled', 'rejected'])
        }
        return { logs: [], value: 'done' }
      }
    }
    await ctx.plugin(Runtime)
    const { agent } = await run(ctx, [
      toolCallResponse('program1', 'run_code', { code: 'first', description: 'initial operation' }),
      maxTokensResponse('cut'),
      toolCallResponse('program2', 'run_code', { code: 'second', description: 'continued operation' }), textResponse('done'),
    ])
    expect(programs).toBe(2)
    expect(executed).toEqual([{ n: 1 }, { n: 2 }])
    const nested = agent.session.snapshotEvents().filter(event => event.type === 'tool/ptc-dispatch')
    expect(nested).toHaveLength(4)
    expect(nested.map(event => event.data.isError)).toEqual([false, true, false, true])
    expect(endings(agent)).toEqual(['completed'])
  })

  it('protects direct executor calls even when a caller reuses a call id', async () => {
    const { ctx, executed } = await setup()
    let checked = false
    ctx.on('agent/turn-stopping', async ({ agent, signal }) => {
      if (checked || ctx.sessionProjections.stateOf(agent.session, 'outputContinuation')?.active !== true) return
      checked = true
      const input = { callId: ToolCallId('reused-direct-id'), name: 'effect', arguments: { direct: true }, agent, signal }
      expect((await ctx.tools.execute(input)).isError).toBe(false)
      expect((await ctx.tools.execute(input)).isError).toBe(true)
    })
    await run(ctx, [maxTokensResponse('one'), maxTokensResponse('two'), textResponse('done')])
    expect(checked).toBe(true)
    expect(executed).toEqual([{ direct: true }])
  })

  it('persists a direct dispatch before the first cap and blocks its replay after HMR', async () => {
    const { ctx, executed, fiber } = await setup()
    let current = fiber
    let first = true
    ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
      if (first) {
        first = false
        expect((await ctx.tools.execute({ callId: ToolCallId('pre-cap-direct'), name: 'effect', arguments: { direct: true }, agent, signal })).isError).toBe(false)
      }
      return next()
    })
    let reloaded = false
    ctx.on('agent/turn-stopping', async () => {
      if (reloaded) return
      reloaded = true
      await current.dispose()
      current = await ctx.plugin(Guard, {})
    })
    const { agent } = await run(ctx, [maxTokensResponse('cut'), toolCallResponse('pre-cap-direct', 'effect', { direct: true }), textResponse('done')])
    expect(executed).toEqual([{ direct: true }])
    const records = agent.session.snapshotEvents().filter(event => event.type === 'output-continuation/tool-dispatched')
    expect(records).toHaveLength(1)
    expect(records[0]!.data).toEqual({ turn: 1, callId: 'pre-cap-direct', key: callKey('effect', { direct: true }) })
    expect(records[0]!.ignorable).toBeUndefined()
    expect(endings(agent)).toEqual(['completed'])
  })

  it('cannot mistake a reused old native call id for a current direct execution', async () => {
    const { ctx, executed } = await setup()
    let checked = false
    ctx.on('agent/turn-stopping', async ({ agent, signal }) => {
      if (checked || ctx.sessionProjections.stateOf(agent.session, 'outputContinuation')?.active !== true) return
      checked = true
      const result = await ctx.tools.execute({ callId: ToolCallId('native-before-cap'), name: 'effect', arguments: { n: 1 }, agent, signal })
      expect(result.isError).toBe(true)
    })
    await run(ctx, [toolCallResponse('native-before-cap', 'effect', { n: 1 }), maxTokensResponse('one'), maxTokensResponse('two'), textResponse('done')])
    expect(checked).toBe(true)
    expect(executed).toEqual([{ n: 1 }])
  })

  it('keeps in-flight native dispatch protection across HMR despite a reused current-step id', async () => {
    const { ctx, fiber } = await setup()
    const started = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    let sideEffects = 0
    ctx.tools.register(defineContentToolFixture({
      name: 'inflight', description: 'controlled operation', parameters: {},
      async execute() { sideEffects++; started.resolve(undefined); await release.promise; return [{ type: 'text', text: 'committed' }] },
    }))
    const adapter = new MockAdapter([maxTokensResponse('cut'), toolCallResponse('in-flight-id', 'inflight', { n: 1 }), textResponse('done')])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('in-flight'), { provider: 'mock', model: 'mock' })
    agent.followup(user())
    await started.promise
    try {
      await fiber.dispose()
      await ctx.plugin(Guard, {})
      const result = await ctx.tools.execute({ callId: ToolCallId('in-flight-id'), name: 'inflight', arguments: { n: 1 }, agent, signal: new AbortController().signal })
      expect(result.isError).toBe(true)
      expect(sideEffects).toBe(1)
    } finally { release.resolve(undefined) }
    await agent.whenIdle()
    expect(endings(agent)).toEqual(['completed'])
    const records = agent.session.snapshotEvents().filter(event => event.type === 'output-continuation/tool-dispatched')
    expect(records).toHaveLength(1)
  })

  it('does not retry an operation that threw after changing external state', async () => {
    const { ctx } = await setup()
    let sideEffects = 0
    ctx.tools.register(defineContentToolFixture({
      name: 'uncertain', description: 'uncertain completion', parameters: {},
      async execute() { sideEffects++; throw new Error('outcome uncertain') },
    }))
    const { agent } = await run(ctx, [
      toolCallResponse('uncertain1', 'uncertain', {}), maxTokensResponse('cut'),
      toolCallResponse('uncertain2', 'uncertain', {}), textResponse('done'),
    ])
    expect(sideEffects).toBe(1)
    expect(endings(agent)).toEqual(['completed'])
  })

  it('unregisters its guard and projection when the plugin is disposed', async () => {
    const { ctx, fiber } = await setup()
    const { agent } = await run(ctx, [maxTokensResponse('one'), textResponse('done')])
    await fiber.dispose()
    expect(ctx.sessionProjections.stateOf(agent.session, 'outputContinuation')).toBeUndefined()
    const result = await ctx.tools.execute({ callId: ToolCallId('direct'), name: 'effect', arguments: {}, agent, signal: new AbortController().signal })
    expect(result.isError).toBe(false)
  })

  it.each([-1, 11, 1.5, NaN, Infinity])('rejects invalid budget %s', async (maxContinuations) => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await mountAgentLoopTestDependencies(ctx)
    await expect(ctx.plugin(Guard, { maxContinuations })).rejects.toThrow()
  })

  it('compares entire deep JSON, preserving array order and values', () => {
    expect(callKey('x', { b: [1, 2], a: { y: 2, x: 1 } })).toBe(callKey('x', { a: { x: 1, y: 2 }, b: [1, 2] }))
    expect(callKey('x', { a: [1, 2] })).not.toBe(callKey('x', { a: [2, 1] }))
  })
})
