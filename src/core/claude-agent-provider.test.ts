import { describe, it, expect, vi } from 'vitest'
import { createClaudeAgentProvider } from './claude-agent-provider'
import type { AgentEvent } from './agent-provider'

// Helper: drain an async iterable into an array for assertion.
async function drain(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = []
  for await (const ev of events) out.push(ev)
  return out
}

// We monkeypatch @anthropic-ai/claude-agent-sdk's `query` so the test
// doesn't actually spawn `claude`. The harness controls the message
// stream the provider sees and asserts that dispatch() yields events
// in the correct sequence.

vi.mock('@anthropic-ai/claude-agent-sdk', () => {
  const sentMessages: unknown[] = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let yieldFn: ((msg: any) => void) | null = null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let endFn: (() => void) | null = null

  function makeStream() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const buffer: any[] = []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resolvers: ((v: IteratorResult<any>) => void)[] = []
    let closed = false
    yieldFn = (msg) => {
      const r = resolvers.shift()
      if (r) r({ value: msg, done: false })
      else buffer.push(msg)
    }
    endFn = () => {
      closed = true
      const r = resolvers.shift()
      if (r) r({ value: undefined, done: true })
    }
    return {
      [Symbol.asyncIterator]() {
        return {
          next() {
            if (buffer.length > 0) return Promise.resolve({ value: buffer.shift(), done: false })
            if (closed) return Promise.resolve({ value: undefined, done: true })
            return new Promise<IteratorResult<unknown>>(res => resolvers.push(res))
          },
        }
      },
    }
  }

  return {
    query: ({ prompt }: { prompt: AsyncIterable<unknown> }) => {
      ;(async () => {
        for await (const m of prompt) sentMessages.push(m)
      })()
      return makeStream()
    },
    __test_yield: (msg: unknown) => yieldFn?.(msg),
    __test_end: () => endFn?.(),
    __test_sent: () => sentMessages,
  }
})

import * as sdk from '@anthropic-ai/claude-agent-sdk'

