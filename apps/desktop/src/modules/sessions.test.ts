import { describe, expect, it } from 'vitest'
// @ts-expect-error JS sibling
import { groupProjectsByRecency, projectRow, searchHitRow, turnHtml, turnHtmlCompact, extractUserText, extractClaudeReplies, sessionHasReplyTool, buildExportMarkdown, extractWechatMeta, avatarInitial, avatarColor, extractSessionContact, extractSessionChatId, extractTurnTimestamp, formatChatTimestamp } from './sessions.js'

describe('groupProjectsByRecency', () => {
  const now = Date.now()
  const proj = (alias: string, ageHours: number) => ({
    alias, session_id: 's', last_used_at: new Date(now - ageHours * 3600_000).toISOString(),
  })

  it('< 24 hr → 今天 group', () => {
    const groups = groupProjectsByRecency([proj('a', 1), proj('b', 22)])
    expect(groups['今天']).toHaveLength(2)
  })

  it('< 7 days → 7 天内', () => {
    const groups = groupProjectsByRecency([proj('a', 30), proj('b', 5 * 24)])
    expect(groups['7 天内']).toHaveLength(2)
  })

  it('> 7 days → 更早', () => {
    const groups = groupProjectsByRecency([proj('a', 10 * 24)])
    expect(groups['更早']).toHaveLength(1)
  })

  it('skips grouping when total < skipGroupingThreshold (single 全部 bucket)', () => {
    const groups = groupProjectsByRecency([proj('a', 1), proj('b', 100)], { skipGroupingThreshold: 5 })
    expect(Object.keys(groups)).toEqual(['全部'])
    expect(groups['全部']).toHaveLength(2)
  })
})

describe('projectRow', () => {
  it('renders alias + summary + relative time + favorite star', () => {
    const html = projectRow({
      alias: 'compass',
      session_id: 's',
      last_used_at: new Date(Date.now() - 30 * 60_000).toISOString(),
      summary: '修了 ilink-glue',
      summary_updated_at: new Date().toISOString(),
    }, { isFavorite: true })
    expect(html).toContain('compass')
    expect(html).toContain('修了 ilink-glue')
    expect(html).toContain('刚刚')
    expect(html).toContain('is-favorite')
  })

  it('star is independently clickable: data-action="toggle-favorite" + data-alias', () => {
    const html = projectRow({
      alias: 'compass', session_id: 's', last_used_at: new Date().toISOString(),
    })
    // Star carries its own action so click delegation triggers favorite-toggle
    // instead of opening the project detail.
    expect(html).toMatch(/class="star"[^>]*data-action="toggle-favorite"[^>]*data-alias="compass"/)
  })

  it('renders an em-dash placeholder when summary is missing', () => {
    // Empty placeholder is just '—' (.summary.empty greys it out via CSS).
    // v0.4.1's lazy summarizer fills this in within ~30s of the next
    // sessions-list-projects call; refresh again to see the new value.
    const html = projectRow({
      alias: 'x',
      session_id: 's',
      last_used_at: new Date().toISOString(),
    })
    expect(html).toContain('class="summary empty"')
    expect(html).toContain('—')
  })

  it('escapes html in alias and summary to prevent xss', () => {
    const html = projectRow({
      alias: '<script>',
      session_id: 's',
      last_used_at: new Date().toISOString(),
      summary: '<img onerror=x>',
    })
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<img onerror=x>')
    expect(html).toContain('&lt;script&gt;')
  })
})

