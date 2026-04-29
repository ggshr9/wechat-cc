import { describe, expect, it } from 'vitest'
import {
  observationRow, milestoneCard, formatRelativeTimeShort,
// @ts-expect-error — vanilla JS sibling module; covered at runtime.
} from './observations.js'

describe('observationRow', () => {
  it('renders body + tone-driven glyph + archive button', () => {
    const html = observationRow({ id: 'obs_1', body: '你说过想学吉他', tone: 'curious', ts: '2026-04-29T12:00:00Z' })
    expect(html).toContain('data-id="obs_1"')
    expect(html).toContain('data-tone="curious"')
    expect(html).toContain('你说过想学吉他')
    expect(html).toContain('archive-btn')
  })

  it('escapes html in body to prevent xss', () => {
    const html = observationRow({ id: 'x', body: '<script>alert(1)</script>', ts: '2026-04-29T00:00:00Z' })
    expect(html).not.toContain('<script>alert(1)')
    expect(html).toContain('&lt;script&gt;')
  })

  it('omits tone attribute when not set', () => {
    const html = observationRow({ id: 'x', body: 'plain', ts: '2026-04-29T00:00:00Z' })
    expect(html).not.toContain('data-tone=')
  })
})

describe('milestoneCard', () => {
  it('renders glyph + body + relative time', () => {
    const oneDayAgo = new Date(Date.now() - 86400_000).toISOString()
    const html = milestoneCard({ id: 'ms_100msg', body: '聊了第 100 条', ts: oneDayAgo })
    expect(html).toContain('🎉')
    expect(html).toContain('聊了第 100 条')
    expect(html).toContain('1 天前')
  })
})

describe('formatRelativeTimeShort', () => {
  it('< 1 hr → 刚刚', () => {
    expect(formatRelativeTimeShort(new Date(Date.now() - 30 * 60_000).toISOString())).toBe('刚刚')
  })
  it('1-23 hr → N 小时前', () => {
    expect(formatRelativeTimeShort(new Date(Date.now() - 3 * 3600_000).toISOString())).toBe('3 小时前')
  })
  it('1-29 days → N 天前', () => {
    expect(formatRelativeTimeShort(new Date(Date.now() - 5 * 86400_000).toISOString())).toBe('5 天前')
  })
  it('older → YYYY-MM-DD', () => {
    expect(formatRelativeTimeShort('2025-01-15T00:00:00Z')).toBe('2025-01-15')
  })
})
