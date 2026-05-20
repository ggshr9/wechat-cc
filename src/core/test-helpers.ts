import type { AgentEvent, AgentSession } from './agent-provider'

export interface MakeFakeSessionOpts {
  /** Static event list — used if `getEventsForTurn` isn't provided. */
  events?: AgentEvent[]
  /** Per-turn event list — called once per `dispatch()`. Overrides `events`. */
  getEventsForTurn?: () => AgentEvent[]
  /** Optional spy invoked with each dispatched text. */
  onDispatch?: (text: string) => void
  /** Optional spy invoked when `cancel()` is called. */
  onCancel?: () => void
}

export function makeFakeSession(opts: MakeFakeSessionOpts): AgentSession {
  let closed = false
  return {
    dispatch(text: string): AsyncIterable<AgentEvent> {
      if (closed) {
        return { async *[Symbol.asyncIterator]() {} }
      }
      opts.onDispatch?.(text)
      const events = opts.getEventsForTurn ? opts.getEventsForTurn() : (opts.events ?? [])
      return {
        async *[Symbol.asyncIterator]() {
          for (const ev of events) yield ev
        },
      }
    },
    async cancel() { opts.onCancel?.() },
    async close() { closed = true },
  }
}