describe('searchHitRow', () => {
  it('carries data-turn-index for drill-down', () => {
    const html = searchHitRow({ alias: 'compass', session_id: 's', turn_index: 42, snippet: 'matched here' })
    expect(html).toContain('data-turn-index="42"')
    expect(html).toContain('data-alias="compass"')
    expect(html).toContain('matched here')
  })

  it('escapes html in alias and snippet', () => {
    const html = searchHitRow({ alias: '<x>', session_id: 's', turn_index: 0, snippet: '<script>' })
    expect(html).not.toContain('<x>')
    expect(html).not.toContain('<script>')
  })

  describe('compact mode (clean projection)', () => {
    it('shows extracted user text from turn (envelope stripped)', () => {
      const html = searchHitRow({
        alias: 'x', session_id: 's', turn_index: 5, snippet: '"text":"我是谁"',
        turn: { type: 'user', message: { content: [{ type: 'text', text: '<wechat user="GSR">我是谁</wechat>' }] } },
        session_has_reply_tool: true,
      }, { mode: 'compact' })
      expect(html).toContain('我是谁')
      expect(html).not.toContain('<wechat')
      expect(html).not.toContain('"text"')
    })

    it('shows extracted reply text from assistant turn', () => {
      const html = searchHitRow({
        alias: 'x', session_id: 's', turn_index: 18, snippet: 'noise',
        turn: { type: 'assistant', message: { content: [
          { type: 'tool_use', name: 'mcp__wechat__reply', input: { text: '你是 GSR' } },
        ]}},
        session_has_reply_tool: true,
      }, { mode: 'compact' })
      expect(html).toContain('你是 GSR')
    })

    it('hides tool_result / attachment / system / queue-operation hits (returns "")', () => {
      const base = { alias: 'x', session_id: 's', turn_index: 10, snippet: 'noise', session_has_reply_tool: true }
      expect(searchHitRow({ ...base, turn: { type: 'tool_result', content: 'x' } }, { mode: 'compact' })).toBe('')
      expect(searchHitRow({ ...base, turn: { type: 'attachment', attachment: { path: '/x' } } }, { mode: 'compact' })).toBe('')
      expect(searchHitRow({ ...base, turn: { type: 'queue-operation' } }, { mode: 'compact' })).toBe('')
      expect(searchHitRow({ ...base, turn: { type: 'system' } }, { mode: 'compact' })).toBe('')
    })

    it('hides assistant wrap-up text when session uses reply tool', () => {
      const html = searchHitRow({
        alias: 'x', session_id: 's', turn_index: 20, snippet: '已回复',
        turn: { type: 'assistant', message: { content: [{ type: 'text', text: '已回复。' }] } },
        session_has_reply_tool: true,
      }, { mode: 'compact' })
      expect(html).toBe('')
    })

    it('hides hit when turn missing or unparsed (back-compat)', () => {
      expect(searchHitRow({ alias: 'x', session_id: 's', turn_index: 0, snippet: 'matched' }, { mode: 'compact' })).toBe('')
      expect(searchHitRow({ alias: 'x', session_id: 's', turn_index: 0, snippet: 'matched', turn: null }, { mode: 'compact' })).toBe('')
    })

    it('detailed mode preserves raw snippet rendering (JSON noise visible)', () => {
      const html = searchHitRow({
        alias: 'x', session_id: 's', turn_index: 5,
        snippet: '"type":"text","text":"我是谁"',
      }, { mode: 'detailed' })
      expect(html).toContain('我是谁')
      // Quotes are HTML-escaped for XSS safety, but the JSON-noise pattern is still visible.
      expect(html).toContain('&quot;type&quot;')
    })
  })
})

describe('turnHtml', () => {
  it('renders user turn with array content (real SDK shape)', () => {
    const html = turnHtml({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: '帮我看一下' }] },
    })
    expect(html).toContain('帮我看一下')
    expect(html).toContain('data-role="user"')
  })

  it('renders user turn with string content (forward compat)', () => {
    const html = turnHtml({ type: 'user', message: { role: 'user', content: 'hello' } })
    expect(html).toContain('hello')
    expect(html).toContain('data-role="user"')
  })

  it('renders assistant text + tool_use parts', () => {
    const html = turnHtml({
      type: 'assistant',
      message: { role: 'assistant', content: [
        { type: 'text', text: '我修了' },
        { type: 'tool_use', name: 'Edit', input: {} },
      ]},
    })
    expect(html).toContain('我修了')
    expect(html).toContain('Edit')
    expect(html).toContain('data-role="tool_use"')
  })

  it('renders assistant thinking with italic styling hint', () => {
    const html = turnHtml({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'thinking', thinking: '考虑一下' }] },
    })
    expect(html).toContain('考虑一下')
    expect(html).toContain('data-role="thinking"')
    expect(html).toContain('<em>')
  })

  it('skips queue-operation silently', () => {
    expect(turnHtml({ type: 'queue-operation' })).toBe('')
    expect(turnHtml({ type: 'last-prompt' })).toBe('')
  })

  it('renders attachment compactly', () => {
    const html = turnHtml({ type: 'attachment', attachment: { path: '/tmp/img.png' } })
    expect(html).toContain('📎')
    expect(html).toContain('/tmp/img.png')
  })

  it('falls back gracefully on unknown shape', () => {
    expect(turnHtml({ type: 'weird' })).toContain('[weird]')
  })

  it('escapes html in user content (xss)', () => {
    const html = turnHtml({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: '<script>alert(1)</script>' }] },
    })
    expect(html).not.toContain('<script>alert(1)')
    expect(html).toContain('&lt;script&gt;')
  })
})

