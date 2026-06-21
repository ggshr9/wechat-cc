import { describe, expect, it } from 'vitest'
import { openDb } from '../lib/db'
import { makeTurnRecordStore, TURN_RECORDS_MAX_PER_CHAT } from './turn-record-store'
import type { TurnRecord } from './conversation-coordinator'

function rec(over: Partial<TurnRecord> = {}): TurnRecord {
  return {
    chatId: 'chat-1',
    provider: 'claude',
    alias: 'a',
    mode: 'solo',
    startedAt: 1000,
    endedAt: 1200,
    durationMs: 200,
    outcome: 'completed',
    replyToolCalled: true,
    textChunks: 2,
    ...over,
  }
}

describe('turn-record-store', () => {
  it('append() round-trips a record (camelCase shape, bool mapping) via recentForChat', () => {
    const db = openDb({ path: ':memory:' })
    const store = makeTurnRecordStore(db)
    store.append(rec({ outcome: 'timeout', error: 'turn timed out', replyToolCalled: false }))
    const rows = store.recentForChat('chat-1', 10)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      chatId: 'chat-1', provider: 'claude', alias: 'a', mode: 'solo',
      startedAt: 1000, endedAt: 1200, durationMs: 200,
      outcome: 'timeout', replyToolCalled: false, textChunks: 2, error: 'turn timed out',
    })
    expect(typeof rows[0]!.id).toBe('string')
  })

  it('recentForChat orders newest-first and respects the limit', () => {
    const db = openDb({ path: ':memory:' })
    const store = makeTurnRecordStore(db)
    store.append(rec({ endedAt: 100, textChunks: 1 }))
    store.append(rec({ endedAt: 300, textChunks: 3 }))
    store.append(rec({ endedAt: 200, textChunks: 2 }))
    const rows = store.recentForChat('chat-1', 2)
    expect(rows.map(r => r.endedAt)).toEqual([300, 200])
  })

  it('recentForChat filters by chatId', () => {
    const db = openDb({ path: ':memory:' })
    const store = makeTurnRecordStore(db)
    store.append(rec({ chatId: 'chat-A' }))
    store.append(rec({ chatId: 'chat-B' }))
    expect(store.recentForChat('chat-A', 10)).toHaveLength(1)
    expect(store.recentForChat('chat-A', 10)[0]!.chatId).toBe('chat-A')
  })

  it('recent() returns the newest turns across all chats', () => {
    const db = openDb({ path: ':memory:' })
    const store = makeTurnRecordStore(db)
    store.append(rec({ chatId: 'chat-A', endedAt: 100 }))
    store.append(rec({ chatId: 'chat-B', endedAt: 300 }))
    store.append(rec({ chatId: 'chat-C', endedAt: 200 }))
    const rows = store.recent(2)
    expect(rows.map(r => r.chatId)).toEqual(['chat-B', 'chat-C'])
  })

  it('prunes to TURN_RECORDS_MAX_PER_CHAT newest rows per chat on append', () => {
    const db = openDb({ path: ':memory:' })
    const store = makeTurnRecordStore(db)
    const N = TURN_RECORDS_MAX_PER_CHAT
    for (let i = 0; i < N + 5; i++) store.append(rec({ endedAt: 1000 + i }))
    const rows = store.recentForChat('chat-1', N + 100)
    expect(rows).toHaveLength(N)
    // The 5 oldest (endedAt 1000..1004) were pruned; newest survives.
    expect(rows[0]!.endedAt).toBe(1000 + (N + 5) - 1)
    expect(rows[rows.length - 1]!.endedAt).toBe(1000 + 5)
  })

  it('pruning is per-chat — a busy chat does not evict another chat', () => {
    const db = openDb({ path: ':memory:' })
    const store = makeTurnRecordStore(db)
    store.append(rec({ chatId: 'quiet', endedAt: 1 }))
    for (let i = 0; i < TURN_RECORDS_MAX_PER_CHAT + 10; i++) store.append(rec({ chatId: 'busy', endedAt: 1000 + i }))
    expect(store.recentForChat('quiet', 10)).toHaveLength(1)
  })

  it('truncates an overlong error string', () => {
    const db = openDb({ path: ':memory:' })
    const store = makeTurnRecordStore(db)
    store.append(rec({ outcome: 'error', error: 'x'.repeat(20_000) }))
    const r = store.recentForChat('chat-1', 1)[0]!
    expect(r.error!.length).toBeLessThanOrEqual(8192)
  })
})
