import { setImmediate } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { turnBoundaryProjectionDefinition } from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage, markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import type { TurnEndReason, Session } from '@deepseek-ai/dsh-session'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import SessionTitleService, { SessionTitleProviderId } from '../src/index.ts'

function barrier(): { promise: Promise<void>; release(): void } {
  let release!: () => void
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
}

async function setup(): Promise<Context> {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  ctx.sessionProjections.register(turnBoundaryProjectionDefinition)
  await ctx.plugin(SessionTitleService, { fallbackMaxWords: 5, fallbackMaxBytes: 80, maxTitleBytes: 80 })
  ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('done')]))
  return ctx
}

function startStep(ctx: Context, id: string): Session {
  const session = ctx.sessions.create(SessionId(id))
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('user/message', createUserMessage({
    source: { kind: 'user' }, content: [{ type: 'text', text: 'Keep the first request title ordered' }],
  }), { surfaceOp: 'append' })
  return session
}

async function mainRequest(ctx: Context, session: Session): Promise<void> {
  for await (const _chunk of ctx.llm.stream(markAgentLoopRequest(deepFreeze({
    provider: 'mock', model: 'mock', sessionId: session.id, messages: session.deriveMessages(),
  })))) {
    // Exhaust the deterministic adapter so no stream outlives the test.
  }
}

describe('fallback publication at the main request', () => {
  it.each([false, true])('keeps headers before fallback with asynchronous preparation=%s', async (asynchronous) => {
    const ctx = await setup()
    const session = startStep(ctx, `request-order-${String(asynchronous)}`)
    const admitted = barrier()
    const preparation = barrier()
    const run = (async () => {
      admitted.release()
      if (asynchronous) await preparation.promise
      session.append('request/header', { header: { config: { provider: 'mock', model: 'mock' } }, reason: 'initial' })
      session.append('request/context', { provider: 'mock', model: 'mock' })
      await mainRequest(ctx, session)
    })()
    onTestFinished(async () => { preparation.release(); await run })
    await admitted.promise
    if (asynchronous) {
      // Keep preparation blocked through a host-task checkpoint; queued fallback
      // work must not publish simply because preparation yielded.
      await setImmediate()
      expect(ctx.sessionTitle.get(session)).toBeUndefined()
      preparation.release()
    }
    await run
    expect(session.snapshotEvents().filter(event => [
      'user/message', 'request/header', 'request/context', 'session/title',
    ].includes(event.type)).map(event => event.type)).toEqual([
      'user/message', 'request/header', 'request/context', 'session/title',
    ])
    expect(ctx.sessionTitle.get(session)?.source.kind).toBe('fallback')
  })

  it('holds a registered provider through preparation and header-to-context gaps', async () => {
    const ctx = await setup()
    const generated = barrier()
    const requests: string[] = []
    ctx.sessionTitle.register({
      id: SessionTitleProviderId('request-order'), automatic: 'first-prompt',
      async generate(request) {
        requests.push(request.session.id)
        generated.release()
        return { title: 'Provider title', messageSeqs: request.messages.map(message => message.seq) }
      },
    })
    const session = startStep(ctx, 'provider-request-order')
    await setImmediate()
    expect(requests).toEqual([])
    expect(ctx.sessionTitle.get(session)).toBeUndefined()
    session.append('request/header', { header: { config: { provider: 'mock', model: 'mock' } }, reason: 'initial' })
    await setImmediate()
    expect(requests).toEqual([])
    expect(ctx.sessionTitle.get(session)).toBeUndefined()
    const context = session.append('request/context', { provider: 'mock', model: 'mock' })
    await mainRequest(ctx, session)
    await generated.promise
    const fallback = session.snapshotEvents().find(event => event.type === 'session/title' && event.data.source.kind === 'fallback')
    expect(fallback?.seq).toBeGreaterThan(context.seq)
    expect(requests).toEqual([session.id])
  })

  it.each(['error', 'aborted'] as const)('publishes fallback and drops undispatched provider work after %s', async (kind) => {
    const ctx = await setup()
    const requests: string[] = []
    ctx.sessionTitle.register({
      id: SessionTitleProviderId('not-dispatched'), automatic: 'first-prompt',
      async generate(request) {
        requests.push(request.session.id)
        return { title: 'Unexpected provider title', messageSeqs: request.messages.map(message => message.seq) }
      },
    })
    const session = startStep(ctx, `request-${kind}`)
    await setImmediate()
    expect(ctx.sessionTitle.get(session)).toBeUndefined()
    session.append('step/end', { turn: 1, step: 1 })
    const reason: TurnEndReason = kind === 'error'
      ? { kind: 'error', error: { code: 'UNKNOWN', message: 'Request preparation failed' } }
      : { kind: 'aborted', reason: { kind: 'user' } }
    session.append('turn/end', { turn: 1, reason })
    await setImmediate()
    expect(ctx.sessionTitle.get(session)?.source.kind).toBe('fallback')
    session.append('request/header', { header: { config: { provider: 'mock', model: 'mock' } }, reason: 'initial' })
    await setImmediate()
    expect(requests).toEqual([])
  })

  it('keeps asynchronous fallback for human messages outside an active step', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('standalone-title'))
    session.append('user/message', createUserMessage({
      source: { kind: 'user' }, content: [{ type: 'text', text: 'A standalone title still appears' }],
    }), { surfaceOp: 'append' })
    expect(ctx.sessionTitle.get(session)).toBeUndefined()
    await setImmediate()
    expect(ctx.sessionTitle.get(session)?.title).toBe('A standalone title still appears')
  })

  it('keeps the main model request usable when local fallback publication fails', async () => {
    const ctx = await setup()
    const session = startStep(ctx, 'failed-local-title')
    session.append('request/header', { header: { config: { provider: 'mock', model: 'mock' } }, reason: 'initial' })
    session.append('request/context', { provider: 'mock', model: 'mock' })
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    const get = vi.spyOn(ctx.sessionTitle, 'get').mockImplementationOnce(() => { throw new Error('Local title read failed') })
    onTestFinished(() => { warn.mockRestore(); get.mockRestore() })
    await mainRequest(ctx, session)
    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0]?.[0]).toContain('fallback title update failed')
  })
})
