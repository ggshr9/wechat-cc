import { describe, it, expect } from 'vitest'
import { formatInbound } from './prompt-format'

describe('formatInbound', () => {
  it('wraps a plain text message with channel tag', () => {
    const out = formatInbound({
      chatId: 'cid1', userId: 'u1', userName: '小白',
      text: 'hello', msgType: 'text', createTimeMs: 1_000_000,
      accountId: 'acct-a',
    })
    expect(out).toContain('<wechat')
    expect(out).toContain('chat_id="cid1"')
    expect(out).toContain('user="小白"')
    expect(out).toContain('hello')
    expect(out).toContain('</wechat>')
  })

  it('escapes angle brackets inside body but preserves tag', () => {
    const out = formatInbound({
      chatId: 'c', userId: 'u', userName: 'x',
      text: '<script>alert(1)</script>', msgType: 'text', createTimeMs: 1, accountId: 'a',
    })
    expect(out).not.toContain('<script>')
    expect(out).toContain('&lt;script&gt;')
  })

  it('inlines attachments with local paths', () => {
    const out = formatInbound({
      chatId: 'c', userId: 'u', userName: 'x',
      text: '看图', msgType: 'image', createTimeMs: 1, accountId: 'a',
      attachments: [{ kind: 'image', path: '/home/u/.claude/channels/wechat/inbox/a/b.jpg' }],
    })
    expect(out).toContain('[image:/home/u/.claude/channels/wechat/inbox/a/b.jpg]')
  })

  it('includes quote reference when quoteTo set', () => {
    const out = formatInbound({
      chatId: 'c', userId: 'u', userName: 'x',
      text: '这条', msgType: 'text', createTimeMs: 1, accountId: 'a',
      quoteTo: 'prev-msg-id',
    })
    expect(out).toContain('quote_to="prev-msg-id"')
  })
})