describe('extractWechatMeta', () => {
  it('extracts user, ts, and text from envelope', () => {
    const turn = {
      type: 'user',
      message: { content: [{ type: 'text', text: '<wechat user="GSR" ts="1777462246591" chat_id="x">我是谁</wechat>' }] },
    }
    const meta = extractWechatMeta(turn)
    expect(meta?.user).toBe('GSR')
    expect(meta?.ts).toBe(1777462246591)
    expect(meta?.text).toBe('我是谁')
  })

  it('returns null fields when envelope absent', () => {
    const turn = { type: 'user', message: { content: 'hi' } }
    const meta = extractWechatMeta(turn)
    expect(meta?.user).toBeNull()
    expect(meta?.ts).toBeNull()
    expect(meta?.text).toBe('hi')
  })

  it('returns null for non-user turns', () => {
    expect(extractWechatMeta({ type: 'assistant', message: {} })).toBeNull()
    expect(extractWechatMeta({ type: 'attachment' })).toBeNull()
  })

  it('handles ts that is not a parseable number gracefully', () => {
    const turn = {
      type: 'user',
      message: { content: [{ type: 'text', text: '<wechat user="X" ts="abc">hi</wechat>' }] },
    }
    expect(extractWechatMeta(turn)?.ts).toBeNull()
  })

  // Attachments live as `[image:path]` / `[file:path]` / `[voice:path]`
  // lines inside the envelope body (see src/core/prompt-format.ts).
  it('parses [image:path] attachment and excludes it from text', () => {
    const turn = {
      type: 'user',
      message: { content: [{ type: 'text', text: '<wechat user="GSR">看这张\n[image:/tmp/cat.jpg]</wechat>' }] },
    }
    const m = extractWechatMeta(turn)
    expect(m?.text).toBe('看这张')
    expect(m?.attachments).toEqual([{ kind: 'image', path: '/tmp/cat.jpg', caption: null }])
  })

  it('parses [file:path] with caption', () => {
    const turn = {
      type: 'user',
      message: { content: [{ type: 'text', text: '<wechat user="GSR">[file:/tmp/doc.pdf] 季度报表</wechat>' }] },
    }
    const m = extractWechatMeta(turn)
    expect(m?.attachments).toEqual([{ kind: 'file', path: '/tmp/doc.pdf', caption: '季度报表' }])
    expect(m?.text).toBe('')
  })

  it('parses multiple attachments + leaves only narrative text', () => {
    const turn = {
      type: 'user',
      message: { content: [{ type: 'text', text: '<wechat user="GSR">三张图\n[image:/a.jpg]\n[image:/b.jpg]\n[image:/c.jpg]</wechat>' }] },
    }
    const m = extractWechatMeta(turn)
    expect(m?.attachments).toHaveLength(3)
    expect(m?.attachments?.[0]).toEqual({ kind: 'image', path: '/a.jpg', caption: null })
    expect(m?.text).toBe('三张图')
  })

  it('parses voice attachments (rendered as a stub for now)', () => {
    const turn = {
      type: 'user',
      message: { content: [{ type: 'text', text: '<wechat user="GSR">[voice:/tmp/v.mp3]</wechat>' }] },
    }
    expect(extractWechatMeta(turn)?.attachments).toEqual([{ kind: 'voice', path: '/tmp/v.mp3', caption: null }])
  })

  it('extracts quote_to from envelope attrs', () => {
    const turn = {
      type: 'user',
      message: { content: [{ type: 'text', text: '<wechat user="GSR" quote_to="msg-abc">回复</wechat>' }] },
    }
    expect(extractWechatMeta(turn)?.quoteTo).toBe('msg-abc')
  })

  it('attachments default to empty array, quoteTo to null', () => {
    const turn = {
      type: 'user',
      message: { content: [{ type: 'text', text: '<wechat user="X">just text</wechat>' }] },
    }
    const m = extractWechatMeta(turn)
    expect(m?.attachments).toEqual([])
    expect(m?.quoteTo).toBeNull()
  })

  it('ignores unknown attachment kinds (forward compat)', () => {
    const turn = {
      type: 'user',
      message: { content: [{ type: 'text', text: '<wechat user="X">hi\n[unknown:/x]</wechat>' }] },
    }
    const m = extractWechatMeta(turn)
    expect(m?.attachments).toEqual([])
    expect(m?.text).toBe('hi\n[unknown:/x]')
  })
})

