/**
 * observations store + archive split.
 *
 * Active observations are written by the introspect cron and shown at the
 * top of the memory pane. Two ways an observation leaves the active set:
 *   1. age > ttlDays (default 30) → still in db, just filtered out
 *   2. user explicitly archives → archived flag flipped, archived_at set
 *
 * Backed by the daemon's SQLite db (PR7 — moved off
 * <stateRoot>/<chat>/observations.jsonl). archive() is now a
 * single-statement UPDATE — no more read-modify-rewrite of the whole
 * file (which used to be the only thing that could race with append()).
 */
import { existsSync, readFileSync, renameSync } from 'node:fs'
import type { Db } from '../../lib/db'

export type ObservationTone = 'concern' | 'curious' | 'proud' | 'playful' | 'quiet'

export interface ObservationRecord {
  id: string
  ts: string
  body: string
  tone?: ObservationTone
  archived: boolean
  archived_at?: string
  event_id?: string
}

export interface ObservationsStore {
  append(rec: Omit<ObservationRecord, 'id' | 'ts' | 'archived'> & { archived?: boolean }): Promise<string>
  /**
   * @internal Test seam — accepts a fully-formed record (id, ts, archived
   * all caller-supplied). Production code should use append() which
   * generates id + ts.
   */
  appendRaw(rec: ObservationRecord): Promise<void>
  listActive(): Promise<ObservationRecord[]>
  listArchived(): Promise<ObservationRecord[]>
  archive(id: string): Promise<void>
}

export interface ObservationsOpts {
  /** Default 30. Items older than this are filtered out of listActive. */
  ttlDays?: number
  /** Legacy <stateRoot>/<chatId>/observations.jsonl. Imported on first construction. */
  migrateFromFile?: string
}

interface Row {
  id: string
  ts: string
  body: string
  tone: string | null
  archived: number
  archived_at: string | null
  event_id: string | null
}

function rowToRecord(r: Row): ObservationRecord {
  return {
    id: r.id,
    ts: r.ts,
    body: r.body,
    archived: r.archived !== 0,
    ...(r.tone !== null ? { tone: r.tone as ObservationTone } : {}),
    ...(r.archived_at !== null ? { archived_at: r.archived_at } : {}),
    ...(r.event_id !== null ? { event_id: r.event_id } : {}),
  }
}

function newObsId(): string {
  return `obs_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`
}

export function makeObservationsStore(db: Db, chatId: string, opts: ObservationsOpts = {}): ObservationsStore {
  const ttlDays = opts.ttlDays ?? 30
  if (opts.migrateFromFile) maybeImportLegacy(db, chatId, opts.migrateFromFile)

  const stmtInsert = db.query<unknown, [string, string, string, string, string | null, number, string | null]>(
    'INSERT INTO observations(id, chat_id, ts, body, tone, archived, event_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
  const stmtUpsertRaw = db.query<unknown, [string, string, string, string, string | null, number, string | null, string | null]>(
    'INSERT OR REPLACE INTO observations(id, chat_id, ts, body, tone, archived, archived_at, event_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  )
  // listActive: not archived AND ts >= cutoff. cutoff is computed in app
  // code (string compare on ISO timestamps works because they're
  // lexicographic-sortable).
  const stmtListActive = db.query<Row, [string, string]>(
    'SELECT id, ts, body, tone, archived, archived_at, event_id FROM observations ' +
    'WHERE chat_id = ? AND archived = 0 AND ts >= ? ORDER BY ts ASC, rowid ASC',
  )
  const stmtListArchived = db.query<Row, [string]>(
    'SELECT id, ts, body, tone, archived, archived_at, event_id FROM observations ' +
    'WHERE chat_id = ? AND archived = 1 ORDER BY ts ASC, rowid ASC',
  )
  const stmtArchive = db.query<unknown, [string, string, string]>(
    'UPDATE observations SET archived = 1, archived_at = ? WHERE chat_id = ? AND id = ?',
  )

  return {
    async append(rec) {
      const id = newObsId()
      stmtInsert.run(
        id,
        chatId,
        new Date().toISOString(),
        rec.body,
        rec.tone ?? null,
        rec.archived ? 1 : 0,
        rec.event_id ?? null,
      )
      return id
    },

    async appendRaw(rec) {
      stmtUpsertRaw.run(
        rec.id,
        chatId,
        rec.ts,
        rec.body,
        rec.tone ?? null,
        rec.archived ? 1 : 0,
        rec.archived_at ?? null,
        rec.event_id ?? null,
      )
    },

    async listActive() {
      const cutoff = new Date(Date.now() - ttlDays * 24 * 60 * 60 * 1000).toISOString()
      return stmtListActive.all(chatId, cutoff).map(rowToRecord)
    },

    async listArchived() {
      return stmtListArchived.all(chatId).map(rowToRecord)
    },

    async archive(id) {
      stmtArchive.run(new Date().toISOString(), chatId, id)
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
  const records: ObservationRecord[] = []
  for (const line of content.split('\n')) {
    if (line.length === 0) continue
    try {
      const r = JSON.parse(line) as ObservationRecord
      if (typeof r.id === 'string' && typeof r.ts === 'string' && typeof r.body === 'string') {
        records.push(r)
      }
    } catch { /* skip malformed line */ }
  }
  // INSERT OR REPLACE — re-running migration overwrites with the disk
  // contents; the disk file is the source of truth for migration. Last
  // call wins on archived flag too (which is correct: the file's state
  // reflects the final archive status when it was written).
  const insert = db.prepare(
    'INSERT OR REPLACE INTO observations(id, chat_id, ts, body, tone, archived, archived_at, event_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  )
  db.transaction(() => {
    for (const r of records) {
      insert.run(
        r.id,
        chatId,
        r.ts,
        r.body,
        r.tone ?? null,
        r.archived ? 1 : 0,
        r.archived_at ?? null,
        r.event_id ?? null,
      )
    }
  })()
  renameSync(file, `${file}.migrated`)
}
