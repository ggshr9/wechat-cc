import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeActivityStore } from './store'
import { openTestDb, type Db } from '../../lib/db'

describe('activity store', () => {
  let dir: string
  let db: Db
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'activity-'))
    db = openTestDb()
  })
  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('records first message of a day', async () => {
    const store = makeActivityStore(db, 'chat_x')
    await store.recordInbound(new Date('2026-04-29T08:00:00Z'))
    const days = await store.recentDays(30)
    expect(days).toHaveLength(1)
    expect(days[0]!.date).toBe('2026-04-29')
    expect(days[0]!.msg_count).toBe(1)
  })

  it('increments msg_count for same-day messages without adding new entries', async () => {
    const store = makeActivityStore(db, 'chat_x')
    await store.recordInbound(new Date('2026-04-29T08:00:00Z'))
    await store.recordInbound(new Date('2026-04-29T14:00:00Z'))
    await store.recordInbound(new Date('2026-04-29T22:00:00Z'))
    const days = await store.recentDays(30)
    expect(days).toHaveLength(1)
    expect(days[0]!.msg_count).toBe(3)
  })

  it('appends new entries on day change', async () => {
    const store = makeActivityStore(db, 'chat_x')
    await store.recordInbound(new Date('2026-04-28T23:30:00Z'))
    await store.recordInbound(new Date('2026-04-29T00:30:00Z'))
    const days = await store.recentDays(30)
    expect(days).toHaveLength(2)
    expect(days.map(d => d.date)).toEqual(['2026-04-28', '2026-04-29'])
  })

  it('recentDays(N) limits how far back we read', async () => {
    const store = makeActivityStore(db, 'chat_x')
    await store.recordInbound(new Date('2026-01-01T00:00:00Z'))
    await store.recordInbound(new Date('2026-04-28T00:00:00Z'))
    await store.recordInbound(new Date('2026-04-29T00:00:00Z'))
    const days = await store.recentDays(7)
    expect(days.map(d => d.date)).toEqual(['2026-04-28', '2026-04-29'])
  })

  it('different chatIds keep separate counts', async () => {
    const a = makeActivityStore(db, 'chat_a')
    const b = makeActivityStore(db, 'chat_b')
    await a.recordInbound(new Date('2026-04-29T08:00:00Z'))
    await a.recordInbound(new Date('2026-04-29T09:00:00Z'))
    await b.recordInbound(new Date('2026-04-29T10:00:00Z'))
    expect((await a.recentDays(30))[0]!.msg_count).toBe(2)
    expect((await b.recentDays(30))[0]!.msg_count).toBe(1)
  })

  describe('legacy file migration', () => {
    it('imports rows from a chat-scoped activity.jsonl and renames it', async () => {
      const chatDir = join(dir, 'chat_x')
      mkdirSync(chatDir, { recursive: true })
      const file = join(chatDir, 'activity.jsonl')
      writeFileSync(
        file,
        JSON.stringify({ date: '2026-04-28', first_msg_ts: '2026-04-28T08:00:00.000Z', msg_count: 5 }) + '\n' +
        JSON.stringify({ date: '2026-04-29', first_msg_ts: '2026-04-29T08:00:00.000Z', msg_count: 3 }) + '\n',
      )
      const store = makeActivityStore(db, 'chat_x', { migrateFromFile: file })
      const days = await store.recentDays(365)
      expect(days).toHaveLength(2)
      expect(days[0]!.msg_count).toBe(5)
      expect(days[1]!.msg_count).toBe(3)
      expect(existsSync(file)).toBe(false)
      expect(existsSync(`${file}.migrated`)).toBe(true)
    })

    it('skips malformed lines in the legacy jsonl', async () => {
      const chatDir = join(dir, 'chat_x')
      mkdirSync(chatDir, { recursive: true })
      const file = join(chatDir, 'activity.jsonl')
      writeFileSync(
        file,
        JSON.stringify({ date: '2026-04-28', first_msg_ts: '2026-04-28T08:00:00.000Z', msg_count: 1 }) + '\n' +
        'not-json\n' +
        JSON.stringify({ date: '2026-04-29', first_msg_ts: '2026-04-29T08:00:00.000Z', msg_count: 2 }) + '\n',
      )
      const store = makeActivityStore(db, 'chat_x', { migrateFromFile: file })
      const days = await store.recentDays(365)
      expect(days.map(d => d.date)).toEqual(['2026-04-28', '2026-04-29'])
    })

    it('is idempotent — second construction with same opt is a no-op', async () => {
      const chatDir = join(dir, 'chat_x')
      mkdirSync(chatDir, { recursive: true })
      const file = join(chatDir, 'activity.jsonl')
      writeFileSync(file, JSON.stringify({ date: '2026-04-28', first_msg_ts: '2026-04-28T08:00:00.000Z', msg_count: 1 }) + '\n')
      makeActivityStore(db, 'chat_x', { migrateFromFile: file })
      const s2 = makeActivityStore(db, 'chat_x', { migrateFromFile: file })
      const days = await s2.recentDays(365)
      expect(days[0]!.msg_count).toBe(1)
    })
  })
})