describe('avatarInitial', () => {
  it('returns uppercased first char for latin names', () => {
    expect(avatarInitial('GSR')).toBe('G')
    expect(avatarInitial('alice')).toBe('A')
  })

  it('returns first char as-is for CJK', () => {
    expect(avatarInitial('张三')).toBe('张')
    expect(avatarInitial('李华')).toBe('李')
  })

  it('falls back to "?" on empty/null/undefined', () => {
    expect(avatarInitial('')).toBe('?')
    expect(avatarInitial(null)).toBe('?')
    expect(avatarInitial(undefined)).toBe('?')
  })

  it('skips leading whitespace', () => {
    expect(avatarInitial('  Bob')).toBe('B')
  })
})

describe('extractTurnTimestamp', () => {
  it('reads ts from wechat envelope on user turns', () => {
    const turn = {
      type: 'user',
      message: { content: [{ type: 'text', text: '<wechat user="X" ts="1777462246591">hi</wechat>' }] },
    }
    expect(extractTurnTimestamp(turn)).toBe(1777462246591)
  })

  it('returns null on user turns without envelope ts', () => {
    expect(extractTurnTimestamp({ type: 'user', message: { content: 'plain' } })).toBeNull()
  })

  it('returns null for assistant turns (caller inherits from preceding)', () => {
    expect(extractTurnTimestamp({ type: 'assistant', message: { content: [] } })).toBeNull()
  })

  it('parses queue-operation timestamp field', () => {
    expect(extractTurnTimestamp({ type: 'queue-operation', timestamp: '2026-04-29T11:31:01.003Z' }))
      .toBe(new Date('2026-04-29T11:31:01.003Z').getTime())
  })

  it('returns null for unknown shapes', () => {
    expect(extractTurnTimestamp({ type: 'system' })).toBeNull()
    expect(extractTurnTimestamp(null)).toBeNull()
  })
})

describe('formatChatTimestamp', () => {
  // Lock now to a fixed point so tests don't drift across midnights/timezones.
  // 2026-04-29 14:00 local time as the reference "now".
  const now = new Date('2026-04-29T14:00:00').getTime()

  it('today → 上午/下午 + 12-hour time', () => {
    const ts = new Date('2026-04-29T08:32:00').getTime()
    expect(formatChatTimestamp(ts, now)).toBe('上午 8:32')
    const ts2 = new Date('2026-04-29T17:18:00').getTime()
    expect(formatChatTimestamp(ts2, now)).toBe('下午 5:18')
  })

  it('yesterday → "昨天" + 24-hour', () => {
    const ts = new Date('2026-04-28T22:16:00').getTime()
    expect(formatChatTimestamp(ts, now)).toBe('昨天 22:16')
  })

  it('within last 7 days → weekday + 24-hour', () => {
    const ts = new Date('2026-04-26T11:00:00').getTime()  // Sunday
    expect(formatChatTimestamp(ts, now)).toBe('周日 11:00')
  })

  it('older → full date + 24-hour', () => {
    const ts = new Date('2026-04-15T22:16:00').getTime()
    expect(formatChatTimestamp(ts, now)).toBe('2026-04-15 22:16')
  })

  it('handles midnight edge (00:xx)', () => {
    const ts = new Date('2026-04-29T00:05:00').getTime()
    expect(formatChatTimestamp(ts, now)).toBe('上午 12:05')
  })

  it('handles noon edge (12:xx)', () => {
    const ts = new Date('2026-04-29T12:30:00').getTime()
    expect(formatChatTimestamp(ts, now)).toBe('下午 12:30')
  })
})

