/** Keyless, fixed-work comparison. Run with node --expose-gc --import tsx this-file.ts. */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import * as Guard from '../src/index.ts'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

const steps = 120
const argumentBytes = 16_384
const gc = (): void => { globalThis.gc?.() }

async function measure(enabled: boolean) {
  const ctx = new Context()
  try {
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    if (enabled) await ctx.plugin(Guard, {})
    let bodies = 0
    ctx.tools.register(defineContentToolFixture({
      name: 'effect', description: 'fixed inert workload', parameters: {},
      async execute() { bodies++; return [{ type: 'text', text: 'ok' }] },
    }))
    const payload = 'x'.repeat(argumentBytes)
    const adapter = new MockAdapter([
      ...Array.from({ length: steps }, (_, n) => toolCallResponse(`call-${n}`, 'effect', { n, payload })),
      textResponse('complete'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('performance'), { provider: 'mock', model: 'mock' })
    gc()
    const baselineHeap = process.memoryUsage().heapUsed
    let observedPeakHeap = baselineHeap
    ctx.on('session/event', () => { observedPeakHeap = Math.max(observedPeakHeap, process.memoryUsage().heapUsed) })
    const start = performance.now()
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'run fixed inert workload' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    const wallMs = performance.now() - start
    observedPeakHeap = Math.max(observedPeakHeap, process.memoryUsage().heapUsed)
    gc()
    const steadyHeap = process.memoryUsage().heapUsed
    const ending = agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')
    if (bodies !== steps || adapter.requests.length !== steps + 1 || ending?.data.reason.kind !== 'completed') throw new Error('fixed workload did not complete')
    return {
      enabled, steps, argumentBytes, requests: adapter.requests.length, bodies,
      wallMs, baselineHeap, observedPeakHeap, steadyHeap,
      retainedHeapDelta: steadyHeap - baselineHeap,
      processPeakRssBytes: process.resourceUsage().maxRSS * 1024,
      projectionCallCount: ctx.sessionProjections.stateOf(agent.session, 'outputContinuation')?.calls.length ?? 0,
    }
  } finally { await ctx.fiber.dispose() }
}

async function main(): Promise<void> {
  if (process.argv[2] === '--case') {
    process.stdout.write(`${JSON.stringify(await measure(process.argv[3] === 'enabled'))}\n`)
    return
  }
  const samples = []
  for (let repeat = 0; repeat < 3; repeat++) {
    for (const mode of ['disabled', 'enabled']) {
      const child = spawnSync(process.execPath, ['--expose-gc', '--import', 'tsx', fileURLToPath(import.meta.url), '--case', mode], {
        cwd: process.cwd(), encoding: 'utf8', env: process.env,
      })
      if (child.status !== 0) throw new Error(child.stderr || `performance child exited ${child.status}`)
      samples.push(JSON.parse(child.stdout))
    }
  }
  process.stdout.write(`${JSON.stringify({
    measuredAt: new Date().toISOString(), node: process.version, platform: `${process.platform}/${process.arch}`,
    sourceHashes: Object.fromEntries(['index.ts', 'state.ts', 'types.ts'].map(file => [file, createHash('sha256').update(readFileSync(new URL(`../src/${file}`, import.meta.url))).digest('hex')])),
    method: 'Separate fresh processes, alternating disabled/enabled; identical 120-step inert tool turns, 16 KiB full arguments, no truncation or network. Heap sampled after each committed event; steady heap follows explicit GC with the finished Agent retained. RSS is process lifetime high-water mark, including imports and setup. No warm-up; inspect all samples rather than treating the median as a benchmark guarantee.',
    samples,
  }, null, 2)}\n`)
}

main().catch((error: unknown) => { process.stderr.write(`${String(error)}\n`); process.exitCode = 1 })
