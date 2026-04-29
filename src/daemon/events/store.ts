/**
 * Append-only events.jsonl per chat. Records what the introspect cron decided
 * (push / skip / observation_written / milestone). Read by the dashboard's
 * "Claude 的最近决策" folded section + by the introspect cron itself (to avoid
 * repeating the same observation on consecutive ticks).
 *
 * Layout: <stateRoot>/<chatId>/events.jsonl
 * Append uses fs.promises.appendFile with `\n` — each call is one line.
 * Concurrency: appendFile is best-effort atomic on POSIX up to PIPE_BUF
 * (512B macOS / 4KB Linux). Writes exceeding this may interleave with
 * concurrent writers and produce a corrupt line — readers must skip
 * malformed lines (which they do). We cap reasoning at 2KB and push_text
 * at 1KB to keep typical lines small, but Chinese (UTF-8 multi-byte) +
 * JSON escapes can still push a single record over macOS's 512B limit.
 */
import { existsSync, mkdirSync } from 'node:fs'
import { appendFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'

export type EventKind =
  | 'cron_eval_pushed'
  | 'cron_eval_skipped'
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

const REASONING_MAX = 2048
// push_text is the message Claude pushed to the user. Cap it so a long
// generated reply can't blow PIPE_BUF and risk interleaving with another
// concurrent appendFile.
const PUSH_TEXT_MAX = 1024

function newEventId(): string {
  return `evt_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`
}

export function makeEventsStore(stateRoot: string, chatId: string): EventsStore {
  const chatDir = join(stateRoot, chatId)
  const path = join(chatDir, 'events.jsonl')

  return {
    async append(rec) {
      if (!existsSync(chatDir)) mkdirSync(chatDir, { recursive: true, mode: 0o700 })
      const id = newEventId()
      const ts = new Date().toISOString()
      const reasoning = rec.reasoning.length > REASONING_MAX
        ? rec.reasoning.slice(0, REASONING_MAX) + '…'
        : rec.reasoning
      const push_text = rec.push_text !== undefined && rec.push_text.length > PUSH_TEXT_MAX
        ? rec.push_text.slice(0, PUSH_TEXT_MAX) + '…'
        : rec.push_text
      const full: EventRecord = {
        ...rec,
        reasoning,
        ...(push_text !== undefined ? { push_text } : {}),
        id,
        ts,
      }
      await appendFile(path, JSON.stringify(full) + '\n', { mode: 0o600 })
      return id
    },
    /**
     * @internal Test seam — accepts a fully-formed record (id + ts caller-
     * supplied). Production code should use append() which generates id + ts.
     */
    async appendRaw(rec) {
      if (!existsSync(chatDir)) mkdirSync(chatDir, { recursive: true, mode: 0o700 })
      await appendFile(path, JSON.stringify(rec) + '\n', { mode: 0o600 })
    },
    async list(opts = {}) {
      if (!existsSync(path)) return []
      const raw = await readFile(path, 'utf8')
      const lines = raw.split('\n').filter(line => line.length > 0)
      let parsed: EventRecord[] = []
      for (const line of lines) {
        try {
          parsed.push(JSON.parse(line) as EventRecord)
        } catch {
          // Skip malformed line — concurrent write interleave or partial flush.
          // Append-only semantics + filtered read keeps the store readable even
          // when a single line is corrupt.
        }
      }
      if (opts.since) {
        parsed = parsed.filter(r => r.ts >= opts.since!)
      }
      if (opts.limit !== undefined && opts.limit < parsed.length) {
        parsed = parsed.slice(parsed.length - opts.limit)
      }
      return parsed
    },
  }
}