describe('claude-agent-provider', () => {
  it('yields init then text then result for a simple turn', async () => {
    const provider = createClaudeAgentProvider({ sdkOptionsForProject: () => ({}) })
    const session = await provider.spawn({ alias: 'foo', path: '/tmp' })

    const eventsPromise = drain(session.dispatch('hi'))

    // Give the background task a tick to start consuming
    await new Promise(r => setTimeout(r, 0))

    ;(sdk as unknown as { __test_yield: (m: unknown) => void }).__test_yield({
      type: 'system', subtype: 'init', session_id: 's1',
    })
    ;(sdk as unknown as { __test_yield: (m: unknown) => void }).__test_yield({
      type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] },
    })
    ;(sdk as unknown as { __test_yield: (m: unknown) => void }).__test_yield({
      type: 'result', subtype: 'success', session_id: 's1', num_turns: 1, duration_ms: 100,
    })

    const events = await eventsPromise
    expect(events).toEqual([
      { kind: 'init', sessionId: 's1' },
      { kind: 'text', text: 'hello' },
      { kind: 'result', sessionId: 's1', numTurns: 1, durationMs: 100 },
    ])
    await session.close()
  })

  it('yields tool_call for `mcp__wechat__reply` with `{server:"wechat", tool:"reply"}`', async () => {
    const provider = createClaudeAgentProvider({ sdkOptionsForProject: () => ({}) })
    const session = await provider.spawn({ alias: 'foo', path: '/tmp' })

    const eventsPromise = drain(session.dispatch('reply please'))

    await new Promise(r => setTimeout(r, 0))

    ;(sdk as unknown as { __test_yield: (m: unknown) => void }).__test_yield({
      type: 'assistant',
      message: { content: [
        { type: 'text', text: 'thinking aloud' },
        { type: 'tool_use', name: 'mcp__wechat__reply', input: { chat_id: 'c', text: 'hi back' } },
      ] },
    })
    ;(sdk as unknown as { __test_yield: (m: unknown) => void }).__test_yield({
      type: 'result', subtype: 'success', session_id: 's2', num_turns: 1, duration_ms: 50,
    })

    const events = await eventsPromise
    const toolCall = events.find(e => e.kind === 'tool_call')
    expect(toolCall).toBeDefined()
    expect(toolCall).toEqual({ kind: 'tool_call', server: 'wechat', tool: 'reply' })
    await session.close()
  })

  it('yields tool_call for built-in tools without server prefix', async () => {
    const provider = createClaudeAgentProvider({ sdkOptionsForProject: () => ({}) })
    const session = await provider.spawn({ alias: 'foo', path: '/tmp' })

    const eventsPromise = drain(session.dispatch('read a file'))

    await new Promise(r => setTimeout(r, 0))

    ;(sdk as unknown as { __test_yield: (m: unknown) => void }).__test_yield({
      type: 'assistant',
      message: { content: [
        { type: 'tool_use', name: 'Read', input: { file_path: '/img.jpg' } },
      ] },
    })
    ;(sdk as unknown as { __test_yield: (m: unknown) => void }).__test_yield({
      type: 'result', subtype: 'success', session_id: 's3', num_turns: 1, duration_ms: 0,
    })

    const events = await eventsPromise
    const toolCall = events.find(e => e.kind === 'tool_call')
    expect(toolCall).toBeDefined()
    expect((toolCall as { server?: string }).server).toBeUndefined()
    expect((toolCall as { tool: string }).tool).toBe('Read')
    await session.close()
  })

  it('yields error event for non-success result subtype', async () => {
    const provider = createClaudeAgentProvider({ sdkOptionsForProject: () => ({}) })
    const session = await provider.spawn({ alias: 'foo', path: '/tmp' })

    const eventsPromise = drain(session.dispatch('hi'))

    await new Promise(r => setTimeout(r, 0))

    ;(sdk as unknown as { __test_yield: (m: unknown) => void }).__test_yield({
      type: 'result', subtype: 'error', result: 'tool execution failed', session_id: 's4', num_turns: 1, duration_ms: 0,
    })

    const events = await eventsPromise
    expect(events.some(e => e.kind === 'error')).toBe(true)
    const errorEvent = events.find(e => e.kind === 'error')
    expect((errorEvent as { message: string }).message).toContain('error')
    // result event should still come after error event
    expect(events.some(e => e.kind === 'result')).toBe(true)
    await session.close()
  })

  it('translates "Please run /login" assistant text into an auth_failed error event (not a normal text reply)', async () => {
    // When claude is unauthenticated, its binary streams the literal text
    // "Not logged in · Please run /login" as an assistant message. Without
    // interception that string leaks to the user as if it were a real reply.
    // The provider must intercept it and surface a structured error so the
    // coordinator can suppress the fallback path.
    const provider = createClaudeAgentProvider({ sdkOptionsForProject: () => ({}) })
    const session = await provider.spawn({ alias: 'foo', path: '/tmp' })

    const eventsPromise = drain(session.dispatch('hi'))

    await new Promise(r => setTimeout(r, 0))

    ;(sdk as unknown as { __test_yield: (m: unknown) => void }).__test_yield({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Not logged in · Please run /login' }] },
    })
    ;(sdk as unknown as { __test_yield: (m: unknown) => void }).__test_yield({
      type: 'result', subtype: 'success', session_id: 's-auth', num_turns: 1, duration_ms: 0,
    })

    const events = await eventsPromise
    // The auth-fail text MUST NOT pass through as a normal text event.
    expect(events.find(e => e.kind === 'text')).toBeUndefined()
    // It must be surfaced as a structured error with a specific code.
    const errorEvent = events.find(e => e.kind === 'error')
    expect(errorEvent).toBeDefined()
    expect((errorEvent as { code?: string }).code).toBe('auth_failed')
    // Result event still arrives last so the iterator closes cleanly.
    expect(events[events.length - 1]?.kind).toBe('result')
    await session.close()
  })

  it('routes a "Not logged in" assistant chunk to auth_failed even when "/login" arrives separately', async () => {
    // The SDK is free to split the auth-fail sentinel across multiple
    // assistant messages — observed shape from the claude binary's string
    // table is two distinct strings, "Not logged in" and "Please run /login".
    // The provider must catch the first chunk; otherwise that chunk flows to
    // the user as a normal reply before the second one trips the error path.
    const provider = createClaudeAgentProvider({ sdkOptionsForProject: () => ({}) })
    const session = await provider.spawn({ alias: 'foo', path: '/tmp' })

    const eventsPromise = drain(session.dispatch('hi'))
    await new Promise(r => setTimeout(r, 0))

    ;(sdk as unknown as { __test_yield: (m: unknown) => void }).__test_yield({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Not logged in' }] },
    })
    ;(sdk as unknown as { __test_yield: (m: unknown) => void }).__test_yield({
      type: 'result', subtype: 'success', session_id: 's-auth-split', num_turns: 1, duration_ms: 0,
    })

    const events = await eventsPromise
    expect(events.find(e => e.kind === 'text')).toBeUndefined()
    const errorEvent = events.find(e => e.kind === 'error')
    expect(errorEvent).toBeDefined()
    expect((errorEvent as { code?: string }).code).toBe('auth_failed')
    await session.close()
  })

  it('returns an empty iterable after close()', async () => {
    const provider = createClaudeAgentProvider({ sdkOptionsForProject: () => ({}) })
    const session = await provider.spawn({ alias: 'foo', path: '/tmp' })
    await session.close()
    const events = await drain(session.dispatch('after close'))
    expect(events).toEqual([])
  })

  it('throws if dispatch is called while a previous dispatch is in flight', async () => {
    const provider = createClaudeAgentProvider({ sdkOptionsForProject: () => ({}) })
    const session = await provider.spawn({ alias: 'foo', path: '/tmp' })

    // Start first dispatch — do NOT drain it yet (keep it in-flight)
    const first = session.dispatch('a')
    // Start consuming the iterator to set the active queue
    const firstIterator = first[Symbol.asyncIterator]()
    // Kick off the iterator — don't await so it's in-flight
    const firstNextPromise = firstIterator.next()

    await new Promise(r => setTimeout(r, 0))

    // Second dispatch while first is in flight should throw
    expect(() => session.dispatch('b')).toThrow(/in flight/)

    // Finish first dispatch cleanly
    ;(sdk as unknown as { __test_yield: (m: unknown) => void }).__test_yield({
      type: 'result', subtype: 'success', session_id: 's5', num_turns: 1, duration_ms: 0,
    })

    await firstNextPromise
    // Drain the rest
    for await (const _ of { [Symbol.asyncIterator]: () => firstIterator }) { /* drain */ }
    await session.close()
  })

  it('assistant text arriving with no active queue is dropped with [STREAM_DROP] warn', async () => {
    const provider = createClaudeAgentProvider({ sdkOptionsForProject: () => ({}) })
    const session = await provider.spawn({ alias: 'foo', path: '/tmp' })

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // Emit assistant text before any dispatch is in flight
    ;(sdk as unknown as { __test_yield: (m: unknown) => void }).__test_yield({
      type: 'assistant', message: { content: [{ type: 'text', text: 'orphan' }] },
    })
    // Give the iterator loop a tick to consume the yielded message
    await new Promise(r => setTimeout(r, 10))
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('STREAM_DROP'))

    // Now dispatch — the result must contain ONLY this turn's text, not the orphan
    const eventsPromise = drain(session.dispatch('hello'))

    await new Promise(r => setTimeout(r, 0))

    ;(sdk as unknown as { __test_yield: (m: unknown) => void }).__test_yield({
      type: 'assistant', message: { content: [{ type: 'text', text: 'fresh' }] },
    })
    ;(sdk as unknown as { __test_yield: (m: unknown) => void }).__test_yield({
      type: 'result', subtype: 'success', session_id: 'sid-1', num_turns: 1, duration_ms: 100,
    })

    const events = await eventsPromise
    const textEvents = events.filter(e => e.kind === 'text')
    expect(textEvents).toEqual([{ kind: 'text', text: 'fresh' }])
    warnSpy.mockRestore()
    await session.close()
  })
})
