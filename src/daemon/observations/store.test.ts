import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeObservationsStore } from './store'
import { openTestDb, type Db } from '../../lib/db'

describe('observations store', () => {
  let dir: string
  let db: Db
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'obs-'))
    db = openTestDb()
  })
  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('appends observations and lists active only', async () => {
    const store = makeObservationsStore(db, 'chat_x')
    const id = await store.append({ body: 'you mentioned compass 12 times', tone: 'curious' })
    expect(id).toMatch(/^obs_/)
    const active = await store.listActive()
    expect(active).toHaveLength(1)
    expect(active[0]).toMatchObject({ id, body: 'you mentioned compass 12 times', tone: 'curious', archived: false })
  })

  it('archives a single observation by id', async () => {
    const store = makeObservationsStore(db, 'chat_x')
    const id1 = await store.append({ body: 'A' })
    const id2 = await store.append({ body: 'B' })
    await store.archive(id1)
    const active = await store.listActive()
    expect(active).toHaveLength(1)
    expect(active[0]!.id).toBe(id2)
    const archived = await store.listArchived()
    expect(archived).toHaveLength(1)
    expect(archived[0]!.id).toBe(id1)
    expect(archived[0]!.archived_at).toBeDefined()
  })

  it('TTL: items older than ttlDays are not active', async () => {
    const store = makeObservationsStore(db, 'chat_x', { ttlDays: 30 })
    const oldTs = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString()
    await store.appendRaw({ id: 'obs_old', ts: oldTs, body: 'old', archived: false })
    const fresh = await store.append({ body: 'new' })
    const active = await store.listActive()
    expect(active.map(r => r.id)).toEqual([fresh])
  })

  it('archived items are excluded from listActive even if fresh', async () => {
    const store = makeObservationsStore(db, 'chat_x')
    const id = await store.append({ body: 'X' })
    await store.archive(id)
    expect(await store.listActive()).toHaveLength(0)
  })

  it('different chatIds are isolated', async () => {
    const a = makeObservationsStore(db, 'chat_a')
    const b = makeObservationsStore(db, 'chat_b')
    await a.append({ body: 'A only' })
    await b.append({ body: 'B only' })
    expect((await a.listActive()).map(r => r.body)).toEqual(['A only'])
    expect((await b.listActive()).map(r => r.body)).toEqual(['B only'])
  })

  describe('legacy file migration', () => {
    it('imports rows + preserves archived/archived_at + renames file', async () => {
      const chatDir = join(dir, 'chat_x')
      mkdirSync(chatDir, { recursive: true })
      const file = join(chatDir, 'observations.jsonl')
      writeFileSync(
        file,
        JSON.stringify({ id: 'obs_a', ts: '2026-04-01T00:00:00.000Z', body: 'active', tone: 'curious', archived: false }) + '\n' +
        JSON.stringify({ id: 'obs_b', ts: '2026-04-02T00:00:00.000Z', body: 'gone', archived: true, archived_at: '2026-04-03T00:00:00.000Z' }) + '\n',
      )
      const store = makeObservationsStore(db, 'chat_x', { ttlDays: 365_000, migrateFromFile: file })
      const active = await store.listActive()
      expect(active).toHaveLength(1)
      expect(active[0]!.id).toBe('obs_a')
      const archived = await store.listArchived()
      expect(archived).toHaveLength(1)
      expect(archived[0]!.id).toBe('obs_b')
      expect(archived[0]!.archived_at).toBe('2026-04-03T00:00:00.000Z')
      expect(existsSync(file)).toBe(false)
      expect(existsSync(`${file}.migrated`)).toBe(true)
    })

    it('skips malformed lines', async () => {
      const chatDir = join(dir, 'chat_x')
      mkdirSync(chatDir, { recursive: true })
      const file = join(chatDir, 'observations.jsonl')
      writeFileSync(
        file,
        JSON.stringify({ id: 'obs_a', ts: '2026-04-01T00:00:00.000Z', body: 'a', archived: false }) + '\n' +
        '{not-json\n' +
        JSON.stringify({ id: 'obs_b', ts: '2026-04-02T00:00:00.000Z', body: 'b', archived: false }) + '\n',
      )
      const store = makeObservationsStore(db, 'chat_x', { ttlDays: 365_000, migrateFromFile: file })
      const active = await store.listActive()
      expect(active.map(r => r.id)).toEqual(['obs_a', 'obs_b'])
    })
  })
})
