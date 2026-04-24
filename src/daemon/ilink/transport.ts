/**
 * Transport-layer methods: typing indicator, long-poll wrapper, and the
 * last-active/markChatActive pair that the poll loop calls on every inbound.
 *
 * These all share the typing-ticket cache + sessionState + acctStore and
 * otherwise don't interact with higher-level features (voice, companion),
 * so grouping them keeps the ilink-glue composer leaner.
 */
import { ilinkSendTyping, ilinkGetConfig, ilinkGetUpdates } from '../../../ilink'
import { log } from '../../../log'
import type { IlinkContext } from './context'

export interface TransportMethods {
  sendTyping(chatId: string, accountId?: string): Promise<void>
  getUpdatesForLoop(accountId: string, baseUrl: string, token: string, syncBuf: string): Promise<{
    updates?: unknown[]
    sync_buf?: string
    expired?: boolean
  }>
  markChatActive(chatId: string, accountId?: string): void
  lastActiveChatId(): string | null
}

export function makeTransport(ctx: IlinkContext): TransportMethods {
  const { accounts, acctStore, ctxStore, typingTickets, typingTTLMs, sessionState, lastActiveRef } = ctx

  return {
    async sendTyping(chatId, accountId) {
      try {
        const acct = accountId
          ? accounts.find(a => a.id === accountId)
          : (() => {
              const id = acctStore.get(chatId)
              return id ? accounts.find(a => a.id === id) : undefined
            })()
        if (!acct) {
          log('TYPING', `skip — no account resolvable for chat=${chatId}`)
          return
        }
        const now = Date.now()
        const cached = typingTickets.get(chatId)
        let ticket = cached && now - cached.ts < typingTTLMs ? cached.ticket : undefined
        let source = 'cache'
        if (!ticket) {
          source = 'fresh'
          const cfg = await ilinkGetConfig(acct.baseUrl, acct.token, chatId, ctxStore.get(chatId))
          if (!cfg.typing_ticket) {
            log('TYPING', `getconfig returned no typing_ticket for chat=${chatId} acct=${acct.id} raw=${JSON.stringify(cfg).slice(0, 200)}`)
            return
          }
          ticket = cfg.typing_ticket
          typingTickets.set(chatId, { ticket, ts: now })
        }
        await ilinkSendTyping(acct.baseUrl, acct.token, chatId, ticket)
        log('TYPING', `sent chat=${chatId} acct=${acct.id} ticket=${source}`)
      } catch (err) {
        log('TYPING', `error chat=${chatId}: ${err instanceof Error ? err.message : err}`)
      }
    },

    // poll-loop callback. Catches ilink errcode=-14 (session timeout) and
    // flips SessionStateStore so /health can surface it later. Silent on the
    // state transition per 2026-04-24 pull-based design decision.
    async getUpdatesForLoop(accountId, baseUrl, token, syncBuf) {
      const resp = await ilinkGetUpdates(baseUrl, token, syncBuf)
      if (resp.errcode === -14 || resp.ret === -14) {
        const transitioned = sessionState.markExpired(accountId, `ilink/getupdates errcode=-14: ${resp.errmsg ?? ''}`)
        if (transitioned) {
          log('SESSION_EXPIRED', `${accountId} — marked expired (visible via /health; cleanup with 清理 ${accountId})`)
        }
        return { expired: true }
      }
      return { updates: resp.msgs, sync_buf: resp.get_updates_buf }
    },

    // accountId is the bot that just received a message from this chat —
    // persist it so future replies route back via the same (live) bot even
    // after daemon restart. Without this write the map goes stale the first
    // time a user re-binds (new QR scan = new bot id), silently routing
    // replies to a dead session.
    markChatActive(chatId, accountId) {
      lastActiveRef.current = chatId
      if (accountId && acctStore.get(chatId) !== accountId) {
        acctStore.set(chatId, accountId)
      }
    },

    lastActiveChatId() {
      if (lastActiveRef.current) return lastActiveRef.current
      // Fallback: scan acctStore for any key (last key = most recently set)
      const keys = Object.keys(acctStore.all())
      return keys.length > 0 ? keys[keys.length - 1]! : null
    },
  }
}