describe('extractSessionContact', () => {
  it('returns user name from the first user turn that has a wechat envelope', () => {
    const turns = [
      { type: 'queue-operation' },
      { type: 'user', message: { content: [{ type: 'text', text: '<wechat user="GSR" chat_id="x">hi</wechat>' }] } },
      { type: 'user', message: { content: [{ type: 'text', text: '<wechat user="Other">later</wechat>' }] } },
    ]
    expect(extractSessionContact(turns)).toBe('GSR')
  })

  it('returns null when no envelope found', () => {
    expect(extractSessionContact([])).toBeNull()
    expect(extractSessionContact([{ type: 'assistant', message: {} }])).toBeNull()
    expect(extractSessionContact([{ type: 'user', message: { content: 'no envelope' } }])).toBeNull()
  })

  it('handles malformed input defensively', () => {
    expect(extractSessionContact(undefined as any)).toBeNull()
    expect(extractSessionContact([null, undefined])).toBeNull()
  })
})

describe('extractSessionChatId', () => {
  it('extracts chat_id from the first user envelope that has one', () => {
    const turns = [
      { type: 'queue-operation' },
      { type: 'user', message: { content: [{ type: 'text', text: '<wechat user="X" chat_id="abc@im.wechat">hi</wechat>' }] } },
    ]
    expect(extractSessionChatId(turns)).toBe('abc@im.wechat')
  })

  it('returns null when no envelope provides chat_id', () => {
    expect(extractSessionChatId([])).toBeNull()
    expect(extractSessionChatId([{ type: 'user', message: { content: 'plain' } }])).toBeNull()
  })
})

describe('extractWechatMeta — chatId', () => {
  it('returns chatId from the envelope', () => {
    const turn = {
      type: 'user',
      message: { content: [{ type: 'text', text: '<wechat user="X" chat_id="abc@im.wechat" ts="1">hi</wechat>' }] },
    }
    expect(extractWechatMeta(turn)?.chatId).toBe('abc@im.wechat')
  })

  it('chatId is null when absent', () => {
    const turn = {
      type: 'user',
      message: { content: [{ type: 'text', text: '<wechat user="X">hi</wechat>' }] },
    }
    expect(extractWechatMeta(turn)?.chatId).toBeNull()
  })
})

describe('avatarColor', () => {
  it('returns an hsl string', () => {
    expect(avatarColor('GSR')).toMatch(/^hsl\(\d+,\s*\d+%,\s*\d+%\)$/)
  })

  it('is deterministic — same seed → same color', () => {
    expect(avatarColor('GSR')).toBe(avatarColor('GSR'))
  })

  it('different seeds produce different colors (collision tolerated, but common cases differ)', () => {
    expect(avatarColor('GSR')).not.toBe(avatarColor('Alice'))
  })

  it('handles empty seed without crashing', () => {
    expect(avatarColor('')).toMatch(/^hsl\(/)
    expect(avatarColor(null)).toMatch(/^hsl\(/)
  })
})

describe('extractUserText', () => {
  it('strips <wechat> envelope and returns inner text', () => {
    const turn = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: '<wechat chat_id="x" user="GSR" msg_type="text" ts="123">我是谁</wechat>' }] },
    }
    expect(extractUserText(turn)).toBe('我是谁')
  })

  it('falls back to raw text when no envelope', () => {
    const turn = { type: 'user', message: { role: 'user', content: [{ type: 'text', text: '直接说话' }] } }
    expect(extractUserText(turn)).toBe('直接说话')
  })

  it('handles string content (forward compat)', () => {
    const turn = { type: 'user', message: { role: 'user', content: 'hello' } }
    expect(extractUserText(turn)).toBe('hello')
  })

  it('returns null for non-user turns', () => {
    expect(extractUserText({ type: 'assistant', message: {} })).toBeNull()
    expect(extractUserText({ type: 'attachment' })).toBeNull()
  })

  it('returns null for empty content', () => {
    expect(extractUserText({ type: 'user', message: { content: [] } })).toBeNull()
    expect(extractUserText({ type: 'user', message: { content: '' } })).toBeNull()
  })
})

