/**
 * observations.jsonl store + archive split.
 *
 * Active observations are written by the introspect cron and shown at the
 * top of the memory pane. Two ways an observation leaves the active set:
 *   1. age > ttlDays (default 30) → still on disk, just filtered out
 *   2. user explicitly archives → marked `archived: true`, archived_at set
 *
 * We don't physically split files (no separate active.jsonl / archive.jsonl)
 * because that adds rename+rewrite complexity. Archived = field flip, ttl =
 * filter at read time. The whole jsonl stays under ~1MB even after years
 * (each line is ~200 bytes, tens of thousands of observations would still
 * load fast).
 *
 * Defensive read: malformed lines silently skipped (same posture as
 * events store — see src/daemon/events/store.ts for rationale).
 */
import { existsSync, mkdirSync } from 'node:fs'
import { appendFile, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

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
  appendRaw(rec: ObservationRecord): Promise<void>
  listActive(): Promise<ObservationRecord[]>
  listArchived(): Promise<ObservationRecord[]>
  archive(id: string): Promise<void>
}

export interface ObservationsOpts {
  ttlDays?: number  // default 30
}

function newObsId(): string {
  return `obs_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`
}

export function makeObservationsStore(stateRoot: string, chatId: string, opts: ObservationsOpts = {}): ObservationsStore {
  const ttlDays = opts.ttlDays ?? 30
  const chatDir = join(stateRoot, chatId)
  const path = join(chatDir, 'observations.jsonl')

  async function readAll(): Promise<ObservationRecord[]> {
    if (!existsSync(path)) return []
    const raw = await readFile(path, 'utf8')
    const out: ObservationRecord[] = []
    for (const line of raw.split('\n')) {
      if (line.length === 0) continue
      try { out.push(JSON.parse(line) as ObservationRecord) } catch { /* skip malformed */ }
    }
    return out
  }

  async function rewriteAll(records: ObservationRecord[]): Promise<void> {
    if (!existsSync(chatDir)) mkdirSync(chatDir, { recursive: true, mode: 0o700 })
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
    await writeFile(tmp, records.map(r => JSON.stringify(r)).join('\n') + (records.length ? '\n' : ''), { mode: 0o600 })
    await rename(tmp, path)
  }

  return {
    async append(rec) {
      if (!existsSync(chatDir)) mkdirSync(chatDir, { recursive: true, mode: 0o700 })
      const id = newObsId()
      const full: ObservationRecord = {
        id,
        ts: new Date().toISOString(),
        body: rec.body,
        archived: rec.archived ?? false,
        ...(rec.tone ? { tone: rec.tone } : {}),
        ...(rec.event_id ? { event_id: rec.event_id } : {}),
      }
      await appendFile(path, JSON.stringify(full) + '\n', { mode: 0o600 })
      return id
    },

    async appendRaw(rec) {
      if (!existsSync(chatDir)) mkdirSync(chatDir, { recursive: true, mode: 0o700 })
      await appendFile(path, JSON.stringify(rec) + '\n', { mode: 0o600 })
    },

    async listActive() {
      const all = await readAll()
      const cutoffMs = Date.now() - ttlDays * 24 * 60 * 60 * 1000
      return all.filter(r => !r.archived && new Date(r.ts).getTime() >= cutoffMs)
    },

    async listArchived() {
      const all = await readAll()
      return all.filter(r => r.archived)
    },

    async archive(id) {
      const all = await readAll()
      const idx = all.findIndex(r => r.id === id)
      if (idx < 0) return
      all[idx] = { ...all[idx], archived: true, archived_at: new Date().toISOString() }
      await rewriteAll(all)
    },
  }
}
