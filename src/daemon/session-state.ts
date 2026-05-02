/**
 * Per-bot session state tracker.
 *
 * Backed by the daemon's SQLite db (PR7 — moved off
 * ~/.claude/channels/wechat/session-state.json). State survives daemon
 * restart so an expired bot stays flagged even if we don't immediately
 * get around to cleaning it up. Read by the admin /health command
 * (pull-based); no proactive push on expiry (decision 2026-04-24).
 *
 * Migration: when constructed with a `migrateFromFile` opt and the legacy
 * JSON file exists, rows are inserted (REPLACE-on-conflict) and the file
 * is renamed to `<file>.migrated`. Idempotent: subsequent boots skip the
 * import because the file is gone. The .migrated suffix is kept around
 * one release so a downgrade can recover; we delete it in the next major.
 */
import { existsSync, readFileSync, renameSync } from 'node:fs'
import type { Db } from '../lib/db'

export interface BotSessionState {
  status: 'expired'
  first_seen_expired_at: string  // ISO 8601
  last_reason?: string           // e.g. 'ilink/getupdates errcode=-14'
}

export interface ExpiredBot {
  id: string
  first_seen_expired_at: string
  last_reason?: string
}

export interface SessionStateStore {
  /** Returns true iff this bot has been flagged expired. */
  isExpired(botId: string): boolean
  /** Flag a bot expired. Returns true on state transition, false if already expired. */
  markExpired(botId: string, reason?: string): boolean
  /** Enumerate currently-expired bots. */
  listExpired(): ExpiredBot[]
  /** Remove a bot's entry (e.g. after admin cleanup or a successful re-scan). */
  clear(botId: string): void
  /** No-op for SQLite-backed stores; retained so callers using the JSON-era API still compile. */
  flush(): Promise<void>
}

export interface SessionStateOpts {
  /**
   * Path to the legacy session-state.json. When set + the file exists,
   * its contents are imported into the SQLite table on construction and
   * the file is renamed to `<path>.migrated`.
   */
  migrateFromFile?: string
}

interface LegacyShape {
  version?: 1
  bots?: Record<string, BotSessionState>
}

export function makeSessionStateStore(db: Db, opts: SessionStateOpts = {}): SessionStateStore {
  if (opts.migrateFromFile) maybeImportLegacy(db, opts.migrateFromFile)

  const stmtIsExpired = db.query<{ first_seen_expired_at: string }, [string]>(
    'SELECT first_seen_expired_at FROM session_state WHERE bot_id = ?',
  )
  const stmtInsert = db.query<unknown, [string, string, string | null]>(
    'INSERT OR IGNORE INTO session_state(bot_id, first_seen_expired_at, last_reason) VALUES (?, ?, ?)',
  )
  const stmtList = db.query<{ bot_id: string; first_seen_expired_at: string; last_reason: string | null }, []>(
    'SELECT bot_id, first_seen_expired_at, last_reason FROM session_state ORDER BY first_seen_expired_at ASC',
  )
  const stmtDelete = db.query<unknown, [string]>('DELETE FROM session_state WHERE bot_id = ?')

  return {
    isExpired(botId) {
      return stmtIsExpired.get(botId) !== null
    },

    markExpired(botId, reason) {
      const ts = new Date().toISOString()
      const result = stmtInsert.run(botId, ts, reason ?? null)
      // changes === 1 → row inserted (transition); 0 → row already existed (idempotent).
      return (result.changes ?? 0) > 0
    },

    listExpired() {
      const rows = stmtList.all()
      return rows.map(r => ({
        id: r.bot_id,
        first_seen_expired_at: r.first_seen_expired_at,
        ...(r.last_reason !== null ? { last_reason: r.last_reason } : {}),
      }))
    },

    clear(botId) {
      stmtDelete.run(botId)
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
    // Corrupt JSON — preserve the original on disk for forensic debugging
    // by NOT renaming. Returning here means we'll re-attempt import on
    // next boot, which is harmless if the file remains corrupt.
    return
  }
  const bots = parsed?.bots
  if (bots && typeof bots === 'object') {
    const insert = db.prepare(
      'INSERT OR REPLACE INTO session_state(bot_id, first_seen_expired_at, last_reason) VALUES (?, ?, ?)',
    )
    db.transaction(() => {
      for (const [id, state] of Object.entries(bots)) {
        if (state?.status === 'expired' && typeof state.first_seen_expired_at === 'string') {
          insert.run(id, state.first_seen_expired_at, state.last_reason ?? null)
        }
      }
    })()
  }
  renameSync(file, `${file}.migrated`)
}