describe('extractClaudeReplies', () => {
  it('extracts text from mcp__wechat__reply tool input', () => {
    const turn = {
      type: 'assistant',
      message: { role: 'assistant', content: [
        { type: 'thinking', thinking: '...' },
        { type: 'tool_use', name: 'mcp__wechat__reply', input: { text: '你是 GSR 啊', chat_id: 'x' } },
      ] },
    }
    expect(extractClaudeReplies(turn)).toEqual(['你是 GSR 啊'])
  })

  it('handles multiple reply calls in one turn', () => {
    const turn = {
      type: 'assistant',
      message: { role: 'assistant', content: [
        { type: 'tool_use', name: 'mcp__wechat__reply', input: { text: '第一条' } },
        { type: 'tool_use', name: 'mcp__wechat__reply', input: { text: '第二条' } },
      ] },
    }
    expect(extractClaudeReplies(turn)).toEqual(['第一条', '第二条'])
  })

  it('falls back to text parts when no reply tool called', () => {
    const turn = {
      type: 'assistant',
      message: { role: 'assistant', content: [
        { type: 'text', text: '直接回的' },
        { type: 'tool_use', name: 'mcp__wechat__memory_read', input: {} },
      ] },
    }
    expect(extractClaudeReplies(turn)).toEqual(['直接回的'])
  })

  it('returns empty array for non-assistant turns', () => {
    expect(extractClaudeReplies({ type: 'user', message: {} })).toEqual([])
  })

  it('ignores reply tool calls with empty input.text', () => {
    const turn = {
      type: 'assistant',
      message: { role: 'assistant', content: [
        { type: 'tool_use', name: 'mcp__wechat__reply', input: { text: '' } },
        { type: 'tool_use', name: 'mcp__wechat__reply', input: {} },
      ] },
    }
    expect(extractClaudeReplies(turn)).toEqual([])
  })

  // Per-session noise suppression — when the session uses the reply tool,
  // assistant turns that only have plain text are wrap-up status ("已回复。")
  // and should be hidden, not treated as a reply via the fallback path.
  it('with sessionHasReplyTool=true, suppresses plain-text fallback', () => {
    const turn = {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: '已回复。' }] },
    }
    expect(extractClaudeReplies(turn, { sessionHasReplyTool: true })).toEqual([])
  })

  it('with sessionHasReplyTool=false (default), keeps plain-text fallback', () => {
    const turn = {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: '直接回的' }] },
    }
    expect(extractClaudeReplies(turn)).toEqual(['直接回的'])
    expect(extractClaudeReplies(turn, { sessionHasReplyTool: false })).toEqual(['直接回的'])
  })

  it('with sessionHasReplyTool=true, reply tool inputs still extracted', () => {
    const turn = {
      type: 'assistant',
      message: { role: 'assistant', content: [
        { type: 'tool_use', name: 'mcp__wechat__reply', input: { text: '回复' } },
      ] },
    }
    expect(extractClaudeReplies(turn, { sessionHasReplyTool: true })).toEqual(['回复'])
  })
})

describe('sessionHasReplyTool', () => {
  it('returns true when at least one assistant turn has a reply tool call', () => {
    const turns = [
      { type: 'user', message: { content: 'hi' } },
      { type: 'assistant', message: { content: [
        { type: 'tool_use', name: 'mcp__wechat__reply', input: { text: 'hi back' } },
      ]}},
    ]
    expect(sessionHasReplyTool(turns)).toBe(true)
  })

  it('returns false when no assistant turn has a reply tool', () => {
    const turns = [
      { type: 'user', message: { content: 'hi' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'hi back' }] } },
      { type: 'assistant', message: { content: [
        { type: 'tool_use', name: 'mcp__wechat__memory_read', input: {} },
      ]}},
    ]
    expect(sessionHasReplyTool(turns)).toBe(false)
  })

  it('returns false on empty array', () => {
    expect(sessionHasReplyTool([])).toBe(false)
  })

  it('handles malformed turns defensively', () => {
    expect(sessionHasReplyTool([null, { type: 'user' }, { type: 'assistant', message: null }])).toBe(false)
    expect(sessionHasReplyTool(undefined as any)).toBe(false)
  })
})

