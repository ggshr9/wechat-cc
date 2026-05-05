/**
 * fallback-reply.ts — wraps the IlinkAdapter's sendMessage envelope
 * (`{ msgId, error? }`) into the coordinator's expected
 * `(chatId, text) => Promise<void>` shape, with diagnostic logging at
 * each outcome.
 *
 * Why a dedicated wrapper:
 *
 * v0.5.1/0.5.2 had a 3-layer silent error swallow on the FALLBACK_REPLY
 * path. (1) `sendReplyOnce` returns `{ ok: false, error }` instead of
 * throwing (CLI back-compat). (2) `ilink-glue.sendMessage` packages
 * that into `{ msgId, error? }` (MCP `reply` tool back-compat).
 * (3) The bootstrap wrapper used to be:
 *   `async (chatId, text) => { await deps.ilink.sendMessage(chatId, text) }`
 * — `await`-and-discard, with no log of the envelope. Result: a real
 * production case on 2026-05-05 where the daemon generated a fallback
 * reply, ilink retried 3 times for ~65s due to a stale keep-alive
 * connection, and the FAILED case (had retries kept failing) would have
 * shipped to the user with zero diagnostic visibility. The only
 * evidence was `[RETRY]` lines deep inside ilink.ts that the
 * dashboard's Logs panel didn't surface in the inbound flow.
 *
 * v0.5.3: this wrapper logs `[FALLBACK_REPLY_SENT]` on success and
 * `[FALLBACK_REPLY_FAIL]` on either an error envelope or a thrown
 * exception (which it then re-raises so the coordinator's outer
 * handling stays intact).
 */

export type SendMessageResult = { msgId: string; error?: string }

export interface FallbackReplyDeps {
  /** ilink adapter's sendMessage. Undefined when there's no ilink wired (test harnesses). */
  sendMessage: ((chatId: string, text: string) => Promise<SendMessageResult>) | undefined
  log: (tag: string, line: string) => void
}

export type SendAssistantText = (chatId: string, text: string) => Promise<void>

export function makeSendAssistantText(deps: FallbackReplyDeps): SendAssistantText | undefined {
  if (!deps.sendMessage) return undefined
  const send = deps.sendMessage
  return async (chatId, text) => {
    let result: SendMessageResult
    try {
      result = await send(chatId, text)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      deps.log('FALLBACK_REPLY_FAIL', `chat=${chatId} threw: ${msg}`)
      throw err
    }
    if (result.error) {
      deps.log('FALLBACK_REPLY_FAIL', `chat=${chatId} error=${result.error}`)
      return
    }
    deps.log('FALLBACK_REPLY_SENT', `chat=${chatId} msgId=${result.msgId}`)
  }
}
