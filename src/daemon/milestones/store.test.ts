import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeMilestonesStore } from './store'

describe('milestones store', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ms-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('records a milestone and lists it', async () => {
    const store = makeMilestonesStore(dir, 'chat_x')
    const fired = await store.fire({ id: 'ms_100msg', body: 'we hit 100 messages' })
    expect(fired).toBe(true)
    const all = await store.list()
    expect(all).toHaveLength(1)
    expect(all[0]).toMatchObject({ id: 'ms_100msg', body: 'we hit 100 messages' })
    expect(all[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('deduplicates: firing the same id twice is a no-op the second time', async () => {
    const store = makeMilestonesStore(dir, 'chat_x')
    expect(await store.fire({ id: 'ms_100msg', body: 'first' })).toBe(true)
    expect(await store.fire({ id: 'ms_100msg', body: 'second (ignored)' })).toBe(false)
    const all = await store.list()
    expect(all).toHaveLength(1)
    expect(all[0].body).toBe('first')
  })

  it('list is empty when no milestones', async () => {
    expect(await makeMilestonesStore(dir, 'chat_x').list()).toEqual([])
  })
})
