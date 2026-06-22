import { describe, it, expect } from 'vitest'
import { openTestDb } from './db'
import { makeThreadsStore } from './threads-store'

describe('threads store', () => {
  it('create + list returns thread with parsed facets/tags', async () => {
    const s = makeThreadsStore(openTestDb())
    await s.create({ chatId: 'c1', title: 'compass 排产', summary: '排产改造', facets: ['task'], tags: ['compass'], private: false, episodes: [{ from_ts: 'a', to_ts: 'b' }] })
    const all = await s.list('c1')
    expect(all.length).toBe(1)
    expect(all[0]).toMatchObject({ title: 'compass 排产', facets: ['task'], tags: ['compass'], status: 'active' })
  })

  it('a corrupt JSON column does not crash the query — defaults to empty', async () => {
    // Regression: rowToRecord JSON.parse'd facets/tags/episodes unguarded, so a
    // single corrupt row (truncated write / manual edit) threw and broke the
    // ENTIRE thread list (not just that row). conversation-store guards its
    // analogous parse; threads-store must too.
    const db = openTestDb()
    const s = makeThreadsStore(db)
    await s.create({ chatId: 'c1', title: 't', summary: '', facets: ['task'], tags: ['x'], private: false, episodes: [{ from_ts: 'a', to_ts: 'b' }] })
    db.exec(`UPDATE threads SET facets = 'not-json{', tags = '[broken', episodes = 'xxx' WHERE chat_id = 'c1'`)
    const all = await s.list('c1')
    expect(all.length).toBe(1)        // row still returned, query did not throw
    expect(all[0]!.facets).toEqual([])
    expect(all[0]!.tags).toEqual([])
    expect(all[0]!.episodes).toEqual([])
    expect(all[0]!.title).toBe('t')   // intact fields preserved
  })

  it('update merges fields and bumps last_active', async () => {
    const s = makeThreadsStore(openTestDb())
    const id = await s.create({ chatId: 'c1', title: 't', summary: '', facets: ['life'], tags: [], private: true, episodes: [] })
    await s.update(id, { status: 'done', tags: ['股票'], lastActive: '2026-06-12T00:00:00Z' })
    const t = (await s.list('c1'))[0]!
    expect(t.status).toBe('done')
    expect(t.tags).toEqual(['股票'])
    expect(t.private).toBe(true)
  })

  it('tagVocabulary returns tags by frequency across chats', async () => {
    const s = makeThreadsStore(openTestDb())
    await s.create({ chatId: 'c1', title: 'a', summary: '', facets: ['task'], tags: ['compass', '排产'], private: false, episodes: [] })
    await s.create({ chatId: 'c2', title: 'b', summary: '', facets: ['task'], tags: ['compass'], private: false, episodes: [] })
    expect((await s.tagVocabulary(10))[0]).toBe('compass')
  })

  it('watermark get/set roundtrip', async () => {
    const s = makeThreadsStore(openTestDb())
    expect(await s.getWatermark('c1')).toBeNull()
    await s.setWatermark('c1', '2026-06-11T00:00:00Z')
    expect(await s.getWatermark('c1')).toBe('2026-06-11T00:00:00Z')
  })
})
