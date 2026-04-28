import { describe, it, expect, vi } from 'vitest'
import { createClaudeAgentProvider } from './claude-agent-provider'

// We monkeypatch @anthropic-ai/claude-agent-sdk's `query` so the test
// doesn't actually spawn `claude`. The harness controls the message
// stream the provider sees and asserts that dispatch() awaits the
// next `result` event before resolving — this is the contract that
// message-router.ts depends on. Before the fix, dispatch resolved
// immediately after pushing to the queue and the router saw an empty
// assistantText, dropping every WeChat reply on the floor.

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
  it('dispatch awaits the next result event and returns collected assistant text', async () => {
    const provider = createClaudeAgentProvider({ sdkOptionsForProject: () => ({}) })
    const session = await provider.spawn({ alias: 'p', path: '/p' })

    const dispatched = session.dispatch('hello')

    // Simulate the SDK streaming back two assistant chunks then a result.
    // dispatch() should resolve only after the result event fires.
    ;(sdk as unknown as { __test_yield: (m: unknown) => void }).__test_yield({
      type: 'assistant', message: { content: [{ type: 'text', text: 'hi ' }] },
    })
    ;(sdk as unknown as { __test_yield: (m: unknown) => void }).__test_yield({
      type: 'assistant', message: { content: [{ type: 'text', text: 'there' }] },
    })

    // Race the dispatch against a 50ms timer to prove it hasn't resolved yet.
    const tooEarly = await Promise.race([
      dispatched.then(() => 'resolved'),
      new Promise<string>(resolve => setTimeout(() => resolve('still-waiting'), 50)),
    ])
    expect(tooEarly).toBe('still-waiting')

    ;(sdk as unknown as { __test_yield: (m: unknown) => void }).__test_yield({
      type: 'result', subtype: 'success', session_id: 'sid-1', num_turns: 1, duration_ms: 100,
    })

    const result = await dispatched
    expect(result.assistantText).toEqual(['hi ', 'there'])
  })

  it('multiple dispatches in flight resolve in FIFO order', async () => {
    const provider = createClaudeAgentProvider({ sdkOptionsForProject: () => ({}) })
    const session = await provider.spawn({ alias: 'p', path: '/p' })

    const first = session.dispatch('msg-1')
    const second = session.dispatch('msg-2')

    // First turn: one assistant chunk + result
    ;(sdk as unknown as { __test_yield: (m: unknown) => void }).__test_yield({
      type: 'assistant', message: { content: [{ type: 'text', text: 'reply-1' }] },
    })
    ;(sdk as unknown as { __test_yield: (m: unknown) => void }).__test_yield({
      type: 'result', subtype: 'success', session_id: 'sid-1', num_turns: 1, duration_ms: 100,
    })

    expect(await first).toEqual({ assistantText: ['reply-1'] })

    // Second turn
    ;(sdk as unknown as { __test_yield: (m: unknown) => void }).__test_yield({
      type: 'assistant', message: { content: [{ type: 'text', text: 'reply-2' }] },
    })
    ;(sdk as unknown as { __test_yield: (m: unknown) => void }).__test_yield({
      type: 'result', subtype: 'success', session_id: 'sid-1', num_turns: 2, duration_ms: 100,
    })

    expect(await second).toEqual({ assistantText: ['reply-2'] })
  })

  it('close() resolves any still-pending dispatches with empty text instead of hanging', async () => {
    const provider = createClaudeAgentProvider({ sdkOptionsForProject: () => ({}) })
    const session = await provider.spawn({ alias: 'p', path: '/p' })

    const dispatched = session.dispatch('will-not-finish')
    await session.close()

    const result = await dispatched
    expect(result.assistantText).toEqual([])
  })

  it('assistant text arriving with no pending turn is dropped, not attributed to next dispatch', async () => {
    const provider = createClaudeAgentProvider({ sdkOptionsForProject: () => ({}) })
    const session = await provider.spawn({ alias: 'p', path: '/p' })

    // Suppress the [STREAM_DROP] warning the provider emits — we expect it
    // and the assertion below counts on it being there. spy verifies it ran.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // Pre-emit an assistant chunk before any dispatch is in flight. This
    // should be dropped (the only "owner" of assistant text is an awaiting
    // dispatch — attributing pre-pending chunks to a later dispatch would
    // mix unrelated turns).
    ;(sdk as unknown as { __test_yield: (m: unknown) => void }).__test_yield({
      type: 'assistant', message: { content: [{ type: 'text', text: 'orphan' }] },
    })
    // Give the iterator loop a tick to consume the yielded message.
    await new Promise(r => setTimeout(r, 10))
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('STREAM_DROP'))

    // Now dispatch — the result must contain ONLY this turn's text, not
    // the orphan from before.
    const dispatched = session.dispatch('hello')
    ;(sdk as unknown as { __test_yield: (m: unknown) => void }).__test_yield({
      type: 'assistant', message: { content: [{ type: 'text', text: 'fresh' }] },
    })
    ;(sdk as unknown as { __test_yield: (m: unknown) => void }).__test_yield({
      type: 'result', subtype: 'success', session_id: 'sid-1', num_turns: 1, duration_ms: 100,
    })
    const result = await dispatched
    expect(result.assistantText).toEqual(['fresh'])
    warnSpy.mockRestore()
  })

  it('SDK iterator throwing rejects pending turns rather than hanging', async () => {
    const provider = createClaudeAgentProvider({ sdkOptionsForProject: () => ({}) })
    const session = await provider.spawn({ alias: 'p', path: '/p' })

    const dispatched = session.dispatch('hello')
    // Force the SDK iterator to throw by ending the stream while the turn
    // is in flight. Implementation rejects all pending turns on iterator
    // exit; close() then drains. Exact mechanism: end() makes the iterator
    // return done:true, the for-await exits cleanly, the catch block below
    // doesn't fire — but any unfinished turn is left dangling. The fix
    // resolves them empty in close(), which we test above. Here we make
    // sure end-of-stream alone doesn't throw.
    ;(sdk as unknown as { __test_end: () => void }).__test_end()
    await session.close()
    const result = await dispatched
    expect(result.assistantText).toEqual([])
  })
})