describe('turnHtmlCompact', () => {
  it('renders user turn with envelope stripped', () => {
    const html = turnHtmlCompact({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: '<wechat chat_id="x">你好</wechat>' }] },
    })
    expect(html).toContain('你好')
    expect(html).toContain('data-role="user"')
    expect(html).not.toContain('<wechat')
  })

  it('renders assistant reply tool input as bubbles', () => {
    const html = turnHtmlCompact({
      type: 'assistant',
      message: { role: 'assistant', content: [
        { type: 'tool_use', name: 'mcp__wechat__reply', input: { text: '回的' } },
      ] },
    })
    expect(html).toContain('回的')
    expect(html).toContain('data-role="assistant"')
  })

  it('hides attachments / tool_result / queue-operation entirely', () => {
    expect(turnHtmlCompact({ type: 'attachment', attachment: { path: '/x.png' } })).toBe('')
    expect(turnHtmlCompact({ type: 'tool_result', content: 'noise' })).toBe('')
    expect(turnHtmlCompact({ type: 'queue-operation' })).toBe('')
    expect(turnHtmlCompact({ type: 'system' })).toBe('')
  })

  it('hides assistant turn that only made non-reply tool calls', () => {
    const html = turnHtmlCompact({
      type: 'assistant',
      message: { role: 'assistant', content: [
        { type: 'tool_use', name: 'mcp__wechat__memory_list', input: {} },
        { type: 'tool_use', name: 'ToolSearch', input: { query: 'x' } },
      ] },
    })
    expect(html).toBe('')
  })

  it('escapes html in compact mode (xss)', () => {
    const html = turnHtmlCompact({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: '<script>alert(1)</script>' }] },
    })
    expect(html).not.toContain('<script>alert(1)')
    expect(html).toContain('&lt;script&gt;')
  })

  // WeChat-style replica markup (refined V1 from Bundle E)
  it('emits WeChat-style markup for user turn (left row, avatar with initial)', () => {
    const html = turnHtmlCompact({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: '<wechat user="GSR" chat_id="x">我是谁</wechat>' }] },
    })
    expect(html).toContain('wechat-row')
    expect(html).toContain('left')
    expect(html).toContain('wechat-avatar')
    expect(html).toContain('wechat-bubble')
    expect(html).toContain('>G<')         // GSR → 'G'
    expect(html).toContain('我是谁')
    expect(html).not.toContain('<wechat')
  })

  it('uses "?" placeholder when wechat envelope is missing user attr', () => {
    const html = turnHtmlCompact({
      type: 'user',
      message: { content: [{ type: 'text', text: 'hi' }] },
    })
    expect(html).toContain('wechat-avatar')
    expect(html).toContain('>?<')
  })

  it('emits WeChat-style markup for assistant turn (right row, cc avatar)', () => {
    const html = turnHtmlCompact({
      type: 'assistant',
      message: { content: [
        { type: 'tool_use', name: 'mcp__wechat__reply', input: { text: '回复' } },
      ]},
    })
    expect(html).toContain('wechat-row')
    expect(html).toContain('right')
    expect(html).toContain('wechat-avatar-cc')
    expect(html).toContain('回复')
  })

  it('renders user turn with image attachment as a standalone image (no white bubble)', () => {
    const html = turnHtmlCompact({
      type: 'user',
      message: { content: [{ type: 'text', text: '<wechat user="GSR">[image:/inbox/cat.jpg]</wechat>' }] },
    })
    expect(html).toContain('wechat-row')
    expect(html).toContain('left')
    expect(html).toContain('wechat-image')
    expect(html).toContain('cat.jpg')
    // Image rows do NOT use a .wechat-bubble (no white card, no tail)
    expect(html).not.toContain('wechat-bubble"')
  })

  it('renders user turn with file attachment as a file card', () => {
    const html = turnHtmlCompact({
      type: 'user',
      message: { content: [{ type: 'text', text: '<wechat user="GSR">[file:/inbox/doc.pdf]</wechat>' }] },
    })
    expect(html).toContain('wechat-file-card')
    expect(html).toContain('doc.pdf')
    // PDF badge — extension surfaced in upper-case for the icon
    expect(html.toUpperCase()).toContain('PDF')
  })

  it('renders text + image together (text bubble first, image below)', () => {
    const html = turnHtmlCompact({
      type: 'user',
      message: { content: [{ type: 'text', text: '<wechat user="GSR">看图\n[image:/x.jpg]</wechat>' }] },
    })
    const textIdx = html.indexOf('看图')
    const imgIdx = html.indexOf('wechat-image')
    expect(textIdx).toBeGreaterThan(-1)
    expect(imgIdx).toBeGreaterThan(textIdx)
  })

  it('renders [引用] prefix as a quote-ref card BELOW the bubble', () => {
    const html = turnHtmlCompact({
      type: 'user',
      message: { content: [{ type: 'text', text: '<wechat user="GSR">[引用]\n那么图片呢</wechat>' }] },
    })
    expect(html).toContain('wechat-quote-ref')
    expect(html).toContain('那么图片呢')
    expect(html).not.toContain('[引用]')           // marker stripped from text
    // Quote ref must come AFTER the bubble in DOM order (matches WeChat).
    const bubbleIdx = html.indexOf('wechat-bubble"')
    const quoteIdx = html.indexOf('wechat-quote-ref')
    expect(bubbleIdx).toBeGreaterThan(-1)
    expect(quoteIdx).toBeGreaterThan(bubbleIdx)
  })

  it('suppresses daemon "(non-text message)" placeholder when there are attachments', () => {
    const html = turnHtmlCompact({
      type: 'user',
      message: { content: [{ type: 'text', text: '<wechat user="GSR">(non-text message)\n[file:/inbox/x.pdf]</wechat>' }] },
    })
    expect(html).not.toContain('(non-text message)')
    expect(html).toContain('wechat-file-card')
  })

  it('escapes attachment paths to prevent injection', () => {
    const html = turnHtmlCompact({
      type: 'user',
      message: { content: [{ type: 'text', text: '<wechat user="X">[image:/a"><script>alert(1)</script>]</wechat>' }] },
    })
    expect(html).not.toContain('<script>alert(1)')
  })

  it('emits one row per reply for multi-reply assistant turns', () => {
    const html = turnHtmlCompact({
      type: 'assistant',
      message: { content: [
        { type: 'tool_use', name: 'mcp__wechat__reply', input: { text: '一' } },
        { type: 'tool_use', name: 'mcp__wechat__reply', input: { text: '二' } },
      ]},
    })
    const rowCount = (html.match(/wechat-row/g) || []).length
    expect(rowCount).toBe(2)
    expect(html).toContain('一')
    expect(html).toContain('二')
  })

  it('hides plain-text assistant turn when sessionHasReplyTool=true (e.g. "已回复。")', () => {
    const html = turnHtmlCompact(
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '已回复。' }] } },
      { sessionHasReplyTool: true },
    )
    expect(html).toBe('')
  })

  it('keeps plain-text assistant when sessionHasReplyTool=false', () => {
    const html = turnHtmlCompact(
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '直接回的' }] } },
      { sessionHasReplyTool: false },
    )
    expect(html).toContain('直接回的')
  })
})

