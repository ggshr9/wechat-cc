import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeMilestonesStore } from './store'
import { openTestDb, type Db } from '../../lib/db'

describe('milestones store', () => {
  let dir: string
  let db: Db
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ms-'))
    db = openTestDb()
  })
  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('records a milestone and lists it', async () => {
    const store = makeMilestonesStore(db, 'chat_x')
    const fired = await store.fire({ id: 'ms_100msg', body: 'we hit 100 messages' })
    expect(fired).toBe(true)
    const all = await store.list()
    expect(all).toHaveLength(1)
    expect(all[0]).toMatchObject({ id: 'ms_100msg', body: 'we hit 100 messages' })
    expect(all[0]!.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('deduplicates: firing the same id twice is a no-op the second time', async () => {
    const store = makeMilestonesStore(db, 'chat_x')
    expect(await store.fire({ id: 'ms_100msg', body: 'first' })).toBe(true)
    expect(await store.fire({ id: 'ms_100msg', body: 'second (ignored)' })).toBe(false)
    const all = await store.list()
    expect(all).toHaveLength(1)
    expect(all[0]!.body).toBe('first')
  })

  it('list is empty when no milestones', async () => {
    expect(await makeMilestonesStore(db, 'chat_x').list()).toEqual([])
  })

  it('different chatIds dedupe independently', async () => {
    const a = makeMilestonesStore(db, 'chat_a')
    const b = makeMilestonesStore(db, 'chat_b')
    expect(await a.fire({ id: 'ms_100msg', body: 'A first' })).toBe(true)
    expect(await b.fire({ id: 'ms_100msg', body: 'B first' })).toBe(true)
    expect((await a.list())[0]!.body).toBe('A first')
    expect((await b.list())[0]!.body).toBe('B first')
  })

  describe('legacy file migration', () => {
    it('imports rows from a chat-scoped milestones.jsonl and renames it', async () => {
      const chatDir = join(dir, 'chat_x')
      mkdirSync(chatDir, { recursive: true })
      const file = join(chatDir, 'milestones.jsonl')
      writeFileSync(
        file,
        JSON.stringify({ id: 'ms_demo_100msg', ts: '2026-04-01T00:00:00.000Z', body: 'first 100' }) + '\n' +
        JSON.stringify({ id: 'ms_first_handoff', ts: '2026-04-15T00:00:00.000Z', body: 'first handoff', event_id: 'evt_x' }) + '\n',
      )
      const store = makeMilestonesStore(db, 'chat_x', { migrateFromFile: file })
      const all = await store.list()
      expect(all).toHaveLength(2)
      expect(all[0]!.id).toBe('ms_demo_100msg')
      expect(all[1]!.event_id).toBe('evt_x')
      expect(existsSync(file)).toBe(false)
      expect(existsSync(`${file}.migrated`)).toBe(true)
    })

    it('preserves first-fire body on re-import (INSERT OR IGNORE)', async () => {
      const chatDir = join(dir, 'chat_x')
      mkdirSync(chatDir, { recursive: true })
      const file = join(chatDir, 'milestones.jsonl')
      writeFileSync(file, JSON.stringify({ id: 'ms_x', ts: '2026-04-01T00:00:00.000Z', body: 'original' }) + '\n')
      makeMilestonesStore(db, 'chat_x', { migrateFromFile: file })
      // After first migration the file is renamed. We simulate a partial-failure
      // scenario by re-creating the legacy file with a competing body.
      writeFileSync(file, JSON.stringify({ id: 'ms_x', ts: '2026-04-02T00:00:00.000Z', body: 'overwrite-attempt' }) + '\n')
      const s2 = makeMilestonesStore(db, 'chat_x', { migrateFromFile: file })
      const all = await s2.list()
      expect(all[0]!.body).toBe('original')
    })

    it('skips malformed lines in the legacy jsonl', async () => {
      const chatDir = join(dir, 'chat_x')
      mkdirSync(chatDir, { recursive: true })
      const file = join(chatDir, 'milestones.jsonl')
      writeFileSync(
        file,
        JSON.stringify({ id: 'ms_a', ts: '2026-04-01T00:00:00.000Z', body: 'a' }) + '\n' +
        '{not-json\n' +
        JSON.stringify({ id: 'ms_b', ts: '2026-04-02T00:00:00.000Z', body: 'b' }) + '\n',
      )
      const store = makeMilestonesStore(db, 'chat_x', { migrateFromFile: file })
      const all = await store.list()
      expect(all.map(r => r.id)).toEqual(['ms_a', 'ms_b'])
    })
  })
})
