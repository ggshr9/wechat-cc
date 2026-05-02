import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildDetectorContext } from './build-context'
import { makeEventsStore } from '../events/store'
import { openTestDb, type Db } from '../../lib/db'

describe('buildDetectorContext', () => {
  let stateDir: string
  let db: Db
  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'bdc-'))
    db = openTestDb()
  })
  afterEach(() => {
    db.close()
    rmSync(stateDir, { recursive: true, force: true })
  })

  it('returns zeros/empties when no state exists', async () => {
    const ctx = await buildDetectorContext({ stateDir, chatId: 'chat_x', db })
    expect(ctx.turnCount).toBe(0)
    expect(ctx.handoffMarkerExists).toBe(false)
    expect(ctx.pushRepliedHistory).toEqual([])
    expect(ctx.daysWithMessage).toEqual([])
    expect(ctx.chatId).toBe('chat_x')
  })

  it('detects handoff marker', async () => {
    const memDir = join(stateDir, 'memory', 'chat_x')
    mkdirSync(memDir, { recursive: true })
    writeFileSync(join(memDir, '_handoff.md'), 'pointer')
    const ctx = await buildDetectorContext({ stateDir, chatId: 'chat_x', db })
    expect(ctx.handoffMarkerExists).toBe(true)
  })

  it('builds pushRepliedHistory from events.jsonl', async () => {
    const events = makeEventsStore(db, 'chat_x')
    await events.append({ kind: 'cron_eval_pushed', trigger: 'daily', reasoning: 'r', push_text: 'hi' })
    await events.append({ kind: 'cron_eval_skipped', trigger: 'daily', reasoning: 'r' })
    const ctx = await buildDetectorContext({ stateDir, chatId: 'chat_x', db })
    expect(ctx.pushRepliedHistory).toHaveLength(1)
  })

  it('reads daysWithMessage from activity.jsonl (v0.4.1)', async () => {
    // Seed 7 consecutive UTC dates of activity for chat_x
    const memDir = join(stateDir, 'memory', 'chat_x')
    mkdirSync(memDir, { recursive: true })
    const today = new Date()
    const dates: string[] = []
    for (let i = 6; i >= 0; i--) {
      const d = new Date(today.getTime() - i * 86400_000)
      dates.push(d.toISOString().slice(0, 10))
    }
    const lines = dates.map(date =>
      JSON.stringify({ date, first_msg_ts: `${date}T08:00:00.000Z`, msg_count: 1 })
    ).join('\n') + '\n'
    writeFileSync(join(memDir, 'activity.jsonl'), lines)

    const ctx = await buildDetectorContext({ stateDir, chatId: 'chat_x', db })
    expect(ctx.daysWithMessage).toHaveLength(7)
    expect(ctx.daysWithMessage).toEqual(dates)
  })
})
