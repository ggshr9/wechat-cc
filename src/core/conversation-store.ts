/**
 * conversation-store — persistent chatId → Mode map (RFC 03 §3.4).
 *
 * Holds the user's mode preference per chat: which provider for solo,
 * primary for primary_tool, parallel/chatroom flags.
 *
 * Backed by the daemon's SQLite db (PR7 — moved off
 * ~/.claude/channels/wechat/conversations.json). Mode is stored as
 * separate columns (mode_kind / mode_provider / mode_primary) so future
 * queries like "all chats on codex" don't need JSON1.
 *
 * The store is provider-id-aware (modes carry ProviderId strings) but
 * does NOT validate against the registry — that's the coordinator's
 * job, since the registry isn't always loaded when the store is read
 * (e.g. by CLI tools that just inspect state).
 */
import { existsSync, readFileSync } from 'node:fs'
import { renameMigrated, type Db } from '../lib/db'
import type { Mode, PersistedConversation } from './conversation'

export interface ConversationIdentity {
  user_id: string | null
  account_id: string | null
  last_user_name: string | null
}

export interface ConversationStore {
  /** Get the persisted mode for a chat, or null if none set. */
  get(chatId: string): PersistedConversation | null
  /** Set the mode for a chat. */
  set(chatId: string, mode: Mode): void
  /** Remove a chat's mode (revert to daemon default). */
  delete(chatId: string): void
  /** Snapshot of all persisted conversations. */
  all(): Record<string, PersistedConversation>
  /** No-op for SQLite-backed stores; retained so callers using the JSON-era API still compile. */
  flush(): Promise<void>

  /**
   * Upsert WeChat identity for a chat. Merge semantics: undefined fields
   * preserve the existing value; null fields explicitly clear it.
   * If the chat has no row yet, inserts with default mode `solo+claude`
   * (the daemon default for the vast majority of installations).
   */
  upsertIdentity(chatId: string, ids: { userId?: string; accountId?: string; userName?: string }): void

  /** Read identity columns for a chat. Null if no row exists. */
  getIdentity(chatId: string): ConversationIdentity | null

  /** All chat IDs whose row carries this account_id. Used to fan out
   *  account-expired notifications without an in-memory side index. */
  chatsForAccount(accountId: string): readonly string[]
}

export interface ConversationStoreOpts {
  migrateFromFile?: string
  /**
   * Backfill `last_user_name` from a legacy `user_names.json` (chatId → name).
   * Renames the source file to `*.migrated` after a successful import — same
   * convention as `migrateFromFile`. Replaces the standalone nameStore that
   * PR5 deprecated; the IlinkAdapter's setUserName/resolveUserName now
   * delegate to ConversationStore.
   */
  migrateFromUserNamesFile?: string
}

interface LegacyShape {
  version?: 1
  conversations?: Record<string, PersistedConversation>
}

interface Row {
  chat_id: string
  mode_kind: string
  mode_provider: string | null
  mode_primary: string | null
  user_id: string | null
  account_id: string | null
  last_user_name: string | null
}

function rowToMode(r: Row): Mode | null {
  switch (r.mode_kind) {
    case 'solo':
      return r.mode_provider ? { kind: 'solo', provider: r.mode_provider } : null
    case 'primary_tool':
      return r.mode_primary ? { kind: 'primary_tool', primary: r.mode_primary } : null
    case 'parallel':
      return { kind: 'parallel' }
    case 'chatroom':
      return { kind: 'chatroom' }
    default:
      return null
  }
}

function modeColumns(mode: Mode): { kind: string; provider: string | null; primary: string | null } {
  switch (mode.kind) {
    case 'solo':
      return { kind: 'solo', provider: mode.provider, primary: null }
    case 'primary_tool':
      return { kind: 'primary_tool', provider: null, primary: mode.primary }
    case 'parallel':
      return { kind: 'parallel', provider: null, primary: null }
    case 'chatroom':
      return { kind: 'chatroom', provider: null, primary: null }
  }
}

