import { describe, it, expect } from 'vitest'
import { groupChats, filterProjectsByChat, pickReadRecord } from './sessions-helpers'
import type { SessionRecord } from '../core/session-store'

function rec(p: Partial<SessionRecord>): SessionRecord {
  return {
    alias: 'a', provider: 'claude', chat_id: 'c', session_id: 's',
    last_used_at: '2026-06-01T00:00:00.000Z', summary: null, summary_updated_at: null,
    ...p,
  } as SessionRecord
}

describe('groupChats', () => {
  it('groups records by chat_id, counts distinct aliases, takes max last_used_at, sorts desc', () => {
    const records = [
      rec({ chat_id: 'c1', alias: 'wechat-cc', last_used_at: '2026-06-01T10:00:00.000Z' }),
      rec({ chat_id: 'c1', alias: 'blog',      last_used_at: '2026-06-03T10:00:00.000Z' }),
      rec({ chat_id: 'c1', alias: 'blog', provider: 'codex', last_used_at: '2026-06-02T10:00:00.000Z' }),
      rec({ chat_id: 'c2', alias: 'wechat-cc', last_used_at: '2026-06-04T10:00:00.000Z' }),
    ]
    const nameOf = (id: string) => (id === 'c1' ? '小白' : null)
    const accountOf = (id: string) => (id === 'c1' ? 'bot1' : null)
    const out = groupChats(records, nameOf, accountOf)
    expect(out).toEqual([
      { chat_id: 'c2', user_name: null, account_id: null, session_count: 1, last_used_at: '2026-06-04T10:00:00.000Z' },
      { chat_id: 'c1', user_name: '小白', account_id: 'bot1', session_count: 2, last_used_at: '2026-06-03T10:00:00.000Z' },
    ])
  })

  it('returns [] for no records', () => {
    expect(groupChats([], () => null, () => null)).toEqual([])
  })
})

describe('filterProjectsByChat', () => {
  const records = [
    rec({ chat_id: 'c1', alias: 'wechat-cc', last_used_at: '2026-06-01T10:00:00.000Z', session_id: 's1' }),
    rec({ chat_id: 'c1', alias: 'wechat-cc', provider: 'codex', last_used_at: '2026-06-03T10:00:00.000Z', session_id: 's2' }),
    rec({ chat_id: 'c1', alias: 'blog', last_used_at: '2026-06-02T10:00:00.000Z', session_id: 's3' }),
    rec({ chat_id: 'c2', alias: 'wechat-cc', last_used_at: '2026-06-04T10:00:00.000Z', session_id: 's4' }),
  ]

  it('returns only the given chat, one row per alias (most-recent provider wins)', () => {
    const out = filterProjectsByChat(records, 'c1')
    expect(out.map(p => [p.alias, p.session_id]).sort()).toEqual([['blog', 's3'], ['wechat-cc', 's2']])
  })

  it('excludes other chats entirely', () => {
    const out = filterProjectsByChat(records, 'c2')
    expect(out).toEqual([{ alias: 'wechat-cc', session_id: 's4', last_used_at: '2026-06-04T10:00:00.000Z', summary: null, summary_updated_at: null }])
  })
})

describe('pickReadRecord', () => {
  const records = [
    rec({ chat_id: 'c1', alias: 'wechat-cc', last_used_at: '2026-06-01T10:00:00.000Z', session_id: 'c1-old' }),
    rec({ chat_id: 'c2', alias: 'wechat-cc', last_used_at: '2026-06-04T10:00:00.000Z', session_id: 'c2-new' }),
  ]
  it('with chatId, picks that chat\'s row (not the globally-most-recent)', () => {
    expect(pickReadRecord(records, 'wechat-cc', 'c1')?.session_id).toBe('c1-old')
  })
  it('without chatId, picks most-recent across chats (legacy)', () => {
    expect(pickReadRecord(records, 'wechat-cc', undefined)?.session_id).toBe('c2-new')
  })
  it('returns null when no row matches', () => {
    expect(pickReadRecord(records, 'nope', undefined)).toBeNull()
    expect(pickReadRecord(records, 'wechat-cc', 'cX')).toBeNull()
  })
})
