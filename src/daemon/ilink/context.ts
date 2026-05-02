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
import { unknownChatIdError } from '../../cli/send-reply'

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
  nameStore: StateStore
  acctStore: StateStore
  sessionState: SessionStateStore

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

export function makeIlinkContext(opts: { stateDir: string; accounts: Account[] }): IlinkContext {
  const { stateDir, accounts } = opts
  mkdirSync(stateDir, { recursive: true })

  const ctxStore = makeStateStore(join(stateDir, 'context_tokens.json'), { debounceMs: 500 })
  const nameStore = makeStateStore(join(stateDir, 'user_names.json'), { debounceMs: 500 })
  const acctStore = makeStateStore(join(stateDir, 'user_account_ids.json'), { debounceMs: 500 })
  const sessionState = makeSessionStateStore(join(stateDir, 'session-state.json'), { debounceMs: 500 })

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
    nameStore,
    acctStore,
    sessionState,
    pending,
    sweepTimer,
    typingTickets,
    typingTTLMs: 60_000,
    lastActiveRef: { current: null },
    resolveAccount,
    assertChatRoutable,
  }
}
