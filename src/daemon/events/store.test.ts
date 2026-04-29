import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeEventsStore, type EventRecord } from './store'

describe('events store', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'events-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('appends one event and reads it back', async () => {
    const store = makeEventsStore(dir, 'chat_x')
    const ev: Omit<EventRecord, 'id' | 'ts'> = { kind: 'cron_eval_skipped', trigger: 'hourly', reasoning: 'user is focused' }
    const id = await store.append(ev)
    expect(id).toMatch(/^evt_/)
    const all = await store.list()
    expect(all).toHaveLength(1)
    expect(all[0]).toMatchObject({ id, kind: 'cron_eval_skipped', trigger: 'hourly', reasoning: 'user is focused' })
    expect(all[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('appends multiple events in order', async () => {
    const store = makeEventsStore(dir, 'chat_x')
    await store.append({ kind: 'cron_eval_skipped', trigger: 't1', reasoning: 'r1' })
    await store.append({ kind: 'observation_written', trigger: 't2', reasoning: 'r2', observation_id: 'obs_1' })
    const all = await store.list()
    expect(all).toHaveLength(2)
    expect(all[0].trigger).toBe('t1')
    expect(all[1].trigger).toBe('t2')
  })

  it('list({ limit, since }) filters', async () => {
    const store = makeEventsStore(dir, 'chat_x')
    for (let i = 0; i < 5; i++) await store.append({ kind: 'cron_eval_skipped', trigger: `t${i}`, reasoning: '' })
    expect((await store.list({ limit: 2 }))).toHaveLength(2)
  })

  it('writes one JSON object per line (jsonl format)', async () => {
    const store = makeEventsStore(dir, 'chat_x')
    await store.append({ kind: 'cron_eval_skipped', trigger: 't', reasoning: 'r' })
    await store.append({ kind: 'cron_eval_skipped', trigger: 't', reasoning: 'r' })
    const path = join(dir, 'chat_x', 'events.jsonl')
    const lines = readFileSync(path, 'utf8').trimEnd().split('\n')
    expect(lines).toHaveLength(2)
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow()
    }
  })

  it('handles missing file on first read (returns empty array)', async () => {
    const store = makeEventsStore(dir, 'fresh_chat')
    expect(await store.list()).toEqual([])
  })
})
