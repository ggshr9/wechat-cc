/**
 * Per-chat daily activity tracker. One record per UTC date with first message
 * timestamp + count. Detector reads recentDays(7) to evaluate streak.
 *
 * Concurrency: same single-daemon-writer assumption as observations/archive.
 * recordInbound is read-modify-write within the same date — concurrent
 * inbound on the same chat-day is rare (single ilink poll loop per chat).
 */
import { existsSync, mkdirSync } from 'node:fs'
import { appendFile, readFile, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'

export interface ActivityRecord {
  date: string                // YYYY-MM-DD UTC
  first_msg_ts: string        // ISO
  msg_count: number
}

export interface ActivityStore {
  recordInbound(when: Date): Promise<void>
  recentDays(n: number): Promise<ActivityRecord[]>
}

function utcDateKey(d: Date): string {
  return d.toISOString().slice(0, 10)
}

export function makeActivityStore(stateRoot: string, chatId: string): ActivityStore {
  const chatDir = join(stateRoot, chatId)
  const path = join(chatDir, 'activity.jsonl')

  async function readAll(): Promise<ActivityRecord[]> {
    if (!existsSync(path)) return []
    const raw = await readFile(path, 'utf8')
    const out: ActivityRecord[] = []
    for (const line of raw.split('\n')) {
      if (line.length === 0) continue
      try { out.push(JSON.parse(line) as ActivityRecord) } catch { /* skip */ }
    }
    return out
  }

  async function rewriteAll(records: ActivityRecord[]): Promise<void> {
    if (!existsSync(chatDir)) mkdirSync(chatDir, { recursive: true, mode: 0o700 })
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
    await writeFile(tmp, records.map(r => JSON.stringify(r)).join('\n') + (records.length ? '\n' : ''), { mode: 0o600 })
    await rename(tmp, path)
  }

  return {
    async recordInbound(when) {
      const date = utcDateKey(when)
      const all = await readAll()
      const idx = all.findIndex(r => r.date === date)
      if (idx >= 0) {
        all[idx] = { ...all[idx], msg_count: all[idx].msg_count + 1 }
        await rewriteAll(all)
        return
      }
      // First message of this date — append (preserving prior order).
      if (!existsSync(chatDir)) mkdirSync(chatDir, { recursive: true, mode: 0o700 })
      const rec: ActivityRecord = { date, first_msg_ts: when.toISOString(), msg_count: 1 }
      await appendFile(path, JSON.stringify(rec) + '\n', { mode: 0o600 })
    },

    async recentDays(n) {
      const all = await readAll()
      const cutoff = new Date(Date.now() - n * 86400_000)
      const cutoffKey = utcDateKey(cutoff)
      return all.filter(r => r.date >= cutoffKey).sort((a, b) => a.date < b.date ? -1 : 1)
    },
  }
}
