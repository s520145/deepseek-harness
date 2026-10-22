import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import type { SessionSeq } from '@deepseek-ai/dsh-session'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'

/** Durable ownership and budget receipt for one automatic next-step input. */
export interface ContinuationMarker {
  kind: 'output-continuation'
  turn: number
  triggerAssistantSeq: SessionSeq
  attempt: number
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'output-continuation': ContinuationMarker & ContextFormed
  }
}

/** Current-turn facts reconstructed from committed events, including removed receipts. */
export interface ContinuationState {
  turn: number | null
  closed: boolean
  active: boolean
  manual: boolean
  latest: { seq: SessionSeq; finish: string } | null
  markers: { id: string; triggerAssistantSeq: SessionSeq; attempt: number }[]
  calls: { id: string; key: string; seq: SessionSeq; dispatched: boolean }[]
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Durable digest committed before a body may run: all automatic-chain dispatches and otherwise unlogged direct calls. */
    'output-continuation/tool-dispatched': { turn: number; callId: ToolCallId; key: string }
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    outputContinuation: ContinuationState
  }
}
