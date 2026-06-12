import { describe, it, expect } from 'vitest'
import { openTestDb } from './db'
import { makeMessagesStore, inboundMessageId } from './messages-store'

describe('messages store', () => {
  it('append + listRange returns rows in ts order', async () => {
    const s = makeMessagesStore(openTestDb())
    await s.append({ id: 'b', chatId: 'c1', ts: '2026-06-11T00:01:00Z', direction: 'out', kind: 'text', text: 'world', provider: 'claude', source: 'live' })
    await s.append({ id: 'a', chatId: 'c1', ts: '2026-06-11T00:00:00Z', direction: 'in', kind: 'text', text: 'hello', source: 'live' })
    const rows = await s.listRange('c1', { limit: 10 })
    expect(rows.map(r => r.text)).toEqual(['hello', 'world'])
  })

  it('append is idempotent on id (INSERT OR IGNORE)', async () => {
    const s = makeMessagesStore(openTestDb())
    const rec = { id: 'dup', chatId: 'c1', ts: '2026-06-11T00:00:00Z', direction: 'in' as const, kind: 'text', text: 'x', source: 'live' }
    await s.append(rec)
    await s.append(rec)
    expect((await s.listRange('c1', { limit: 10 })).length).toBe(1)
  })

  it('listRange pages backwards with beforeTs', async () => {
    const s = makeMessagesStore(openTestDb())
    for (let i = 0; i < 5; i++)
      await s.append({ id: `m${i}`, chatId: 'c1', ts: `2026-06-11T00:0${i}:00Z`, direction: 'in', kind: 'text', text: `t${i}`, source: 'live' })
    const page = await s.listRange('c1', { limit: 2, beforeTs: '2026-06-11T00:03:00Z' })
    expect(page.map(r => r.text)).toEqual(['t1', 't2'])  // 紧邻 beforeTs 之前的两条,升序
  })

  it('search matches text within one chat only', async () => {
    const s = makeMessagesStore(openTestDb())
    await s.append({ id: '1', chatId: 'c1', ts: '2026-06-11T00:00:00Z', direction: 'in', kind: 'text', text: 'compass 排产计划', source: 'live' })
    await s.append({ id: '2', chatId: 'c2', ts: '2026-06-11T00:00:00Z', direction: 'in', kind: 'text', text: '排产无关', source: 'live' })
    const hits = await s.search('c1', '排产', 10)
    expect(hits.length).toBe(1)
    expect(hits[0]!.id).toBe('1')
  })

  it('latestTs returns newest ts or null', async () => {
    const s = makeMessagesStore(openTestDb())
    expect(await s.latestTs('c1')).toBeNull()
    await s.append({ id: '1', chatId: 'c1', ts: '2026-06-11T00:05:00Z', direction: 'in', kind: 'text', text: 'x', source: 'live' })
    expect(await s.latestTs('c1')).toBe('2026-06-11T00:05:00Z')
  })

  it('inboundMessageId mirrors the dedupe key', () => {
    expect(inboundMessageId('u@im.wechat', 1780000000000)).toBe('u@im.wechat:1780000000000')
  })
})
