import { describe, expect, it } from 'vitest'
// @ts-expect-error JS sibling
import { groupProjectsByRecency, projectRow, searchHitRow, turnHtml, turnHtmlCompact, extractUserText, extractClaudeReplies, sessionHasReplyTool, buildExportMarkdown } from './sessions.js'

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
