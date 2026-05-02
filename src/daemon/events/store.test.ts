import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeEventsStore, type EventRecord } from './store'
import { openTestDb, type Db } from '../../lib/db'

describe('events store', () => {
  let dir: string
  let db: Db
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'events-'))
    db = openTestDb()
  })
  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('appends one event and reads it back', async () => {
    const store = makeEventsStore(db, 'chat_x')
    const ev: Omit<EventRecord, 'id' | 'ts'> = { kind: 'cron_eval_skipped', trigger: 'hourly', reasoning: 'user is focused' }
    const id = await store.append(ev)
    expect(id).toMatch(/^evt_/)
    const all = await store.list()
    expect(all).toHaveLength(1)
    expect(all[0]).toMatchObject({ id, kind: 'cron_eval_skipped', trigger: 'hourly', reasoning: 'user is focused' })
    expect(all[0]!.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('appends multiple events in order', async () => {
    const store = makeEventsStore(db, 'chat_x')
    await store.append({ kind: 'cron_eval_skipped', trigger: 't1', reasoning: 'r1' })
    await store.append({ kind: 'observation_written', trigger: 't2', reasoning: 'r2', observation_id: 'obs_1' })
    const all = await store.list()
    expect(all).toHaveLength(2)
    expect(all[0]!.trigger).toBe('t1')
    expect(all[1]!.trigger).toBe('t2')
  })

  it('list({ limit, since }) filters', async () => {
    const store = makeEventsStore(db, 'chat_x')
    for (let i = 0; i < 5; i++) await store.append({ kind: 'cron_eval_skipped', trigger: `t${i}`, reasoning: '' })
    expect((await store.list({ limit: 2 }))).toHaveLength(2)
  })

  it('handles empty state on first read', async () => {
    const store = makeEventsStore(db, 'fresh_chat')
    expect(await store.list()).toEqual([])
  })

  it('truncates push_text exceeding PUSH_TEXT_MAX', async () => {
    const store = makeEventsStore(db, 'chat_x')
    const long = 'x'.repeat(2000)
    await store.append({ kind: 'cron_eval_pushed', trigger: 't', reasoning: 'r', push_text: long })
    const [rec] = await store.list()
    expect(rec!.push_text!.length).toBeLessThanOrEqual(1025) // 1024 + ellipsis
    expect(rec!.push_text!.endsWith('…')).toBe(true)
  })

  it('accepts cron_eval_failed events with reasoning', async () => {
    const store = makeEventsStore(db, 'chat_x')
    await store.append({ kind: 'cron_eval_failed', trigger: 'introspect', reasoning: 'SDK timeout after 30s' })
    const all = await store.list()
    expect(all).toHaveLength(1)
    expect(all[0]!.kind).toBe('cron_eval_failed')
    expect(all[0]!.reasoning).toContain('SDK timeout')
  })

  it('different chatIds are isolated', async () => {
    const a = makeEventsStore(db, 'chat_a')
    const b = makeEventsStore(db, 'chat_b')
    await a.append({ kind: 'cron_eval_skipped', trigger: 't', reasoning: 'A' })
    await b.append({ kind: 'cron_eval_skipped', trigger: 't', reasoning: 'B' })
    expect((await a.list()).map(e => e.reasoning)).toEqual(['A'])
    expect((await b.list()).map(e => e.reasoning)).toEqual(['B'])
  })

  it('list({ since }) returns events with ts >= cutoff', async () => {
    const store = makeEventsStore(db, 'chat_x')
    await store.appendRaw({ id: 'evt_old', ts: '2026-01-01T00:00:00.000Z', kind: 'cron_eval_skipped', trigger: 't', reasoning: 'old' })
    await store.appendRaw({ id: 'evt_new', ts: '2026-04-01T00:00:00.000Z', kind: 'cron_eval_skipped', trigger: 't', reasoning: 'new' })
    const recent = await store.list({ since: '2026-03-01T00:00:00.000Z' })
    expect(recent.map(r => r.id)).toEqual(['evt_new'])
  })

  describe('legacy file migration', () => {
    it('imports rows from a chat-scoped events.jsonl and renames it', async () => {
      const chatDir = join(dir, 'chat_x')
      mkdirSync(chatDir, { recursive: true })
      const file = join(chatDir, 'events.jsonl')
      writeFileSync(
        file,
        JSON.stringify({ id: 'evt_a', ts: '2026-04-01T00:00:00.000Z', kind: 'cron_eval_skipped', trigger: 't', reasoning: 'a' }) + '\n' +
        JSON.stringify({ id: 'evt_b', ts: '2026-04-02T00:00:00.000Z', kind: 'observation_written', trigger: 'introspect', reasoning: 'b', observation_id: 'obs_x' }) + '\n',
      )
      const store = makeEventsStore(db, 'chat_x', { migrateFromFile: file })
      const all = await store.list()
      expect(all).toHaveLength(2)
      expect(all[0]!.id).toBe('evt_a')
      expect(all[1]!.observation_id).toBe('obs_x')
      expect(existsSync(file)).toBe(false)
      expect(existsSync(`${file}.migrated`)).toBe(true)
    })

    it('skips malformed lines (same posture as legacy reader)', async () => {
      const chatDir = join(dir, 'chat_x')
      mkdirSync(chatDir, { recursive: true })
      const file = join(chatDir, 'events.jsonl')
      writeFileSync(
        file,
        JSON.stringify({ id: 'evt_1', ts: '2026-01-01T00:00:00Z', kind: 'cron_eval_skipped', trigger: 't', reasoning: 'r' }) + '\n' +
        'this-is-not-json\n' +
        JSON.stringify({ id: 'evt_2', ts: '2026-01-02T00:00:00Z', kind: 'cron_eval_skipped', trigger: 't', reasoning: 'r' }) + '\n',
      )
      const store = makeEventsStore(db, 'chat_x', { migrateFromFile: file })
      const all = await store.list()
      expect(all).toHaveLength(2)
      expect(all.map(r => r.id)).toEqual(['evt_1', 'evt_2'])
    })
  })
})