export function makeConversationStore(db: Db, opts: ConversationStoreOpts = {}): ConversationStore {
  if (opts.migrateFromFile) maybeImportLegacy(db, opts.migrateFromFile)
  if (opts.migrateFromUserNamesFile) maybeBackfillUserNames(db, opts.migrateFromUserNamesFile)

  const stmtGet = db.query<Row, [string]>(
    'SELECT chat_id, mode_kind, mode_provider, mode_primary, user_id, account_id, last_user_name FROM conversations WHERE chat_id = ?',
  )
  const stmtUpsert = db.query<unknown, [string, string, string | null, string | null, string]>(
    'INSERT INTO conversations(chat_id, mode_kind, mode_provider, mode_primary, updated_at) VALUES (?, ?, ?, ?, ?) ' +
    'ON CONFLICT(chat_id) DO UPDATE SET mode_kind = excluded.mode_kind, mode_provider = excluded.mode_provider, mode_primary = excluded.mode_primary, updated_at = excluded.updated_at',
  )
  const stmtDelete = db.query<unknown, [string]>('DELETE FROM conversations WHERE chat_id = ?')
  const stmtAll = db.query<Row, []>(
    'SELECT chat_id, mode_kind, mode_provider, mode_primary, user_id, account_id, last_user_name FROM conversations',
  )

  const stmtGetIdentity = db.query<ConversationIdentity, [string]>(
    'SELECT user_id, account_id, last_user_name FROM conversations WHERE chat_id = ?',
  )

  const stmtChatsForAccount = db.query<{ chat_id: string }, [string]>(
    'SELECT chat_id FROM conversations WHERE account_id = ?',
  )

  // Upsert identity. INSERT path uses default mode (solo+claude) so the
  // row satisfies the NOT NULL CHECK on mode_kind. UPDATE path COALESCEs
  // each identity column with excluded so undefined args (mapped to NULL
  // at the call site) preserve, and defined args overwrite. Mode columns
  // are NEVER touched in the UPDATE branch — preserves any existing
  // /cc /codex selection set via the regular set() method.
  const stmtUpsertIdentity = db.query<unknown, [string, string | null, string | null, string | null, string]>(
    `INSERT INTO conversations
       (chat_id, mode_kind, mode_provider, mode_primary, user_id, account_id, last_user_name, updated_at)
     VALUES (?, 'solo', 'claude', NULL, ?, ?, ?, ?)
     ON CONFLICT(chat_id) DO UPDATE SET
       user_id        = COALESCE(excluded.user_id, user_id),
       account_id     = COALESCE(excluded.account_id, account_id),
       last_user_name = COALESCE(excluded.last_user_name, last_user_name),
       updated_at     = excluded.updated_at`,
  )

  return {
    get(chatId) {
      const row = stmtGet.get(chatId)
      if (!row) return null
      const mode = rowToMode(row)
      return mode ? { mode } : null
    },

    set(chatId, mode) {
      const cols = modeColumns(mode)
      stmtUpsert.run(chatId, cols.kind, cols.provider, cols.primary, new Date().toISOString())
    },

    delete(chatId) {
      stmtDelete.run(chatId)
    },

    all() {
      const out: Record<string, PersistedConversation> = {}
      for (const r of stmtAll.all()) {
        const mode = rowToMode(r)
        if (mode) out[r.chat_id] = { mode }
      }
      return out
    },

    async flush() { /* SQLite writes are immediate */ },

    upsertIdentity(chatId, ids) {
      // Map undefined → null so the SQL gets a deterministic value; COALESCE
      // in the UPDATE branch then preserves prior values for NULLs. (For the
      // INSERT branch, NULL is the correct stored value when the field is
      // truly absent.)
      stmtUpsertIdentity.run(
        chatId,
        ids.userId ?? null,
        ids.accountId ?? null,
        ids.userName ?? null,
        new Date().toISOString(),
      )
    },

    getIdentity(chatId) {
      const row = stmtGetIdentity.get(chatId)
      return row ?? null
    },

    chatsForAccount(accountId) {
      if (!accountId) return []
      return stmtChatsForAccount.all(accountId).map(r => r.chat_id)
    },
  }
}

function maybeBackfillUserNames(db: Db, file: string): void {
  if (!existsSync(file)) return
  let parsed: Record<string, unknown> | null = null
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  } catch {
    return  // preserve corrupt file for forensic debugging
  }
  if (!parsed || typeof parsed !== 'object') return
  // INSERT OR IGNORE semantics on COALESCE: don't overwrite an existing
  // row's last_user_name — mw-identity may already have populated a fresher
  // value for live chats by the time backfill runs (cold start: identical;
  // warm start race: mw-identity wins).
  const insert = db.prepare(
    `INSERT INTO conversations (chat_id, mode_kind, mode_provider, mode_primary, last_user_name, updated_at)
     VALUES (?, 'solo', 'claude', NULL, ?, ?)
     ON CONFLICT(chat_id) DO UPDATE SET
       last_user_name = COALESCE(last_user_name, excluded.last_user_name)`,
  )
  const now = new Date().toISOString()
  db.transaction(() => {
    for (const [chatId, name] of Object.entries(parsed!)) {
      if (typeof name !== 'string' || !name) continue
      insert.run(chatId, name, now)
    }
  })()
  renameMigrated(file)
}

function maybeImportLegacy(db: Db, file: string): void {
  if (!existsSync(file)) return
  let parsed: LegacyShape | null = null
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8')) as LegacyShape
  } catch {
    return  // preserve corrupt file for forensic debugging
  }
  const conversations = parsed?.conversations
  if (conversations && typeof conversations === 'object') {
    const insert = db.prepare(
      'INSERT OR REPLACE INTO conversations(chat_id, mode_kind, mode_provider, mode_primary, updated_at) VALUES (?, ?, ?, ?, ?)',
    )
    const now = new Date().toISOString()
    db.transaction(() => {
      for (const [chatId, persisted] of Object.entries(conversations)) {
        const mode = persisted?.mode
        if (!mode || typeof mode !== 'object') continue
        const cols = modeColumns(mode)
        // Reject unknown mode kinds at the migration boundary so a legacy
        // file with mode_kind='solo' but no provider doesn't insert a
        // half-formed row that fails CHECK semantics later.
        if (cols.kind === 'solo' && !cols.provider) continue
        if (cols.kind === 'primary_tool' && !cols.primary) continue
        insert.run(chatId, cols.kind, cols.provider, cols.primary, now)
      }
    })()
  }
  renameMigrated(file)
}
