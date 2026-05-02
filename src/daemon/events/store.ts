/**
 * Append-only events table per chat. Records what the introspect cron
 * decided (push / skip / observation_written / milestone). Read by the
 * dashboard's "Claude 的最近决策" folded section + by the introspect cron
 * itself (to avoid repeating the same observation on consecutive ticks).
 *
 * Backed by the daemon's SQLite db (PR7 — moved off
 * <stateRoot>/<chat>/events.jsonl). The PIPE_BUF interleave / partial
 * line concerns the legacy jsonl had don't apply to SQLite — every
 * append is a single transactional INSERT.
 *
 * The reasoning + push_text caps stay (2KB / 1KB) so an unusually long
 * agent reasoning doesn't bloat the row. They're application-level
 * truncation; the SQLite TEXT type itself has no fixed cap.
 */
import { existsSync, readFileSync, renameSync } from 'node:fs'
import type { Db } from '../../lib/db'

export type EventKind =
  | 'cron_eval_pushed'
  | 'cron_eval_skipped'
  | 'cron_eval_failed'
  | 'observation_written'
  | 'milestone'

export interface EventRecord {
  id: string                       // evt_<random>
  ts: string                       // ISO 8601
  kind: EventKind
  trigger: string                  // e.g. 'daily-checkin', 'weekly-introspect'
  reasoning: string                // Claude's stated rationale
  push_text?: string               // for cron_eval_pushed
  observation_id?: string          // for observation_written
  milestone_id?: string            // for milestone
  jsonl_session_id?: string        // for cron_eval_pushed (which session got the message)
}

export interface EventsStore {
  append(rec: Omit<EventRecord, 'id' | 'ts'>): Promise<string>  // returns generated id
  /**
   * @internal Test seam — accepts a fully-formed record (id + ts caller-
   * supplied). Production code should use append() which generates id + ts.
   * Used by demo seeding to write records with stable evt_demo_* ids so
   * unseed can target them by id prefix.
   */
  appendRaw(rec: EventRecord): Promise<void>
  list(opts?: { limit?: number; since?: string }): Promise<EventRecord[]>
}

export interface EventsStoreOpts {
  /** Legacy <stateRoot>/<chatId>/events.jsonl. Imported on first construction. */
  migrateFromFile?: string
}

const REASONING_MAX = 2048
// push_text cap is the message Claude pushed to the user. Kept from the
// jsonl era to keep typical rows small; SQLite has no functional reason
// to clamp here, but smaller rows = faster index scans for the
// "last N decisions" query.
const PUSH_TEXT_MAX = 1024

function newEventId(): string {
  return `evt_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`
}

interface Row {
  id: string
  ts: string
  kind: string
  trigger: string
  reasoning: string
  push_text: string | null
  observation_id: string | null
  milestone_id: string | null
  jsonl_session_id: string | null
}

function rowToRecord(r: Row): EventRecord {
  return {
    id: r.id,
    ts: r.ts,
    kind: r.kind as EventKind,
    trigger: r.trigger,
    reasoning: r.reasoning,
    ...(r.push_text !== null ? { push_text: r.push_text } : {}),
    ...(r.observation_id !== null ? { observation_id: r.observation_id } : {}),
    ...(r.milestone_id !== null ? { milestone_id: r.milestone_id } : {}),
    ...(r.jsonl_session_id !== null ? { jsonl_session_id: r.jsonl_session_id } : {}),
  }
}

export function makeEventsStore(db: Db, chatId: string, opts: EventsStoreOpts = {}): EventsStore {
  if (opts.migrateFromFile) maybeImportLegacy(db, chatId, opts.migrateFromFile)

  const stmtInsert = db.query<unknown, [string, string, string, string, string, string, string | null, string | null, string | null, string | null]>(
    'INSERT INTO events(id, chat_id, ts, kind, trigger, reasoning, push_text, observation_id, milestone_id, jsonl_session_id) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
  const stmtUpsertRaw = db.query<unknown, [string, string, string, string, string, string, string | null, string | null, string | null, string | null]>(
    'INSERT OR REPLACE INTO events(id, chat_id, ts, kind, trigger, reasoning, push_text, observation_id, milestone_id, jsonl_session_id) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
  // list() ascending by ts to match legacy jsonl read order (append-order =
  // chronological). limit applied at the call site (slice tail) so since
  // and limit can be combined predictably.
  const stmtListAll = db.query<Row, [string]>(
    'SELECT id, ts, kind, trigger, reasoning, push_text, observation_id, milestone_id, jsonl_session_id ' +
    'FROM events WHERE chat_id = ? ORDER BY ts ASC, rowid ASC',
  )
  const stmtListSince = db.query<Row, [string, string]>(
    'SELECT id, ts, kind, trigger, reasoning, push_text, observation_id, milestone_id, jsonl_session_id ' +
    'FROM events WHERE chat_id = ? AND ts >= ? ORDER BY ts ASC, rowid ASC',
  )

  function clamp(s: string, max: number): string {
    return s.length > max ? s.slice(0, max) + '…' : s
  }

  return {
    async append(rec) {
      const id = newEventId()
      const ts = new Date().toISOString()
      const reasoning = clamp(rec.reasoning, REASONING_MAX)
      const push_text = rec.push_text !== undefined ? clamp(rec.push_text, PUSH_TEXT_MAX) : null
      stmtInsert.run(
        id,
        chatId,
        ts,
        rec.kind,
        rec.trigger,
        reasoning,
        push_text,
        rec.observation_id ?? null,
        rec.milestone_id ?? null,
        rec.jsonl_session_id ?? null,
      )
      return id
    },

    async appendRaw(rec) {
      stmtUpsertRaw.run(
        rec.id,
        chatId,
        rec.ts,
        rec.kind,
        rec.trigger,
        rec.reasoning,
        rec.push_text ?? null,
        rec.observation_id ?? null,
        rec.milestone_id ?? null,
        rec.jsonl_session_id ?? null,
      )
    },

    async list(opts = {}) {
      const rows = opts.since
        ? stmtListSince.all(chatId, opts.since)
        : stmtListAll.all(chatId)
      const records = rows.map(rowToRecord)
      if (opts.limit !== undefined && opts.limit < records.length) {
        return records.slice(records.length - opts.limit)
      }
      return records
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
  const records: EventRecord[] = []
  for (const line of content.split('\n')) {
    if (line.length === 0) continue
    try {
      const r = JSON.parse(line) as EventRecord
      if (typeof r.id === 'string' && typeof r.ts === 'string' && typeof r.kind === 'string' && typeof r.reasoning === 'string') {
        records.push(r)
      }
    } catch { /* skip malformed line — same posture as legacy jsonl reader */ }
  }
  // INSERT OR IGNORE — events are append-only; if a row with the same
  // id is somehow already there, keep the original.
  const insert = db.prepare(
    'INSERT OR IGNORE INTO events(id, chat_id, ts, kind, trigger, reasoning, push_text, observation_id, milestone_id, jsonl_session_id) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
  db.transaction(() => {
    for (const r of records) {
      insert.run(
        r.id,
        chatId,
        r.ts,
        r.kind,
        r.trigger,
        r.reasoning,
        r.push_text ?? null,
        r.observation_id ?? null,
        r.milestone_id ?? null,
        r.jsonl_session_id ?? null,
      )
    }
  })()
  renameSync(file, `${file}.migrated`)
}
