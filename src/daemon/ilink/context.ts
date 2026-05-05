/**
 * Shared runtime context for the ilink adapter's sub-modules.
 *
 * makeIlinkAdapter used to construct everything inline in a single 550-line
 * closure. Splitting out voice / companion / transport into their own files
 * required a common bag of dependencies. IlinkContext is that bag.
 */
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { makeStateStore, type StateStore } from '../state-store'
import { makeSessionStateStore, type SessionStateStore } from '../session-state'
import { PendingPermissions } from '../pending-permissions'
import { unknownChatIdError } from '../../lib/send-reply'
import { makeAccountChatIndex, type AccountChatIndex } from '../account-chat-index'
import type { Db } from '../../lib/db'
import type { ConversationStore } from '../../core/conversation-store'

export interface Account {
  id: string
  botId: string
  userId: string
  baseUrl: string
  token: string
  syncBuf: string
}

export interface IlinkContext {
  stateDir: string
  accounts: Account[]
  projectsFile: string

  ctxStore: StateStore
  acctStore: StateStore
  sessionState: SessionStateStore
  /**
   * Single source of truth for per-chat nicknames + identity (PR5 Task 21).
   * Replaces the standalone nameStore (user_names.json) — IlinkAdapter's
   * setUserName / resolveUserName now delegate here. Caller-injected so
   * the daemon shares one ConversationStore across bootstrap, internal-api,
   * and the ilink adapter.
   */
  conversationStore: ConversationStore

  /** In-memory `accountId → Set<chatId>` populated by transport.markChatActive
   *  on every inbound. Queried by onAccountExpired (PR4 Task 15) to fan out
   *  in-chat notifications when an account is rebound elsewhere. */
  accountChatIndex: AccountChatIndex

  pending: PendingPermissions
  sweepTimer: ReturnType<typeof setInterval>

  // Typing ticket cache (per chat). ilink's typing_ticket has a short TTL;
  // 60s keeps it warm across a message burst without a getconfig round-trip
  // per inbound.
  typingTickets: Map<string, { ticket: string; ts: number }>
  typingTTLMs: number

  // Mutable ref so modules that need to set/read lastActive share state.
  lastActiveRef: { current: string | null }

  resolveAccount(chatId: string): Account
  /**
   * Throw with a user-actionable message when this chat has no on-disk
   * routing state — i.e. neither a captured contextToken nor a persisted
   * account routing. Without one of those, ilink's sendmessage rejects
   * the call with a confusing errcode. Call this at the top of any
   * outbound send (text/voice/file) so the caller sees the real cause
   * + the fix ("user must message the bot first").
   *
   * Error string is unknownChatIdError() from send-reply.ts so it matches
   * the CLI's sendReplyOnce error verbatim — single source of truth.
   */
  assertChatRoutable(chatId: string): void
}

export function makeIlinkContext(opts: {
  stateDir: string
  accounts: Account[]
  db: Db
  conversationStore: ConversationStore
}): IlinkContext {
  const { stateDir, accounts, db, conversationStore } = opts
  mkdirSync(stateDir, { recursive: true })

  const ctxStore = makeStateStore(join(stateDir, 'context_tokens.json'), { debounceMs: 500 })
  const acctStore = makeStateStore(join(stateDir, 'user_account_ids.json'), { debounceMs: 500 })
  const sessionState = makeSessionStateStore(db, { migrateFromFile: join(stateDir, 'session-state.json') })
  const accountChatIndex = makeAccountChatIndex()

  const pending = new PendingPermissions()
  const sweepTimer = setInterval(() => { pending.sweep() }, 30_000)
  if (typeof sweepTimer.unref === 'function') sweepTimer.unref()

  const typingTickets = new Map<string, { ticket: string; ts: number }>()

  function resolveAccount(chatId: string): Account {
    const persistedId = acctStore.get(chatId)
    const found = persistedId ? accounts.find(a => a.id === persistedId) : undefined
    return found ?? accounts[0] ?? (() => { throw new Error('no accounts configured') })()
  }

  function assertChatRoutable(chatId: string): void {
    if (!ctxStore.get(chatId) && !acctStore.get(chatId)) {
      throw new Error(unknownChatIdError(chatId))
    }
  }

  return {
    stateDir,
    accounts,
    projectsFile: join(stateDir, 'projects.json'),
    ctxStore,
    acctStore,
    sessionState,
    conversationStore,
    accountChatIndex,
    pending,
    sweepTimer,
    typingTickets,
    typingTTLMs: 60_000,
    lastActiveRef: { current: null },
    resolveAccount,
    assertChatRoutable,
  }
}
