/**
 * messages store — canonical per-chat conversation log (spec D4).
 * Written by mw-messages (inbound) + ilink-glue (outbound) + backfill.
 * Read by `wechat-cc dialogue *` CLI and the threads extractor.
 */
import { createHash } from 'node:crypto'
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
  /** Returns the number of rows actually inserted (0 if ignored by INSERT OR IGNORE). */
  append(rec: MessageRecord): Promise<number>
  listRange(chatId: string, opts: ListRangeOpts): Promise<MessageRecord[]>
  search(chatId: string, query: string, limit: number): Promise<MessageRecord[]>
  latestTs(chatId: string): Promise<string | null>
  /** Extractor input: all messages after a watermark, ascending. */
  listSince(chatId: string, sinceTs: string, limit: number): Promise<MessageRecord[]>
  /** List distinct chat_ids that have at least one message. */
  listChatIds(): Promise<string[]>
}

export function inboundMessageId(userId: string, createTimeMs: number): string {
  return `${userId}:${createTimeMs}`
}

/**
 * Stable content-keyed id for messages where ilink provides no create_time_ms
 * (normalised to 0 by the poll loop). Using receivedAtMs for dedup would give
 * each at-least-once redelivery a different id → duplicate rows. Instead we
 * derive a deterministic id from the message content so redeliveries collapse.
 *
 * Format: `${userId}:0:<first 12 hex chars of sha256(text)>`
 */
export function inboundFallbackMessageId(userId: string, text: string): string {
  const hash = createHash('sha256').update(text).digest('hex').slice(0, 12)
  return `${userId}:0:${hash}`
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
  const stmtInsert = db.query<{ changes: number }, [string, string, string, string, string, string, string | null, string]>(
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
    `SELECT * FROM messages WHERE chat_id = ? AND text LIKE '%' || ? || '%' ESCAPE '\\'
     ORDER BY ts DESC LIMIT ?`,
  )
  const stmtLatestTs = db.query<{ ts: string }, [string]>(
    'SELECT ts FROM messages WHERE chat_id = ? ORDER BY ts DESC LIMIT 1',
  )
  const stmtListSince = db.query<Row, [string, string, number]>(
    'SELECT * FROM messages WHERE chat_id = ? AND ts > ? ORDER BY ts ASC LIMIT ?',
  )
  const stmtListChatIds = db.query<{ chat_id: string }, []>(
    'SELECT DISTINCT chat_id FROM messages',
  )

  /**
   * Escape LIKE metacharacters so literal '%', '_', '\' in the query string
   * are matched as-is rather than as wildcards or escape characters.
   */
  function escapeLike(q: string): string {
    return q.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
  }

  return {
    async append(rec) {
      const result = stmtInsert.run(rec.id, rec.chatId, rec.ts, rec.direction, rec.kind, rec.text, rec.provider ?? null, rec.source)
      return (result as unknown as { changes: number }).changes
    },
    async listRange(chatId, opts) {
      const rows = opts.beforeTs
        ? stmtListBeforeTs.all(chatId, opts.beforeTs, opts.limit)
        : stmtListNewest.all(chatId, opts.limit)
      return rows.map(rowToRecord)
    },
    async search(chatId, query, limit) {
      return stmtSearch.all(chatId, escapeLike(query), limit).map(rowToRecord)
    },
    async latestTs(chatId) {
      return stmtLatestTs.get(chatId)?.ts ?? null
    },
    async listSince(chatId, sinceTs, limit) {
      return stmtListSince.all(chatId, sinceTs, limit).map(rowToRecord)
    },
    async listChatIds() {
      return stmtListChatIds.all().map(r => r.chat_id)
    },
  }
}
