import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { MockAdapter, maxTokensResponse, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as continuation from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function loadYaml(): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-output-continuation-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    ...['llm', 'session', 'session-projection', 'system-prompt', 'tools', 'agent', 'output-continuation', 'agent-loop']
      .map(name => `- name: 'cordis:${name}'`),
    '',
  ].join('\n'))
  context = new Context()
  context.baseUrl = `${pathToFileURL(root).href}/`
  await context.plugin(Loader)
  Object.assign(context.loader.builtins, {
    include: Include,
    llm: LlmRuntime,
    session: SessionStore,
    'session-projection': SessionProjectionRegistry,
    'system-prompt': SystemPrompt,
    tools: ToolRuntime,
    agent: AgentRegistry,
    'output-continuation': continuation,
    'agent-loop': AgentLoop,
  })
  await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await context.loader.await()
  expect([...context.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)).toEqual([])
  return context
}

function truncatedTool(): StreamChunk[] {
  return [
    ...maxTokensResponse('The next operation was cut off.').slice(0, -1),
    { type: 'block-start', index: 1, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 1, id: ToolCallId('partial'), name: 'record', argumentsDelta: '{"value":' },
    { type: 'finish', reason: { kind: 'max-tokens' } },
  ]
}

describe('real Loader output continuation composition', () => {
  it('continues a long tool turn without rerunning completed or partial operations', { timeout: 60_000 }, async () => {
    const loaded = await loadYaml()
    const physical: number[] = []
    loaded.tools.register(defineContentToolFixture({
      name: 'record', description: 'Record a work item once.', parameters: { value: { type: 'integer', required: true } },
      async execute({ value }) { physical.push(value); return [{ type: 'text', text: `Recorded ${value}` }] },
    }))
    const adapter = new MockAdapter([
      ...Array.from({ length: 12 }, (_, value) => toolCallResponse(`before-${value}`, 'record', { value })),
      truncatedTool(),
      toolCallResponse('duplicate', 'record', { value: 0 }),
      toolCallResponse('after', 'record', { value: 12 }),
      maxTokensResponse('More work remains.'),
      textResponse('LONG_TASK_COMPLETED'),
    ])
    loaded.llm.registerAdapter(['mock'], adapter)
    const agent = await loaded.agentLoop.create(SessionId('loader-output-continuation'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Complete the long task.' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    const events = agent.session.snapshotEvents()
    expect(events.filter(event => event.type === 'turn/end')).toMatchObject([{ data: { reason: { kind: 'completed' } } }])
    expect(physical).toEqual(Array.from({ length: 13 }, (_, value) => value))
    expect(events.filter(event => event.type === 'tool/call' && event.data.callId === 'partial')).toHaveLength(0)
    const rejected = events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === 'duplicate')
    if (rejected?.type !== 'tool/result') throw new Error('Missing rejected duplicate result')
    expect(rejected.data.message.isError).toBe(true)
    const rejection = rejected.data.message.content[0]
    if (rejection?.type !== 'text') throw new Error('Missing duplicate rejection text')
    expect(rejection.text).toContain('Automatic continuation blocked an identical tool call')
    expect(events.flatMap(event => event.type === 'user/message' && event.data.source.kind === 'output-continuation'
      ? [event.data.source.attempt] : [])).toEqual([1, 2])
    expect(events.filter(event => event.type === 'assistant/message' && event.data.stream.some(record => record.type === 'chunk' && record.chunk.type === 'finish' && record.chunk.reason.kind === 'max-tokens'))).toHaveLength(2)
    expect(agent.session.deriveMessages().at(-1)).toMatchObject({ content: [{ type: 'text', text: 'LONG_TASK_COMPLETED' }] })
    expect(adapter.requests).toHaveLength(17)
  })

  it('stops after two continuations even when every response reaches the limit', { timeout: 60_000 }, async () => {
    const loaded = await loadYaml()
    const adapter = new MockAdapter([maxTokensResponse('one'), maxTokensResponse('two'), maxTokensResponse('three'), textResponse('must not run')])
    loaded.llm.registerAdapter(['mock'], adapter)
    const agent = await loaded.agentLoop.create(SessionId('loader-output-limit'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Complete the task.' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(3)
    const events = agent.session.snapshotEvents()
    expect(events.filter(event => event.type === 'user/message' && event.data.source.kind === 'output-continuation')).toHaveLength(2)
    expect(events.filter(event => event.type === 'turn/end')).toMatchObject([{ data: { reason: { kind: 'max-tokens' } } }])
    expect(agent.inbox.nextStep).toHaveLength(0)
    expect(agent.inbox.nextTurn).toHaveLength(0)
  })
})
