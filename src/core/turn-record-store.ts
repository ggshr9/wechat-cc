/**
 * turn_records store — per-turn outcome log for daemon observability,
 * backed by the SQLite turn_records table (migration v15).
 *
 * One row per dispatched turn: solo dispatch, each /both participant, each
 * /chat speaker turn (the coordinator's `recordTurn` sink writes here). The
 * AI-/human-legible answer to "why did chat X stop replying at HH:MM" — a
 * query, not a log grep — and unlike an in-memory ring it survives the
 * daemon restart that a hang/crash triggers, so the failing turn is still
 * there to read afterward.
 *
 * Pure persistence; no control-flow side effects. internal-api's
 * `GET /v1/turns` reads via recentForChat / recent.
 */
import type { Db } from '../lib/db'
import type { TurnRecord } from './conversation-coordinator'

/** Error strings are truncated to this many chars before persisting — a
 *  runaway error (stack dump, huge tool output) shouldn't bloat the row. */
const MAX_ERROR = 8192

/** Per-chat retention. On append we prune each chat back to its newest N
 *  rows so the table stays bounded under a long-lived, chatty daemon while
 *  keeping enough history to diagnose a recent wedge. */
export const TURN_RECORDS_MAX_PER_CHAT = 200

/** A persisted TurnRecord — the coordinator's TurnRecord plus the row id. */
export interface StoredTurnRecord extends TurnRecord {
  id: string
}

export interface TurnRecordStore {
  append(record: TurnRecord): void
  /** Newest-first, capped at `limit`, for one chat. */
  recentForChat(chatId: string, limit: number): readonly StoredTurnRecord[]
  /** Newest-first across all chats, capped at `limit`. */
  recent(limit: number): readonly StoredTurnRecord[]
}

interface Row {
  id: string
  chat_id: string
  provider: string
  alias: string
  mode: string
  started_at: number
  ended_at: number
  duration_ms: number
  outcome: string
  reply_tool_called: number
  text_chunks: number
  error: string | null
}

const SELECT_COLS =
  'id, chat_id, provider, alias, mode, started_at, ended_at, duration_ms, outcome, reply_tool_called, text_chunks, error'

function toRecord(r: Row): StoredTurnRecord {
  return {
    id: r.id,
    chatId: r.chat_id,
    provider: r.provider as TurnRecord['provider'],
    alias: r.alias,
    mode: r.mode as TurnRecord['mode'],
    startedAt: r.started_at,
    endedAt: r.ended_at,
    durationMs: r.duration_ms,
    outcome: r.outcome as TurnRecord['outcome'],
    replyToolCalled: r.reply_tool_called !== 0,
    textChunks: r.text_chunks,
    ...(r.error != null ? { error: r.error } : {}),
  }
}

export function makeTurnRecordStore(db: Db): TurnRecordStore {
  const stmtAppend = db.query<unknown, [string, string, string, string, string, string, number, number, number, string, number, number, string | null]>(
    `INSERT INTO turn_records(id, ts, chat_id, provider, alias, mode, started_at, ended_at, duration_ms, outcome, reply_tool_called, text_chunks, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  // Keep only the newest N rows for the just-appended chat. ended_at then
  // rowid as the tiebreak mirrors the read ordering, so a prune never drops a
  // row a same-ms recent() would still return.
  const stmtPrune = db.query<unknown, [string, string, number]>(
    `DELETE FROM turn_records
       WHERE chat_id = ?
         AND id NOT IN (
           SELECT id FROM turn_records WHERE chat_id = ?
           ORDER BY ended_at DESC, rowid DESC LIMIT ?
         )`,
  )
  const stmtRecentForChat = db.query<Row, [string, number]>(
    `SELECT ${SELECT_COLS} FROM turn_records WHERE chat_id = ? ORDER BY ended_at DESC, rowid DESC LIMIT ?`,
  )
  const stmtRecent = db.query<Row, [number]>(
    `SELECT ${SELECT_COLS} FROM turn_records ORDER BY ended_at DESC, rowid DESC LIMIT ?`,
  )

  return {
    append(record) {
      const id = crypto.randomUUID()
      const ts = new Date(record.endedAt).toISOString()
      const error = record.error != null && record.error.length > MAX_ERROR
        ? record.error.slice(0, MAX_ERROR)
        : (record.error ?? null)
      stmtAppend.run(
        id, ts, record.chatId, record.provider, record.alias, record.mode,
        record.startedAt, record.endedAt, record.durationMs, record.outcome,
        record.replyToolCalled ? 1 : 0, record.textChunks, error,
      )
      stmtPrune.run(record.chatId, record.chatId, TURN_RECORDS_MAX_PER_CHAT)
    },
    recentForChat(chatId, limit) {
      return stmtRecentForChat.all(chatId, limit).map(toRecord)
    },
    recent(limit) {
      return stmtRecent.all(limit).map(toRecord)
    },
  }
}
