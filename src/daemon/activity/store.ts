/**
 * Per-chat daily activity tracker. One row per (chat_id, UTC date) with
 * first message timestamp + count. Detector reads recentDays(7) to
 * evaluate the 7-day-streak milestone.
 *
 * Backed by the daemon's SQLite db (PR7 — moved off
 * <stateRoot>/<chat>/activity.jsonl). recordInbound is a single
 * INSERT…ON CONFLICT DO UPDATE — atomic per row, no read-modify-write.
 */
import { existsSync, readFileSync } from 'node:fs'
import { renameMigrated, type Db } from '../../lib/db'

export interface ActivityRecord {
  date: string                // YYYY-MM-DD UTC
  first_msg_ts: string        // ISO
  msg_count: number
}

export interface ActivityStore {
  recordInbound(when: Date): Promise<void>
  recentDays(n: number): Promise<ActivityRecord[]>
}

export interface ActivityStoreOpts {
  /** Legacy <stateRoot>/<chatId>/activity.jsonl. Imported on first construction. */
  migrateFromFile?: string
}

function utcDateKey(d: Date): string {
  return d.toISOString().slice(0, 10)
}

interface Row {
  date: string
  first_msg_ts: string
  msg_count: number
}

export function makeActivityStore(db: Db, chatId: string, opts: ActivityStoreOpts = {}): ActivityStore {
  if (opts.migrateFromFile) maybeImportLegacy(db, chatId, opts.migrateFromFile)

  // INSERT…ON CONFLICT keeps the existing first_msg_ts (we want the very
  // first message of the day) and increments msg_count by 1. Atomic.
  const stmtRecord = db.query<unknown, [string, string, string]>(
    'INSERT INTO activity(chat_id, date, first_msg_ts, msg_count) VALUES (?, ?, ?, 1) ' +
    'ON CONFLICT(chat_id, date) DO UPDATE SET msg_count = msg_count + 1',
  )
  const stmtRecent = db.query<Row, [string, string]>(
    'SELECT date, first_msg_ts, msg_count FROM activity WHERE chat_id = ? AND date >= ? ORDER BY date ASC',
  )

  return {
    async recordInbound(when) {
      stmtRecord.run(chatId, utcDateKey(when), when.toISOString())
    },

    async recentDays(n) {
      const cutoff = new Date(Date.now() - n * 86400_000)
      const cutoffKey = utcDateKey(cutoff)
      return stmtRecent.all(chatId, cutoffKey).map(r => ({
        date: r.date,
        first_msg_ts: r.first_msg_ts,
        msg_count: r.msg_count,
      }))
    },
  }
}

function maybeImportLegacy(db: Db, chatId: string, file: string): void {
  if (!existsSync(file)) return
  let content: string
  try {
    content = readFileSync(file, 'utf8')
  } catch {
    return
  }
  const records: ActivityRecord[] = []
  for (const line of content.split('\n')) {
    if (line.length === 0) continue
    try {
      const r = JSON.parse(line) as ActivityRecord
      if (typeof r.date === 'string' && typeof r.first_msg_ts === 'string' && typeof r.msg_count === 'number') {
        records.push(r)
      }
    } catch { /* skip malformed line */ }
  }
  // INSERT OR REPLACE — re-running the migration shouldn't double the
  // count. (Idempotency comes from the .migrated rename, but a partial
  // failure could leave the file in place; this keeps that recoverable.)
  const insert = db.prepare(
    'INSERT OR REPLACE INTO activity(chat_id, date, first_msg_ts, msg_count) VALUES (?, ?, ?, ?)',
  )
  db.transaction(() => {
    for (const r of records) insert.run(chatId, r.date, r.first_msg_ts, r.msg_count)
  })()
  renameMigrated(file)
}
