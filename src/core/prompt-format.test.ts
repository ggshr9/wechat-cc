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

  it('renders full quoted content as a <quote> element', () => {
    const out = formatInbound({
      chatId: 'c', userId: 'u', userName: 'x',
      text: '这条', msgType: 'text', createTimeMs: 1, accountId: 'a',
      quote: { type: 'text', text: '明天下午三点的会议改到周四了' },
    })
    expect(out).toContain('<quote type="text">明天下午三点的会议改到周四了</quote>')
    expect(out).not.toContain('quote_to')
  })

  it('escapes quote body and preserves newlines', () => {
    const out = formatInbound({
      chatId: 'c', userId: 'u', userName: 'x',
      text: '回', msgType: 'text', createTimeMs: 1, accountId: 'a',
      quote: { type: 'text', text: 'a < b\nsecond line' },
    })
    expect(out).toContain('<quote type="text">a &lt; b\nsecond line</quote>')
  })

  it('omits <quote> entirely when no quote present', () => {
    const out = formatInbound({
      chatId: 'c', userId: 'u', userName: 'x',
      text: 'hi', msgType: 'text', createTimeMs: 1, accountId: 'a',
    })
    expect(out).not.toContain('<quote')
  })

  it('emits ts as ISO-8601 UTC (legible to the agent), not raw epoch ms', () => {
    const out = formatInbound({
      chatId: 'c', userId: 'u', userName: 'x',
      text: 'hi', msgType: 'text', createTimeMs: 1_000_000, accountId: 'a',
    })
    expect(out).toContain('ts="1970-01-01T00:16:40.000Z"') // new Date(1_000_000).toISOString()
    expect(out).not.toContain('ts="1000000"')
  })
})
