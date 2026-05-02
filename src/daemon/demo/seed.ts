/**
 * Demo data seeder. Writes 3 observations + 1 milestone + 5 events under
 * a chatId so the dashboard's empty-state panes immediately show realistic
 * content. All seeded items have stable demo_* id prefixes for clean
 * unseed.
 *
 * Use cases:
 *   - First-impression demo / screenshot
 *   - Manual playwright validation
 *   - Onboarding ("here's what observations look like once Claude has
 *     been paying attention")
 */
import { existsSync } from 'node:fs'
import { readFile, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { makeEventsStore } from '../events/store'
import { makeObservationsStore } from '../observations/store'
import { makeMilestonesStore } from '../milestones/store'
import type { Db } from '../../lib/db'

export interface SeedDeps {
  stateDir: string
  chatId: string
  db: Db
  now?: () => number  // for testability
}

export async function seedDemo(deps: SeedDeps): Promise<{ observations: number; milestones: number; events: number }> {
  const now = deps.now ?? Date.now
  const memoryRoot = join(deps.stateDir, 'memory')
  const obs = makeObservationsStore(memoryRoot, deps.chatId)
  const ms = makeMilestonesStore(deps.db, deps.chatId, {
    migrateFromFile: join(memoryRoot, deps.chatId, 'milestones.jsonl'),
  })
  const ev = makeEventsStore(memoryRoot, deps.chatId)
  const t = now()

  const isoAgo = (ms_ago: number) => new Date(t - ms_ago).toISOString()

  // Use appendRaw to bypass id+ts generation so the seed has stable ids.
  await obs.appendRaw({ id: 'obs_demo_1', ts: isoAgo(2 * 3600_000), body: "你这周提了 12 次 'compass'，上周才 4 次——项目压力上来了？", tone: 'concern', archived: false })
  await obs.appendRaw({ id: 'obs_demo_2', ts: isoAgo(24 * 3600_000), body: "你说过想学吉他，最近还在弹吗？也许我看错了，但好久没听你提了。", tone: 'curious', archived: false })
  await obs.appendRaw({ id: 'obs_demo_3', ts: isoAgo(72 * 3600_000), body: "我注意到你最近 3 次都在 23:30 后才发消息——会不会让你早点休息？", tone: 'concern', archived: false })

  await ms.fire({ id: 'ms_demo_100msg', body: '我们聊了第 100 条 — 不知不觉。' })
  // Note: milestone fire() generates ts itself; for seed we accept the live ts.
  // If you want a stable past ts on the milestone, would need a fireRaw —
  // skip for now, seed always shows "just now" for the milestone.

  // appendRaw with stable evt_demo_N ids + relative timestamps so the
  // dashboard's "Claude 的最近决策" panel shows entries spaced over time
  // (not all bunched at "just now"). unseed targets these by id prefix.
  await ev.appendRaw({ id: 'evt_demo_1', ts: isoAgo(2 * 3600_000), kind: 'observation_written', trigger: 'introspect', reasoning: 'detected pattern: compass mentioned 12 times this week vs 4 last week', observation_id: 'obs_demo_1' })
  await ev.appendRaw({ id: 'evt_demo_2', ts: isoAgo(2 * 3600_000 + 30 * 60_000), kind: 'cron_eval_skipped', trigger: 'hourly', reasoning: 'user is in focus session, last activity 5 min ago' })
  await ev.appendRaw({ id: 'evt_demo_3', ts: isoAgo(24 * 3600_000), kind: 'observation_written', trigger: 'introspect', reasoning: 'recalled prior interest in guitar from earlier conversation', observation_id: 'obs_demo_2' })
  await ev.appendRaw({ id: 'evt_demo_4', ts: isoAgo(72 * 3600_000 + 3600_000), kind: 'cron_eval_pushed', trigger: 'daily-checkin', reasoning: '3 consecutive late-night messages — gentle nudge', push_text: '今天提了 2 次 deadline，要不要先吃饭？' })
  await ev.appendRaw({ id: 'evt_demo_5', ts: isoAgo(7 * 24 * 3600_000), kind: 'milestone', trigger: 'detector', reasoning: 'jsonl line count crossed 100', milestone_id: 'ms_demo_100msg' })

  return { observations: 3, milestones: 1, events: 5 }
}

export async function unseedDemo(deps: { stateDir: string; chatId: string; db: Db }): Promise<{ removed: number }> {
  const memoryRoot = join(deps.stateDir, 'memory')
  const chatDir = join(memoryRoot, deps.chatId)
  let removed = 0

  // Per-store-migration sweep. Each store moves to SQLite incrementally
  // (PR7.5+); when a store is migrated, its legacy file is renamed to
  // .migrated and demo rows live in the db. When still file-based, the
  // jsonl scrubber below catches them. The two paths are union — we hit
  // both so unseed works mid-migration too.

  // SQLite-backed: milestones (PR7.5).
  const delMs = deps.db.prepare("DELETE FROM milestones WHERE chat_id = ? AND id LIKE 'ms_demo_%'")
  removed += (delMs.run(deps.chatId).changes ?? 0) as number

  for (const fname of ['observations.jsonl', 'milestones.jsonl', 'events.jsonl']) {
    const path = join(chatDir, fname)
    if (!existsSync(path)) continue
    const raw = await readFile(path, 'utf8')
    const lines = raw.split('\n').filter(l => l.length > 0)
    const kept: string[] = []
    for (const line of lines) {
      try {
        const rec = JSON.parse(line) as { id?: string; observation_id?: string; milestone_id?: string }
        const id = rec.id || ''
        // Demo records start with obs_demo_, ms_demo_, evt_demo_, OR for events
        // we identify by observation_id/milestone_id pointing at a demo entity.
        const isDemo = id.startsWith('obs_demo_') || id.startsWith('ms_demo_') || id.startsWith('evt_demo_')
          || (typeof rec.observation_id === 'string' && rec.observation_id.startsWith('obs_demo_'))
          || (typeof rec.milestone_id === 'string' && rec.milestone_id.startsWith('ms_demo_'))
        if (isDemo) { removed++; continue }
        kept.push(line)
      } catch {
        kept.push(line)  // keep malformed lines (don't claim to "remove" them)
      }
    }
    if (kept.length === lines.length) continue  // nothing changed
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
    await writeFile(tmp, kept.join('\n') + (kept.length ? '\n' : ''), { mode: 0o600 })
    await rename(tmp, path)
  }
  return { removed }
}
