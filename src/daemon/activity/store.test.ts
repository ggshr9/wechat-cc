import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeActivityStore } from './store'

describe('activity store', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'activity-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('records first message of a day', async () => {
    const store = makeActivityStore(dir, 'chat_x')
    await store.recordInbound(new Date('2026-04-29T08:00:00Z'))
    const days = await store.recentDays(30)
    expect(days).toHaveLength(1)
    expect(days[0].date).toBe('2026-04-29')
    expect(days[0].msg_count).toBe(1)
  })

  it('increments msg_count for same-day messages without adding new entries', async () => {
    const store = makeActivityStore(dir, 'chat_x')
    await store.recordInbound(new Date('2026-04-29T08:00:00Z'))
    await store.recordInbound(new Date('2026-04-29T14:00:00Z'))
    await store.recordInbound(new Date('2026-04-29T22:00:00Z'))
    const days = await store.recentDays(30)
    expect(days).toHaveLength(1)
    expect(days[0].msg_count).toBe(3)
  })

  it('appends new entries on day change', async () => {
    const store = makeActivityStore(dir, 'chat_x')
    await store.recordInbound(new Date('2026-04-28T23:30:00Z'))
    await store.recordInbound(new Date('2026-04-29T00:30:00Z'))
    const days = await store.recentDays(30)
    expect(days).toHaveLength(2)
    expect(days.map(d => d.date)).toEqual(['2026-04-28', '2026-04-29'])
  })

  it('recentDays(N) limits how far back we read', async () => {
    const store = makeActivityStore(dir, 'chat_x')
    await store.recordInbound(new Date('2026-01-01T00:00:00Z'))
    await store.recordInbound(new Date('2026-04-28T00:00:00Z'))
    await store.recordInbound(new Date('2026-04-29T00:00:00Z'))
    const days = await store.recentDays(7)
    expect(days.map(d => d.date)).toEqual(['2026-04-28', '2026-04-29'])
  })
})
