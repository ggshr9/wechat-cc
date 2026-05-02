import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeMilestonesStore } from './store'
import { detectMilestones, type DetectorContext } from './detector'
import { openTestDb, type Db } from '../../lib/db'

function ctx(stateRoot: string, chatId: string, overrides: Partial<DetectorContext> = {}): DetectorContext {
  return {
    chatId,
    turnCount: 0,
    handoffMarkerExists: false,
    pushRepliedHistory: [],
    daysWithMessage: [],
    ...overrides,
  }
}

describe('milestone detector', () => {
  let dir: string
  let db: Db
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'msd-'))
    db = openTestDb()
  })
  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('fires ms_100msg when turn count crosses 100', async () => {
    const store = makeMilestonesStore(db, 'chat_x')
    const fired = await detectMilestones(store, ctx(dir, 'chat_x', { turnCount: 100 }))
    expect(fired).toContain('ms_100msg')
    expect(await store.list()).toHaveLength(1)
  })

  it('does not fire ms_100msg when turn count is 99', async () => {
    const store = makeMilestonesStore(db, 'chat_x')
    const fired = await detectMilestones(store, ctx(dir, 'chat_x', { turnCount: 99 }))
    expect(fired).not.toContain('ms_100msg')
  })

  it('fires ms_1000msg when turn count crosses 1000', async () => {
    const store = makeMilestonesStore(db, 'chat_x')
    const fired = await detectMilestones(store, ctx(dir, 'chat_x', { turnCount: 1000 }))
    expect(fired).toContain('ms_1000msg')
  })

  it('fires ms_first_handoff when handoff marker exists', async () => {
    const store = makeMilestonesStore(db, 'chat_x')
    const fired = await detectMilestones(store, ctx(dir, 'chat_x', { handoffMarkerExists: true }))
    expect(fired).toContain('ms_first_handoff')
  })

  it('fires ms_first_push_reply on first non-empty pushRepliedHistory entry', async () => {
    const store = makeMilestonesStore(db, 'chat_x')
    const fired = await detectMilestones(store, ctx(dir, 'chat_x', { pushRepliedHistory: ['evt_1'] }))
    expect(fired).toContain('ms_first_push_reply')
  })

  it('fires ms_7day_streak when last 7 days all have messages', async () => {
    const store = makeMilestonesStore(db, 'chat_x')
    const today = new Date()
    const days: string[] = []
    for (let i = 0; i < 7; i++) {
      const d = new Date(today.getTime() - i * 86400_000)
      days.push(d.toISOString().slice(0, 10))
    }
    const fired = await detectMilestones(store, ctx(dir, 'chat_x', { daysWithMessage: days }))
    expect(fired).toContain('ms_7day_streak')
  })

  it('subsequent calls do not re-fire same milestone', async () => {
    const store = makeMilestonesStore(db, 'chat_x')
    await detectMilestones(store, ctx(dir, 'chat_x', { turnCount: 100 }))
    const fired2 = await detectMilestones(store, ctx(dir, 'chat_x', { turnCount: 200 }))
    expect(fired2).not.toContain('ms_100msg')
    expect(await store.list()).toHaveLength(1)
  })
})
