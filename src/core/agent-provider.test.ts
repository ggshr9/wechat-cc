import { describe, it, expect } from 'vitest'
import {
  collectTurn,
  isReplyToolCall,
  type AgentEvent,
} from './agent-provider'

async function* events(...e: AgentEvent[]): AsyncIterable<AgentEvent> {
  for (const ev of e) yield ev
}

/**
 * Yields the given events, then hangs forever (never emits a result and
 * never closes) — models the Claude SDK subprocess going silent mid-turn
 * (idle-timeout / wedge). `returned` flips true when the consumer breaks
 * out of the loop and the generator's `return()` runs, so a test can
 * assert the watchdog actually stopped consuming.
 */
function hangingEvents(emit: AgentEvent[]): { stream: AsyncIterable<AgentEvent>; returned: () => boolean } {
  // Hand-rolled to mirror the real provider's AsyncQueue iterator: `next()`
  // hangs once the buffered events drain (the SDK went silent), but
  // `return()` resolves immediately and flips a flag (the queue closes). A
  // native `async *` generator stuck on `await` can't model this — its
  // `return()` never completes.
  let returned = false
  const buf = [...emit]
  const it: AsyncIterator<AgentEvent> = {
    next() {
      if (buf.length > 0) return Promise.resolve({ value: buf.shift()!, done: false })
      return new Promise<IteratorResult<AgentEvent>>(() => {}) // hang
    },
    return() { returned = true; return Promise.resolve({ value: undefined, done: true }) },
  }
  return { stream: { [Symbol.asyncIterator]: () => it }, returned: () => returned }
}

describe('isReplyToolCall', () => {
  it('matches wechat reply tools', () => {
    expect(isReplyToolCall({ kind: 'tool_call', server: 'wechat', tool: 'reply' })).toBe(true)
    expect(isReplyToolCall({ kind: 'tool_call', server: 'wechat', tool: 'reply_voice' })).toBe(true)
    expect(isReplyToolCall({ kind: 'tool_call', server: 'wechat', tool: 'send_file' })).toBe(true)
    expect(isReplyToolCall({ kind: 'tool_call', server: 'wechat', tool: 'edit_message' })).toBe(true)
    expect(isReplyToolCall({ kind: 'tool_call', server: 'wechat', tool: 'broadcast' })).toBe(true)
  })
  it('rejects non-wechat servers', () => {
    expect(isReplyToolCall({ kind: 'tool_call', server: 'other', tool: 'reply' })).toBe(false)
  })
  it('rejects non-reply tools on wechat server', () => {
    expect(isReplyToolCall({ kind: 'tool_call', server: 'wechat', tool: 'memory_read' })).toBe(false)
  })
  it('rejects events with no server field (built-in tools)', () => {
    expect(isReplyToolCall({ kind: 'tool_call', tool: 'Read' })).toBe(false)
  })
  it('returns false for non-tool-call events', () => {
    expect(isReplyToolCall({ kind: 'text', text: 'hi' })).toBe(false)
    expect(isReplyToolCall({ kind: 'init', sessionId: 's1' })).toBe(false)
    expect(isReplyToolCall({ kind: 'result', sessionId: 's1', numTurns: 1, durationMs: 100 })).toBe(false)
    expect(isReplyToolCall({ kind: 'error', message: 'boom' })).toBe(false)
  })
})

