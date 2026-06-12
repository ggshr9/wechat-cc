/**
 * messages store — canonical per-chat conversation log (spec D4).
 * Written by mw-messages (inbound) + ilink-glue (outbound) + backfill.
 * Read by `wechat-cc dialogue *` CLI and the threads extractor.
 */
import type { Db } from './db'

export type MessageDirection = 'in' | 'out'

export interface MessageRecord {
  id: string
  chatId: string
  ts: string
  direction: MessageDirection
  kind: string          // text | image | file | voice | command
  text: string
  provider?: string
  source: string        // live | backfill:claude | backfill:codex
}

export interface ListRangeOpts {
  limit: number
  /** Last `limit` rows strictly BEFORE this ts, ascending — upward paging. Omitted = newest page. */
  beforeTs?: string
}

export interface MessagesStore {
  append(rec: MessageRecord): Promise<void>
  listRange(chatId: string, opts: ListRangeOpts): Promise<MessageRecord[]>
  search(chatId: string, query: string, limit: number): Promise<MessageRecord[]>
  latestTs(chatId: string): Promise<string | null>
  /** Extractor input: all messages after a watermark, ascending. */
  listSince(chatId: string, sinceTs: string, limit: number): Promise<MessageRecord[]>
}

export function inboundMessageId(userId: string, createTimeMs: number): string {
  return `${userId}:${createTimeMs}`
}

interface Row {
  id: string; chat_id: string; ts: string; direction: string
  kind: string; text: string; provider: string | null; source: string
}

function rowToRecord(r: Row): MessageRecord {
  return {
    id: r.id, chatId: r.chat_id, ts: r.ts,
    direction: r.direction as MessageDirection,
    kind: r.kind, text: r.text, source: r.source,
    ...(r.provider !== null ? { provider: r.provider } : {}),
  }
}

export function makeMessagesStore(db: Db): MessagesStore {
  const stmtInsert = db.query<unknown, [string, string, string, string, string, string, string | null, string]>(
    `INSERT OR IGNORE INTO messages(id, chat_id, ts, direction, kind, text, provider, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const stmtListNewest = db.query<Row, [string, number]>(
    `SELECT * FROM (
       SELECT * FROM messages WHERE chat_id = ? ORDER BY ts DESC LIMIT ?
     ) ORDER BY ts ASC`,
  )
  const stmtListBeforeTs = db.query<Row, [string, string, number]>(
    `SELECT * FROM (
       SELECT * FROM messages WHERE chat_id = ? AND ts < ? ORDER BY ts DESC LIMIT ?
     ) ORDER BY ts ASC`,
  )
  const stmtSearch = db.query<Row, [string, string, number]>(
    `SELECT * FROM messages WHERE chat_id = ? AND text LIKE '%' || ? || '%'
     ORDER BY ts DESC LIMIT ?`,
  )
  const stmtLatestTs = db.query<{ ts: string }, [string]>(
    'SELECT ts FROM messages WHERE chat_id = ? ORDER BY ts DESC LIMIT 1',
  )
  const stmtListSince = db.query<Row, [string, string, number]>(
    'SELECT * FROM messages WHERE chat_id = ? AND ts > ? ORDER BY ts ASC LIMIT ?',
  )

  return {
    async append(rec) {
      stmtInsert.run(rec.id, rec.chatId, rec.ts, rec.direction, rec.kind, rec.text, rec.provider ?? null, rec.source)
    },
    async listRange(chatId, opts) {
      const rows = opts.beforeTs
        ? stmtListBeforeTs.all(chatId, opts.beforeTs, opts.limit)
        : stmtListNewest.all(chatId, opts.limit)
      return rows.map(rowToRecord)
    },
    async search(chatId, query, limit) {
      return stmtSearch.all(chatId, query, limit).map(rowToRecord)
    },
    async latestTs(chatId) {
      return stmtLatestTs.get(chatId)?.ts ?? null
    },
    async listSince(chatId, sinceTs, limit) {
      return stmtListSince.all(chatId, sinceTs, limit).map(rowToRecord)
    },
  }
}
