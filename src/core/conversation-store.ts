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
}

export interface ConversationStoreOpts {
  migrateFromFile?: string
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

  const stmtGet = db.query<Row, [string]>(
    'SELECT chat_id, mode_kind, mode_provider, mode_primary FROM conversations WHERE chat_id = ?',
  )
  const stmtUpsert = db.query<unknown, [string, string, string | null, string | null, string]>(
    'INSERT INTO conversations(chat_id, mode_kind, mode_provider, mode_primary, updated_at) VALUES (?, ?, ?, ?, ?) ' +
    'ON CONFLICT(chat_id) DO UPDATE SET mode_kind = excluded.mode_kind, mode_provider = excluded.mode_provider, mode_primary = excluded.mode_primary, updated_at = excluded.updated_at',
  )
  const stmtDelete = db.query<unknown, [string]>('DELETE FROM conversations WHERE chat_id = ?')
  const stmtAll = db.query<Row, []>(
    'SELECT chat_id, mode_kind, mode_provider, mode_primary FROM conversations',
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
  }
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