describe('collectTurn', () => {
  it('accumulates text events', async () => {
    const summary = await collectTurn(events(
      { kind: 'text', text: 'hello' },
      { kind: 'text', text: 'world' },
    ))
    expect(summary.assistantText).toEqual(['hello', 'world'])
    expect(summary.replyToolCalled).toBe(false)
    expect(summary.result).toBeUndefined()
    expect(summary.error).toBeUndefined()
  })

  it('flags reply tool calls', async () => {
    const summary = await collectTurn(events(
      { kind: 'tool_call', server: 'wechat', tool: 'reply' },
    ))
    expect(summary.replyToolCalled).toBe(true)
  })

  it('does not flag non-reply tool calls', async () => {
    const summary = await collectTurn(events(
      { kind: 'tool_call', server: 'wechat', tool: 'memory_read' },
      { kind: 'tool_call', tool: 'Read' },
    ))
    expect(summary.replyToolCalled).toBe(false)
  })

  it('captures result event', async () => {
    const summary = await collectTurn(events(
      { kind: 'init', sessionId: 's1' },
      { kind: 'text', text: 'hi' },
      { kind: 'result', sessionId: 's1', numTurns: 1, durationMs: 250 },
    ))
    expect(summary.result).toEqual({ sessionId: 's1', numTurns: 1, durationMs: 250 })
    expect(summary.assistantText).toEqual(['hi'])
  })

  it('captures error events', async () => {
    const summary = await collectTurn(events(
      { kind: 'text', text: 'partial' },
      { kind: 'error', message: 'turn failed' },
    ))
    expect(summary.error).toBe('turn failed')
    expect(summary.assistantText).toEqual(['partial'])
  })

  it('handles empty iterable', async () => {
    const summary = await collectTurn(events())
    expect(summary).toEqual({ assistantText: [], replyToolCalled: false, result: undefined, error: undefined })
  })

  it('returns a turn_timeout summary when the stream stalls past timeoutMs (does not hang)', async () => {
    const { stream, returned } = hangingEvents([{ kind: 'text', text: 'partial' }])
    const summary = await collectTurn(stream, { timeoutMs: 30 })
    expect(summary.errorCode).toBe('turn_timeout')
    expect(summary.error).toMatch(/timed out/i)
    // Partial text seen before the stall is preserved for diagnostics.
    expect(summary.assistantText).toEqual(['partial'])
    expect(summary.result).toBeUndefined()
    // The watchdog stopped consuming the wedged stream (generator return ran).
    expect(returned()).toBe(true)
  }, 2000)

  it('returns normally (no timeout) when the stream completes before timeoutMs', async () => {
    const summary = await collectTurn(events(
      { kind: 'text', text: 'hi' },
      { kind: 'result', sessionId: 's1', numTurns: 1, durationMs: 5 },
    ), { timeoutMs: 1000 })
    expect(summary.errorCode).toBeUndefined()
    expect(summary.assistantText).toEqual(['hi'])
    expect(summary.result).toEqual({ sessionId: 's1', numTurns: 1, durationMs: 5 })
  })
})

describe('ProviderCapabilities — per-provider self-declarations (RFC 05 Phase 2)', () => {
  it('CLAUDE_CAPABILITIES has the four expected fields', async () => {
    const { CLAUDE_CAPABILITIES } = await import('./claude-agent-provider')
    expect(CLAUDE_CAPABILITIES.perToolCallback).toBe(true)
    expect(CLAUDE_CAPABILITIES.supportsDelegation).toBe(true)
    expect(CLAUDE_CAPABILITIES.supportsResume).toBe(true)
    expect(CLAUDE_CAPABILITIES.sandboxLevels).toBeInstanceOf(Set)
  })

  it('CODEX_CAPABILITIES has the four expected fields', async () => {
    const { CODEX_CAPABILITIES } = await import('./codex-agent-provider')
    // codex SDK has no per-tool callback — that's the whole reason
    // tier→sandbox translation is coarse-grained for codex.
    expect(CODEX_CAPABILITIES.perToolCallback).toBe(false)
    expect(CODEX_CAPABILITIES.supportsDelegation).toBe(true)
    expect(CODEX_CAPABILITIES.supportsResume).toBe(true)
  })

  it('CURSOR_CAPABILITIES has the four expected fields', async () => {
    const { CURSOR_CAPABILITIES } = await import('./cursor-agent-provider')
    expect(CURSOR_CAPABILITIES.perToolCallback).toBe(false)
    // cursor SDK doesn't expose sub-agents yet — see RFC 05 §7 decision 3
    expect(CURSOR_CAPABILITIES.supportsDelegation).toBe(false)
    expect(CURSOR_CAPABILITIES.supportsResume).toBe(true)
  })
})