describe('buildExportMarkdown', () => {
  const turns = [
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: '<wechat user="GSR" chat_id="x">我是谁</wechat>' }] } },
    { type: 'assistant', message: { role: 'assistant', content: [
      { type: 'thinking', thinking: '思考中' },
      { type: 'tool_use', name: 'mcp__wechat__reply', input: { text: '你是 GSR' } },
    ] } },
    { type: 'attachment', attachment: { path: '/x.png' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '已回复。' }] } },
  ]

  it('detailed mode dumps full JSON per turn (developer archive)', () => {
    const md = buildExportMarkdown('compass', 'sid-123', turns, 'detailed')
    expect(md).toContain('# compass')
    expect(md).toContain('Session: sid-123')
    expect(md).toContain('## Turn 1')
    expect(md).toContain('```json')
    expect(md).toContain('"attachment"')
    expect(md).toContain('thinking')
    expect(md).toContain('mcp__wechat__reply')
  })

  it('compact mode renders clean transcript (envelope stripped, noise hidden)', () => {
    const md = buildExportMarkdown('compass', 'sid-123', turns, 'compact')
    expect(md).toContain('# compass')
    expect(md).toContain('我是谁')
    expect(md).toContain('你是 GSR')
    expect(md).not.toContain('<wechat')
    expect(md).not.toContain('attachment')
    expect(md).not.toContain('mcp__wechat__reply')
    expect(md).not.toContain('thinking')
    expect(md).not.toContain('```json')
    // "已回复。" is wrap-up status when reply tool was used — must not appear
    expect(md).not.toContain('已回复。')
  })

  it('compact mode keeps text-fallback when session never used reply tool', () => {
    const turnsNoReplyTool = [
      { type: 'user', message: { content: [{ type: 'text', text: 'hi' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } },
    ]
    const md = buildExportMarkdown('a', 'sid', turnsNoReplyTool, 'compact')
    expect(md).toContain('hi')
    expect(md).toContain('hello')
  })

  it('compact mode is empty-state safe', () => {
    const md = buildExportMarkdown('a', 'sid', [], 'compact')
    expect(md).toContain('# a')
    expect(md).toContain('Session: sid')
  })
})
