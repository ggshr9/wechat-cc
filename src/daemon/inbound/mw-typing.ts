// mw-typing.ts
import type { Middleware } from './types'

export interface TypingMwDeps {
  sendTyping(chatId: string, accountId: string): Promise<void>
}

/**
 * Tick interval for the typing keepalive (ms). Below the WeChat client's
 * "对方正在输入" indicator fade time (~5-10s) AND below typical NAT/server
 * keep-alive timeouts (30-60s+) so the same-host fetch pool stays warm
 * and validated through the entire pipeline.
 *
 * Exported for tests to assert against without re-deriving the constant.
 */
export const TYPING_KEEPALIVE_INTERVAL_MS = 5_000

/**
 * Pulses ilink/sendtyping every TYPING_KEEPALIVE_INTERVAL_MS while the
 * downstream pipeline runs. Two wins for the price of one ticker:
 *
 *   1. **UX**: the WeChat client's typing indicator fades after ~5-10s,
 *      so a single fire-once at message receipt leaves the user staring
 *      at a stale chat for the 30-120s Claude takes to think. Periodic
 *      typing keeps the indicator visible the whole time.
 *   2. **Connection pool keepalive**: ilink/sendtyping shares a baseUrl
 *      and Bun fetch keep-alive pool with ilink/sendmessage. Without
 *      activity, the pool's connections age out — silently closed by NAT,
 *      middleboxes, or the ilink server's own idle timeout. The next
 *      sendmessage then reuses a dead connection and times out for
 *      `API_TIMEOUT_MS` (30s) before the retry loop kicks in (verified
 *      from production logs 2026-04-21, 2026-04-22 ×2, 2026-05-05). A 5s
 *      ticker keeps at least one connection in the pool fresh and
 *      end-to-end-validated, eliminating the stale-connection class
 *      entirely.
 *
 * `inflight` guard prevents call pile-up when a single sendTyping stalls
 * past the tick interval. Without it, a flaky network produces an
 * unbounded fan-out of pending fetches.
 */
export function makeMwTyping(deps: TypingMwDeps): Middleware {
  return async (ctx, next) => {
    let inflight = false
    const tick = () => {
      if (inflight) return
      inflight = true
      // Fire-and-forget — sendTyping itself logs success/failure via [TYPING].
      void deps.sendTyping(ctx.msg.chatId, ctx.msg.accountId)
        .catch(() => {})
        .finally(() => { inflight = false })
    }
    tick() // immediate
    const timer = setInterval(tick, TYPING_KEEPALIVE_INTERVAL_MS)
    try {
      await next()
    } finally {
      clearInterval(timer)
    }
  }
}
