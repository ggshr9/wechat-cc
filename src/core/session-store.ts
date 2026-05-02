/**
 * session-store.ts — persistent (alias, provider) → session_id map for SDK resume.
 *
 * Daemon restarts drop the in-memory session pool; the first message per
 * alias cold-starts a fresh Claude Agent SDK session (~10s per Spike 1
 * data). This store remembers the last session_id per alias so spawn()
 * can call query({ resume: session_id }) and cut that to <3s.
 *
 * Backed by the daemon's SQLite db (PR7 — moved off
 * ~/.claude/channels/wechat/sessions.json). Single-table schema keyed
 * by (alias, provider), so a chat that flips between `claude` and
 * `codex` can keep both providers' resume points warm without one
 * clobbering the other.
 *
 * Provider tagging (RFC 03 P0): each row carries the provider that
 * created the session. session_id strings are NOT interchangeable
 * between `claude` and `codex` (Claude jsonl path vs Codex
 * `~/.codex/sessions/`), so passing the wrong one to spawn() fails the
 * resume. Records read from the legacy JSON without a provider field
 * are migrated as `provider='claude'` (matches the v0.x default).
 */
import { existsSync, readFileSync } from 'node:fs'
import { renameMigrated, type Db } from '../lib/db'

export type ProviderId = string  // open string per RFC 03 §3.3 (registry-driven)

export interface SessionRecord {
  session_id: string
  last_used_at: string  // ISO
  /**
   * Which agent provider produced this session_id. Always present in
   * SQLite-backed records. Optional in the type only because legacy
   * JSON readers used to default it to 'claude'; readers that need
   * a guaranteed value should treat it as required.
   */
  provider?: ProviderId
  summary?: string      // 1-line LLM summary, cached
  summary_updated_at?: string  // when summary was last refreshed
}

export interface SessionStore {
  /**
   * Returns the stored record for an alias. When `expectedProvider` is
   * given, only the row for that provider is considered (returns null
   * on miss). Without a provider arg, returns the most-recently-used
   * row across providers for the alias.
   */
  get(alias: string, expectedProvider?: ProviderId): SessionRecord | null
  set(alias: string, sessionId: string, provider: ProviderId): void
  setSummary(alias: string, summary: string): void
  delete(alias: string): void
  all(): Record<string, SessionRecord>
  flush(): Promise<void>
}

/** v0.x default — JSON records without `provider` belong to this. */
const LEGACY_PROVIDER: ProviderId = 'claude'

export interface SessionStoreOpts {
  /**
   * Path to the legacy sessions.json. When set + the file exists, its
   * contents are imported into the SQLite table on construction and
   * the file is renamed to `<path>.migrated`.
   */
  migrateFromFile?: string
}

interface LegacyShape {
  version?: 1
  sessions?: Record<string, {
    session_id: string
    last_used_at: string
    provider?: ProviderId
    summary?: string
    summary_updated_at?: string
  }>
}

interface Row {
  alias: string
  provider: string
  session_id: string
  last_used_at: string
  summary: string | null
  summary_updated_at: string | null
}

function rowToRecord(r: Row): SessionRecord {
  return {
    session_id: r.session_id,
    last_used_at: r.last_used_at,
    provider: r.provider,
    ...(r.summary !== null ? { summary: r.summary } : {}),
    ...(r.summary_updated_at !== null ? { summary_updated_at: r.summary_updated_at } : {}),
  }
}

