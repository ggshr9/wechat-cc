import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeObservationsStore } from './store'

describe('observations store', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'obs-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('appends observations and lists active only', async () => {
    const store = makeObservationsStore(dir, 'chat_x')
    const id = await store.append({ body: 'you mentioned compass 12 times', tone: 'curious' })
    expect(id).toMatch(/^obs_/)
    const active = await store.listActive()
    expect(active).toHaveLength(1)
    expect(active[0]).toMatchObject({ id, body: 'you mentioned compass 12 times', tone: 'curious', archived: false })
  })

  it('archives a single observation by id', async () => {
    const store = makeObservationsStore(dir, 'chat_x')
    const id1 = await store.append({ body: 'A' })
    const id2 = await store.append({ body: 'B' })
    await store.archive(id1)
    const active = await store.listActive()
    expect(active).toHaveLength(1)
    expect(active[0].id).toBe(id2)
    const archived = await store.listArchived()
    expect(archived).toHaveLength(1)
    expect(archived[0].id).toBe(id1)
    expect(archived[0].archived_at).toBeDefined()
  })

  it('TTL: items older than ttlDays are not active', async () => {
    const store = makeObservationsStore(dir, 'chat_x', { ttlDays: 30 })
    const oldTs = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString()
    await store.appendRaw({ id: 'obs_old', ts: oldTs, body: 'old', archived: false })
    const fresh = await store.append({ body: 'new' })
    const active = await store.listActive()
    expect(active.map(r => r.id)).toEqual([fresh])
  })

  it('archived items are excluded from listActive even if fresh', async () => {
    const store = makeObservationsStore(dir, 'chat_x')
    const id = await store.append({ body: 'X' })
    await store.archive(id)
    expect(await store.listActive()).toHaveLength(0)
  })
})
