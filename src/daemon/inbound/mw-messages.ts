/**
 * mw-messages — mirror every allow-listed inbound message into the
 * canonical messages table (spec D4). Runs BEFORE next() so messages
 * consumed by command routing (admin / mode / onboarding) still land,
 * with kind='command'. Placed after access (denied senders never reach
 * here) — see build.ts ordering.
 */
import type { Middleware } from './types'
import type { MessageRecord } from '../../lib/messages-store'
import { inboundMessageId, inboundFallbackMessageId } from '../../lib/messages-store'
import { isoFromMs } from '../../lib/iso-time'

export interface MessagesMwDeps {
  append(rec: MessageRecord): Promise<number>
  log: (tag: string, line: string) => void
}

export function makeMwMessages(deps: MessagesMwDeps): Middleware {
  return async (ctx, next) => {
    const messageId = ctx.msg.createTimeMs
      ? inboundMessageId(ctx.msg.userId, ctx.msg.createTimeMs)
      : inboundFallbackMessageId(ctx.msg.userId, ctx.msg.text)
    const rec: MessageRecord = {
      id: messageId,
      chatId: ctx.msg.chatId,
      // Guard against an out-of-range create_time_ms (untrusted poll payload):
      // a raw new Date(huge).toISOString() throws RangeError, which here — on
      // the hot path that records every inbound — would silently drop the
      // user's message. Fall back to the receive time.
      ts: isoFromMs(ctx.msg.createTimeMs || ctx.receivedAtMs, ctx.receivedAtMs),
      direction: 'in',
      kind: ctx.msg.text.startsWith('/') ? 'command'
        : ctx.msg.msgType !== 'text' ? ctx.msg.msgType
        : 'text',
      text: ctx.msg.text,
      source: 'live',
    }
    try { await deps.append(rec) } catch (err) {
      deps.log('MESSAGES', `inbound record failed for ${ctx.msg.chatId}: ${err instanceof Error ? err.message : err}`)
    }
    await next()
  }
}
