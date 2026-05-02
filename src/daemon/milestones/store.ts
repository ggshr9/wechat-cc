/**
 * Milestones — append-only with id-level dedup. Each kind of milestone
 * (e.g. ms_100msg, ms_first_handoff) fires at most once per chat. Caller
 * passes a stable id; we let SQLite enforce uniqueness via the
 * (chat_id, id) PK.
 *
 * Backed by the daemon's SQLite db (PR7 — moved off
 * <stateRoot>/<chat>/milestones.jsonl). The dedup logic is now an
 * INSERT…ON CONFLICT DO NOTHING returning whether changes > 0 — atomic
 * single statement instead of read-then-write.
 */
import { existsSync, readFileSync } from 'node:fs'
import { renameMigrated, type Db } from '../../lib/db'

export interface MilestoneRecord {
  id: string                  // ms_<kind> — caller-supplied stable
  ts: string                  // ISO
  body: string
  event_id?: string           // back-pointer to events table
}

export interface MilestonesStore {
  /**
   * Returns true if this is the first time the id fires (record written),
   * false if it was already recorded (no write).
   */
  fire(rec: Omit<MilestoneRecord, 'ts'>): Promise<boolean>
  list(): Promise<MilestoneRecord[]>
}

export interface MilestonesStoreOpts {
  /** Legacy <stateRoot>/<chatId>/milestones.jsonl. Imported on first construction. */
  migrateFromFile?: string
}

interface Row {
  id: string
  ts: string
  body: string
  event_id: string | null
}

function rowToRecord(r: Row): MilestoneRecord {
  return {
    id: r.id,
    ts: r.ts,
    body: r.body,
    ...(r.event_id !== null ? { event_id: r.event_id } : {}),
  }
}

export function makeMilestonesStore(db: Db, chatId: string, opts: MilestonesStoreOpts = {}): MilestonesStore {
  if (opts.migrateFromFile) maybeImportLegacy(db, chatId, opts.migrateFromFile)

  const stmtFire = db.query<unknown, [string, string, string, string, string | null]>(
    'INSERT INTO milestones(chat_id, id, ts, body, event_id) VALUES (?, ?, ?, ?, ?) ' +
    'ON CONFLICT(chat_id, id) DO NOTHING',
  )
  const stmtList = db.query<Row, [string]>(
    // ORDER BY ts ASC matches the legacy jsonl read order (append-order = fire-order).
    // Tiebreaker on rowid keeps results stable when two milestones share an ISO timestamp.
    'SELECT id, ts, body, event_id FROM milestones WHERE chat_id = ? ORDER BY ts ASC, rowid ASC',
  )

  return {
    async fire(rec) {
      const result = stmtFire.run(chatId, rec.id, new Date().toISOString(), rec.body, rec.event_id ?? null)
      return (result.changes ?? 0) > 0
    },

    async list() {
      return stmtList.all(chatId).map(rowToRecord)
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
  const records: MilestoneRecord[] = []
  for (const line of content.split('\n')) {
    if (line.length === 0) continue
    try {
      const r = JSON.parse(line) as MilestoneRecord
      if (typeof r.id === 'string' && typeof r.ts === 'string' && typeof r.body === 'string') {
        records.push(r)
      }
    } catch { /* skip malformed line */ }
  }
  // INSERT OR IGNORE: re-running migration shouldn't overwrite an existing
  // milestone (milestones are permanent; the first ts wins).
  const insert = db.prepare(
    'INSERT OR IGNORE INTO milestones(chat_id, id, ts, body, event_id) VALUES (?, ?, ?, ?, ?)',
  )
  db.transaction(() => {
    for (const r of records) insert.run(chatId, r.id, r.ts, r.body, r.event_id ?? null)
  })()
  renameMigrated(file)
}
