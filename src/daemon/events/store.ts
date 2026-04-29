/**
 * Append-only events.jsonl per chat. Records what the introspect cron decided
 * (push / skip / observation_written / milestone). Read by the dashboard's
 * "Claude 的最近决策" folded section + by the introspect cron itself (to avoid
 * repeating the same observation on consecutive ticks).
 *
 * Layout: <stateRoot>/<chatId>/events.jsonl
 * Append uses fs.promises.appendFile with `\n` — each call is one line.
 * No locking: introspect cron + daemon both append, but appendFile is atomic
 * for single-line writes on POSIX (PIPE_BUF guarantees lines ≤ 4KB stay
 * intact across concurrent writers). We keep individual records under 4KB by
 * convention (reasoning truncated at 2KB).
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
  list(opts?: { limit?: number; since?: string }): Promise<EventRecord[]>
}

const REASONING_MAX = 2048

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
      const full: EventRecord = { ...rec, reasoning, id, ts }
      await appendFile(path, JSON.stringify(full) + '\n', { mode: 0o600 })
      return id
    },
    async list(opts = {}) {
      if (!existsSync(path)) return []
      const raw = await readFile(path, 'utf8')
      const lines = raw.split('\n').filter(line => line.length > 0)
      let parsed = lines.map(line => JSON.parse(line) as EventRecord)
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
