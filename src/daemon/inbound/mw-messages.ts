/**
 * mw-messages — mirror every allow-listed inbound message into the
 * canonical messages table (spec D4). Runs BEFORE next() so messages
 * consumed by command routing (admin / mode / onboarding) still land,
 * with kind='command'. Placed after access (denied senders never reach
 * here) — see build.ts ordering.
 */
import type { Middleware } from './types'
import type { MessageRecord } from '../../lib/messages-store'
import { inboundMessageId } from '../../lib/messages-store'

export interface MessagesMwDeps {
  append(rec: MessageRecord): Promise<void>
  log: (tag: string, line: string) => void
}

export function makeMwMessages(deps: MessagesMwDeps): Middleware {
  return async (ctx, next) => {
    const when = new Date(ctx.msg.createTimeMs || ctx.receivedAtMs)
    const rec: MessageRecord = {
      id: inboundMessageId(ctx.msg.userId, ctx.msg.createTimeMs || ctx.receivedAtMs),
      chatId: ctx.msg.chatId,
      ts: when.toISOString(),
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
