/**
 * Milestones — append-only with id-level dedup. Each kind of milestone
 * (e.g. ms_100msg, ms_first_handoff) fires at most once per chat. Caller
 * must pass a stable id; we check existing ids at fire time.
 *
 * Concurrency: fire() is read-then-write. Same single-daemon-writer
 * assumption as observations.jsonl archive() — see those notes for
 * rationale. Defensive read skips malformed lines.
 */
import { existsSync, mkdirSync } from 'node:fs'
import { appendFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface MilestoneRecord {
  id: string                  // ms_<kind> — caller-supplied stable
  ts: string                  // ISO
  body: string
  event_id?: string           // back-pointer to events.jsonl
}

export interface MilestonesStore {
  /**
   * Returns true if this is the first time the id fires (record written),
   * false if it was already recorded (no write).
   */
  fire(rec: Omit<MilestoneRecord, 'ts'>): Promise<boolean>
  list(): Promise<MilestoneRecord[]>
}

export function makeMilestonesStore(stateRoot: string, chatId: string): MilestonesStore {
  const chatDir = join(stateRoot, chatId)
  const path = join(chatDir, 'milestones.jsonl')

  async function readAll(): Promise<MilestoneRecord[]> {
    if (!existsSync(path)) return []
    const raw = await readFile(path, 'utf8')
    const out: MilestoneRecord[] = []
    for (const line of raw.split('\n')) {
      if (line.length === 0) continue
      try { out.push(JSON.parse(line) as MilestoneRecord) } catch { /* skip malformed */ }
    }
    return out
  }

  return {
    async fire(rec) {
      const all = await readAll()
      if (all.some(r => r.id === rec.id)) return false
      if (!existsSync(chatDir)) mkdirSync(chatDir, { recursive: true, mode: 0o700 })
      const full: MilestoneRecord = { ...rec, ts: new Date().toISOString() }
      await appendFile(path, JSON.stringify(full) + '\n', { mode: 0o600 })
      return true
    },
    async list() {
      return readAll()
    },
  }
}
