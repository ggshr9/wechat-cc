import { describe, it, expect } from 'vitest'
import { openTestDb } from './db'
import { makeMessagesStore, inboundMessageId, inboundFallbackMessageId } from './messages-store'

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

  // A1 — inboundFallbackMessageId
  it('inboundFallbackMessageId: same text → same id (stable dedup)', () => {
    const id1 = inboundFallbackMessageId('u1', 'hello')
    const id2 = inboundFallbackMessageId('u1', 'hello')
    expect(id1).toBe(id2)
    expect(id1).toMatch(/^u1:0:[0-9a-f]{12}$/)
  })

  it('inboundFallbackMessageId: different texts → different ids', () => {
    expect(inboundFallbackMessageId('u1', 'aaa')).not.toBe(inboundFallbackMessageId('u1', 'bbb'))
  })

  // A3 — append returns number of actually inserted rows
  it('append returns 1 on first insert, 0 on duplicate (INSERT OR IGNORE)', async () => {
    const s = makeMessagesStore(openTestDb())
    const rec = { id: 'dup2', chatId: 'c1', ts: '2026-06-11T00:00:00Z', direction: 'in' as const, kind: 'text', text: 'x', source: 'live' }
    expect(await s.append(rec)).toBe(1)
    expect(await s.append(rec)).toBe(0)
  })

  // A2 — listChatIds
  it('listChatIds returns distinct chat ids with messages', async () => {
    const s = makeMessagesStore(openTestDb())
    await s.append({ id: 'x1', chatId: 'chatA', ts: '2026-06-11T00:00:00Z', direction: 'in', kind: 'text', text: 'hi', source: 'live' })
    await s.append({ id: 'x2', chatId: 'chatB', ts: '2026-06-11T00:00:01Z', direction: 'in', kind: 'text', text: 'yo', source: 'live' })
    await s.append({ id: 'x3', chatId: 'chatA', ts: '2026-06-11T00:00:02Z', direction: 'out', kind: 'text', text: 'ok', source: 'live' })
    const ids = await s.listChatIds()
    expect(ids.sort()).toEqual(['chatA', 'chatB'])
  })

  it('listChatIds returns empty array when no messages', async () => {
    const s = makeMessagesStore(openTestDb())
    expect(await s.listChatIds()).toEqual([])
  })

  // A5 — LIKE escaping
  it('search: literal percent sign is matched exactly (not as wildcard)', async () => {
    const s = makeMessagesStore(openTestDb())
    await s.append({ id: 'p1', chatId: 'c1', ts: '2026-06-11T00:00:00Z', direction: 'in', kind: 'text', text: '达成率 100%', source: 'live' })
    await s.append({ id: 'p2', chatId: 'c1', ts: '2026-06-11T00:00:01Z', direction: 'in', kind: 'text', text: '别的内容', source: 'live' })
    const hits = await s.search('c1', '100%', 10)
    expect(hits.length).toBe(1)
    expect(hits[0]!.id).toBe('p1')
  })

  it('search: query "_" does NOT match arbitrary single-char messages', async () => {
    const s = makeMessagesStore(openTestDb())
    await s.append({ id: 'u1', chatId: 'c1', ts: '2026-06-11T00:00:00Z', direction: 'in', kind: 'text', text: 'x', source: 'live' })
    await s.append({ id: 'u2', chatId: 'c1', ts: '2026-06-11T00:00:01Z', direction: 'in', kind: 'text', text: 'ab', source: 'live' })
    // Only messages literally containing '_' should be returned
    const hits = await s.search('c1', '_', 10)
    expect(hits.length).toBe(0)
  })

  it('search: literal underscore matches message containing it', async () => {
    const s = makeMessagesStore(openTestDb())
    await s.append({ id: 'u3', chatId: 'c1', ts: '2026-06-11T00:00:00Z', direction: 'in', kind: 'text', text: 'foo_bar', source: 'live' })
    await s.append({ id: 'u4', chatId: 'c1', ts: '2026-06-11T00:00:01Z', direction: 'in', kind: 'text', text: 'foobar', source: 'live' })
    const hits = await s.search('c1', 'foo_bar', 10)
    expect(hits.length).toBe(1)
    expect(hits[0]!.id).toBe('u3')
  })
})
