import { describe, expect, it } from 'vitest'
// @ts-expect-error JS sibling
import { groupProjectsByRecency, projectRow, searchHitRow, turnHtml } from './sessions.js'

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

  it('shows v0.4.1 deferral placeholder when summary is missing', () => {
    // Per-project summarizer is deferred to v0.4.1; the placeholder names
    // the deferral so users aren't left wondering why every row is blank.
    const html = projectRow({
      alias: 'x',
      session_id: 's',
      last_used_at: new Date().toISOString(),
    })
    expect(html).toContain('class="summary empty"')
    expect(html).toContain('v0.4.1')
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
