import { describe, it, expect } from 'vitest'
import { makeAccountChatIndex } from './account-chat-index'

describe('AccountChatIndex', () => {
  it('records and retrieves chats per account', () => {
    const idx = makeAccountChatIndex()
    idx.record('a1', 'c1')
    idx.record('a1', 'c2')
    idx.record('a2', 'c3')
    expect([...idx.chatsFor('a1')].sort()).toEqual(['c1', 'c2'])
    expect([...idx.chatsFor('a2')]).toEqual(['c3'])
    expect([...idx.chatsFor('a3')]).toEqual([])
  })

  it('ignores empty accountId', () => {
    const idx = makeAccountChatIndex()
    idx.record('', 'c1')
    expect([...idx.chatsFor('')]).toEqual([])
  })

  it('dedups same chatId for same account', () => {
    const idx = makeAccountChatIndex()
    idx.record('a1', 'c1')
    idx.record('a1', 'c1')
    expect([...idx.chatsFor('a1')]).toEqual(['c1'])
  })
})
