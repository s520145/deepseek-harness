/** Incremental durable receipts and tool-attempt identities for the current turn. */
import { z } from 'zod'
import { createHash } from 'node:crypto'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { ContinuationMarker, ContinuationState } from './types.ts'

/**
 * Read this producer's structurally valid ownership marker.
 * @param message - Durable input whose source identifies its producer.
 * @returns The valid continuation marker, or undefined for other or malformed sources.
 */
export function markerOf(message: UserMessage): ContinuationMarker | undefined {
  const source = message.source
  if (source.kind !== 'output-continuation') return
  if (!Number.isSafeInteger(source.turn) || source.turn < 1
    || !Number.isSafeInteger(source.triggerAssistantSeq) || source.triggerAssistantSeq < 0
    || !Number.isSafeInteger(source.attempt) || source.attempt < 1 || source.attempt > 10) return
  return source
}

function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered((value as Record<string, unknown>)[key])]))
  }
  return value
}

/**
 * Hash the tool name and complete canonical JSON arguments.
 * @param name - Resolved tool name.
 * @param args - Complete tool arguments.
 * @returns SHA-256 identity digest, independent of object key order.
 */
export function callKey(name: string, args: unknown): string {
  return createHash('sha256').update(JSON.stringify([name, ordered(args)])).digest('hex')
}

function parseArguments(raw: string): unknown {
  try { return raw === '' ? {} : JSON.parse(raw) }
  catch (error: unknown) {
    // Native execution preserves malformed argument JSON as a string too.
    if (error instanceof SyntaxError) return raw
    throw error
  }
}

function empty(turn: number | null = null): ContinuationState {
  return { turn, closed: turn === null, active: false, manual: false, latest: null, markers: [], calls: [] }
}

function observeMessage(state: ContinuationState, message: UserMessage, admitted: boolean): ContinuationState {
  const marker = markerOf(message)
  if (marker?.turn === state.turn && !state.closed) {
    const known = state.markers.some(item => item.id === message.id)
    return {
      ...state,
      active: state.active || admitted && !state.manual,
      markers: known ? state.markers : [...state.markers, {
        id: message.id, triggerAssistantSeq: marker.triggerAssistantSeq, attempt: marker.attempt,
      }],
    }
  }
  if (message.source.kind === 'user' && (state.markers.length > 0 || state.latest !== null)) {
    return { ...state, manual: true, active: false }
  }
  return state
}

const seqSchema = z.number().int().nonnegative().transform(SessionSeq)
const schema: z.ZodType<ContinuationState> = z.object({
  turn: z.number().int().positive().nullable(),
  closed: z.boolean(), active: z.boolean(), manual: z.boolean(),
  latest: z.object({ seq: seqSchema, finish: z.string() }).nullable(),
  markers: z.array(z.object({ id: z.string(), triggerAssistantSeq: seqSchema, attempt: z.number().int().min(1).max(10) })),
  calls: z.array(z.object({ id: z.string(), key: z.string(), seq: seqSchema, dispatched: z.boolean() })),
})

/** Host-only fold; HMR and resume rebuild from the same durable inbox/message receipts. */
export const continuationProjection = {
  key: 'outputContinuation',
  stateVersion: 3,
  stateSchema: schema,
  init: () => empty(),
  apply(state, event) {
    switch (event.type) {
      case 'turn/start': return empty(event.data.turn)
      case 'turn/end': return event.data.turn === state.turn ? { ...state, closed: true, active: false } : state
      case 'agent/inbox/spliced': {
        if (state.closed) return state
        return event.data.inserted.reduce((current, message) => observeMessage(current, message, false), state)
      }
      case 'user/message': return state.closed ? state : observeMessage(state, event.data, true)
      case 'assistant/message': {
        if (state.closed || event.data.turn !== state.turn) return state
        const finish = event.data.stream.findLast(record => record.type === 'chunk' && record.chunk.type === 'finish')
        return { ...state, latest: {
          seq: event.seq,
          finish: finish?.type === 'chunk' && finish.chunk.type === 'finish' ? finish.chunk.reason.kind : 'missing',
        } }
      }
      case 'assistant/attempt':
        return event.data.turn === state.turn ? { ...state, latest: { seq: event.seq, finish: 'attempt' } } : state
      case 'tool/call':
        return state.closed || event.data.turn !== state.turn ? state : { ...state, calls: [...state.calls, {
          id: event.data.callId, key: callKey(event.data.name, parseArguments(event.data.arguments)), seq: event.seq, dispatched: false,
        }] }
      case 'tool/ptc-dispatch-start':
        return state.closed ? state : { ...state, calls: [...state.calls, {
          id: event.data.subCallId, key: callKey(event.data.name, event.data.arguments), seq: event.seq, dispatched: false,
        }] }
      case 'output-continuation/tool-dispatched':
        return state.closed || event.data.turn !== state.turn ? state : { ...state, calls: [...state.calls, {
          id: event.data.callId, key: event.data.key, seq: event.seq, dispatched: true,
        }] }
      default: return state
    }
  },
} satisfies ProjectionDefinition<'outputContinuation', ContinuationState>