export function makeSessionStore(db: Db, opts: SessionStoreOpts = {}): SessionStore {
  if (opts.migrateFromFile) maybeImportLegacy(db, opts.migrateFromFile)

  const stmtGetExact = db.query<Row, [string, string]>(
    'SELECT alias, provider, session_id, last_used_at, summary, summary_updated_at FROM sessions WHERE alias = ? AND provider = ?',
  )
  const stmtGetLatest = db.query<Row, [string]>(
    // Tiebreaker on rowid DESC: two rows inserted in the same millisecond
    // share an ISO timestamp; the later INSERT has a larger rowid, so it
    // wins. Without this, "latest" is non-deterministic for back-to-back
    // writes (which happens in tests + can happen in tight inbound bursts).
    'SELECT alias, provider, session_id, last_used_at, summary, summary_updated_at FROM sessions WHERE alias = ? ORDER BY last_used_at DESC, rowid DESC LIMIT 1',
  )
  const stmtUpsert = db.query<unknown, [string, string, string, string]>(
    'INSERT INTO sessions(alias, provider, session_id, last_used_at) VALUES (?, ?, ?, ?) ' +
    'ON CONFLICT(alias, provider) DO UPDATE SET session_id = excluded.session_id, last_used_at = excluded.last_used_at',
  )
  const stmtBumpTs = db.query<unknown, [string, string, string]>(
    'UPDATE sessions SET last_used_at = ? WHERE alias = ? AND provider = ?',
  )
  const stmtSetSummary = db.query<unknown, [string, string, string, string]>(
    'UPDATE sessions SET summary = ?, summary_updated_at = ? WHERE alias = ? AND provider = ?',
  )
  const stmtDeleteAlias = db.query<unknown, [string]>('DELETE FROM sessions WHERE alias = ?')
  const stmtAll = db.query<Row, []>(
    'SELECT alias, provider, session_id, last_used_at, summary, summary_updated_at FROM sessions ORDER BY alias, last_used_at DESC, rowid DESC',
  )

  return {
    get(alias, expectedProvider) {
      const row = expectedProvider
        ? stmtGetExact.get(alias, expectedProvider)
        : stmtGetLatest.get(alias)
      return row ? rowToRecord(row) : null
    },

    set(alias, sessionId, provider) {
      const now = new Date().toISOString()
      const existing = stmtGetExact.get(alias, provider)
      if (existing && existing.session_id === sessionId) {
        // Same session_id under same provider — just bump timestamp.
        stmtBumpTs.run(now, alias, provider)
      } else {
        stmtUpsert.run(alias, provider, sessionId, now)
      }
    },

    setSummary(alias, summary) {
      // No provider arg → target the most-recent row for the alias
      // (matches the legacy single-record-per-alias semantic).
      const target = stmtGetLatest.get(alias)
      if (!target) return
      const now = new Date().toISOString()
      stmtSetSummary.run(summary, now, alias, target.provider)
    },

    delete(alias) {
      // Remove ALL provider rows for this alias — `delete` is intended
      // as "forget this chat entirely".
      stmtDeleteAlias.run(alias)
    },

    all() {
      // Returns Record<alias, SessionRecord>. When an alias has rows
      // for both claude + codex, the more-recently-used row wins
      // (preserves legacy behavior where there was at most one record
      // per alias). Callers that need both rows can query the db
      // directly — this surface is for the legacy callers that
      // assumed alias-keyed snapshot.
      const out: Record<string, SessionRecord> = {}
      for (const r of stmtAll.all()) {
        if (!(r.alias in out)) out[r.alias] = rowToRecord(r)
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
    // Corrupt JSON — preserve the original on disk for forensic debugging.
    return
  }
  const sessions = parsed?.sessions
  if (sessions && typeof sessions === 'object') {
    const insert = db.prepare(
      'INSERT OR REPLACE INTO sessions(alias, provider, session_id, last_used_at, summary, summary_updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    db.transaction(() => {
      for (const [alias, rec] of Object.entries(sessions)) {
        if (!rec || typeof rec.session_id !== 'string' || typeof rec.last_used_at !== 'string') continue
        insert.run(
          alias,
          rec.provider ?? LEGACY_PROVIDER,
          rec.session_id,
          rec.last_used_at,
          rec.summary ?? null,
          rec.summary_updated_at ?? null,
        )
      }
    })()
  }
  renameMigrated(file)
}
