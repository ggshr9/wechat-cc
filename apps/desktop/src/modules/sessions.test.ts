import { describe, expect, it } from 'vitest'
// @ts-expect-error JS sibling
import { groupProjectsByRecency, projectRow, searchHitRow } from './sessions.js'

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
