/**
 * Threads store — topic threads extracted from conversation history.
 *
 * Each thread represents a recurring topic in a chat (e.g. "compass 排产",
 * "stock watchlist"). Threads have:
 *   - facets: lens labels (task | knowledge | life) — can be multi-valued
 *   - tags: free-form user-visible labels, vocabulary shared across chats
 *   - episodes: message time ranges that belong to this thread
 *   - private: independently toggleable visibility flag
 *   - status: active | dormant | done lifecycle
 *
 * thread_extract_state tracks the watermark up to which messages have been
 * processed by the LLM extraction job (Tasks 7/8), so each run is
 * incremental rather than full-scan.
 *
 * House pattern: src/daemon/observations/store.ts
 */
import type { Db } from './db'

export type Facet = 'task' | 'knowledge' | 'life'
export type ThreadStatus = 'active' | 'dormant' | 'done'

export interface Episode {
  from_ts: string
  to_ts: string
}

export interface ThreadRecord {
  id: string
  chatId: string
  title: string
  summary: string
  facets: Facet[]
  tags: string[]
  private: boolean
  status: ThreadStatus
  episodes: Episode[]
  createdTs: string
  lastActive: string
}

export type CreateThreadInput = Omit<ThreadRecord, 'id' | 'status' | 'createdTs' | 'lastActive'> & {
  status?: ThreadStatus
}

export type UpdateThreadInput = {
  title?: string
  summary?: string
  facets?: Facet[]
  tags?: string[]
  private?: boolean
  status?: ThreadStatus
  episodes?: Episode[]
  lastActive?: string
}

export interface ThreadsStore {
  create(input: CreateThreadInput): Promise<string>
  update(id: string, partial: UpdateThreadInput): Promise<void>
  list(chatId: string): Promise<ThreadRecord[]>
  get(id: string): Promise<ThreadRecord | null>
  tagVocabulary(n: number): Promise<string[]>
  getWatermark(chatId: string): Promise<string | null>
  setWatermark(chatId: string, ts: string): Promise<void>
}

interface ThreadRow {
  id: string
  chat_id: string
  title: string
  summary: string
  facets: string
  tags: string
  private: number
  status: string
  episodes: string
  created_ts: string
  last_active: string
}

/** Parse a JSON-array column defensively. A corrupt value (truncated write /
 *  manual DB edit) must NOT throw — that would break the whole query, not just
 *  the bad row. Non-JSON or non-array → []. Mirrors conversation-store's guard. */
function safeJsonArray<T>(json: string): T[] {
  try {
    const v = JSON.parse(json)
    return Array.isArray(v) ? (v as T[]) : []
  } catch {
    return []
  }
}

function rowToRecord(r: ThreadRow): ThreadRecord {
  return {
    id: r.id,
    chatId: r.chat_id,
    title: r.title,
    summary: r.summary,
    facets: safeJsonArray<Facet>(r.facets),
    tags: safeJsonArray<string>(r.tags),
    private: r.private !== 0,
    status: r.status as ThreadStatus,
    episodes: safeJsonArray<Episode>(r.episodes),
    createdTs: r.created_ts,
    lastActive: r.last_active,
  }
}

function newThreadId(): string {
  return `thr_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`
}

// Whitelist of columns that update() is allowed to SET.
// Keyed by UpdateThreadInput property name → SQL column name.
const UPDATABLE_COLS: Record<keyof UpdateThreadInput, string> = {
  title: 'title',
  summary: 'summary',
  facets: 'facets',
  tags: 'tags',
  private: 'private',
  status: 'status',
  episodes: 'episodes',
  lastActive: 'last_active',
}

export function makeThreadsStore(db: Db): ThreadsStore {
  const stmtInsert = db.query<unknown, [string, string, string, string, string, string, number, string, string, string, string]>(
    `INSERT INTO threads(id, chat_id, title, summary, facets, tags, private, status, episodes, created_ts, last_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )

  const stmtList = db.query<ThreadRow, [string]>(
    `SELECT id, chat_id, title, summary, facets, tags, private, status, episodes, created_ts, last_active
     FROM threads WHERE chat_id = ? ORDER BY last_active DESC`,
  )

  const stmtGet = db.query<ThreadRow, [string]>(
    `SELECT id, chat_id, title, summary, facets, tags, private, status, episodes, created_ts, last_active
     FROM threads WHERE id = ?`,
  )

  const stmtGetWatermark = db.query<{ extracted_to_ts: string }, [string]>(
    `SELECT extracted_to_ts FROM thread_extract_state WHERE chat_id = ?`,
  )

  const stmtSetWatermark = db.query<unknown, [string, string]>(
    `INSERT INTO thread_extract_state(chat_id, extracted_to_ts) VALUES (?, ?)
     ON CONFLICT(chat_id) DO UPDATE SET extracted_to_ts = excluded.extracted_to_ts`,
  )

  return {
    async create(input) {
      const id = newThreadId()
      const now = new Date().toISOString()
      stmtInsert.run(
        id,
        input.chatId,
        input.title,
        input.summary,
        JSON.stringify(input.facets),
        JSON.stringify(input.tags),
        input.private ? 1 : 0,
        input.status ?? 'active',
        JSON.stringify(input.episodes),
        now,
        now,
      )
      return id
    },

    async update(id, partial) {
      const keys = Object.keys(partial) as (keyof UpdateThreadInput)[]
      if (keys.length === 0) return

      const setClauses: string[] = []
      const values: unknown[] = []

      for (const key of keys) {
        const col = UPDATABLE_COLS[key]
        if (!col) continue  // belt-and-suspenders: skip unknown keys
        setClauses.push(`${col} = ?`)
        const val = partial[key]
        if (key === 'facets' || key === 'tags' || key === 'episodes') {
          values.push(JSON.stringify(val))
        } else if (key === 'private') {
          values.push(val ? 1 : 0)
        } else {
          values.push(val)
        }
      }

      if (setClauses.length === 0) return
      values.push(id)

      // Cast to any[] to satisfy bun:sqlite's overloaded run() — the actual
      // values are all SQLQueryBindings-compatible (string | number | null).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db.query(`UPDATE threads SET ${setClauses.join(', ')} WHERE id = ?`).run(...(values as any[]))
    },

    async list(chatId) {
      return stmtList.all(chatId).map(rowToRecord)
    },

    async get(id) {
      const row = stmtGet.get(id)
      return row ? rowToRecord(row) : null
    },

    async tagVocabulary(n) {
      // json_each is available in bun:sqlite (compiled with JSON1 extension)
      const rows = db.query<{ value: string }, [number]>(
        `SELECT value FROM threads, json_each(threads.tags) GROUP BY value ORDER BY COUNT(*) DESC LIMIT ?`,
      ).all(n)
      return rows.map((r) => r.value)
    },

    async getWatermark(chatId) {
      const row = stmtGetWatermark.get(chatId)
      return row ? row.extracted_to_ts : null
    },

    async setWatermark(chatId, ts) {
      stmtSetWatermark.run(chatId, ts)
    },
  }
}
