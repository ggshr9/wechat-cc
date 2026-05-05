// mw-typing.test.ts
import { describe, it, expect, vi } from 'vitest'
import { makeMwTyping } from './mw-typing'
import type { InboundCtx } from './types'

const ctxFor = (over: Partial<InboundCtx['msg']> = {}): InboundCtx => ({
  msg: { chatId: 'c1', accountId: 'a1', ...over } as InboundCtx['msg'],
  receivedAtMs: 0,
  requestId: 'r',
})

describe('mwTyping', () => {
  it('fires sendTyping (no await) and continues', async () => {
    const sendTyping = vi.fn(async () => {})
    const mw = makeMwTyping({ sendTyping })
    let nextCalled = false
    await mw(ctxFor(), async () => { nextCalled = true })
    expect(sendTyping).toHaveBeenCalledWith('c1', 'a1')
    expect(nextCalled).toBe(true)
  })

  it('does not throw if sendTyping rejects', async () => {
    const mw = makeMwTyping({ sendTyping: async () => { throw new Error('x') } })
    await expect(mw(ctxFor(), async () => {})).resolves.toBeUndefined()
  })

  // v0.5.3: typing must keep pulsing while the rest of the pipeline runs.
  // Two reasons:
  //   1. WeChat client's "对方正在输入" indicator fades after ~5-10s. With
  //      Claude often taking 60-120s to think, the user sees typing for a
  //      few seconds then nothing — looks like the bot died.
  //   2. The same baseUrl is shared with the long-poll connection. After
  //      a long idle the keep-alive pool entry can be silently closed by
  //      NAT/middlebox/server. Periodic typing keeps the pool warm so the
  //      eventual sendmessage doesn't hit a stale-connection 30s timeout.
  // Acceptance: ≥ 3 sendTyping calls in a 12s next() (one immediate, two
  // ticks at +5s and +10s) and the interval cleared after next() resolves.
  it('keeps pulsing sendTyping every 5s while next() runs (WeChat typing visibility + connection-pool keepalive)', async () => {
    vi.useFakeTimers()
    try {
      const sendTyping = vi.fn(async () => {})
      const mw = makeMwTyping({ sendTyping })

      // next() resolves after 12s of fake time
      const middlewarePromise = mw(ctxFor(), async () => {
        await vi.advanceTimersByTimeAsync(12_000)
      })

      await middlewarePromise
      // Initial fire (t=0) + one tick at t=5s + one at t=10s = 3 minimum.
      // The exact count is tolerant of microtask scheduling drift.
      expect(sendTyping.mock.calls.length).toBeGreaterThanOrEqual(3)

      // After resolution, no further ticks should fire even if more time
      // passes (clearInterval was honored in the finally block).
      const beforeIdleAdvance = sendTyping.mock.calls.length
      await vi.advanceTimersByTimeAsync(20_000)
      expect(sendTyping.mock.calls.length).toBe(beforeIdleAdvance)
    } finally {
      vi.useRealTimers()
    }
  })

  // Stalled / network-bad sendTyping must not pile up calls. If a single
  // typing attempt is taking longer than the tick interval, skip the next
  // tick instead of queuing — otherwise a flaky network produces an
  // unbounded fan-out of pending fetches.
  it('does not stack overlapping sendTyping calls when one stalls beyond the tick interval', async () => {
    vi.useFakeTimers()
    try {
      // First sendTyping call hangs forever; subsequent ticks should skip.
      let firstCalled = false
      const sendTyping = vi.fn(async () => {
        if (!firstCalled) { firstCalled = true; await new Promise(() => {}) /* never resolves */ }
      })
      const mw = makeMwTyping({ sendTyping })

      const middlewarePromise = mw(ctxFor(), async () => {
        await vi.advanceTimersByTimeAsync(20_000)
      })
      await middlewarePromise

      // Only the initial fire should have been made. All subsequent ticks
      // skipped because inflight=true.
      expect(sendTyping).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
