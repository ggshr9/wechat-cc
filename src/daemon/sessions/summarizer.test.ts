import { describe, expect, it } from 'vitest'
import { needsRefresh, formatSummaryRequest } from './summarizer'

describe('summarizer.needsRefresh', () => {
  it('returns true when no summary exists', () => {
    expect(needsRefresh({ session_id: 's', last_used_at: new Date().toISOString() })).toBe(true)
  })

  it('returns true when summary older than ttlDays', () => {
    const oldTs = new Date(Date.now() - 8 * 86400_000).toISOString()
    const fresh = new Date().toISOString()
    expect(needsRefresh({ session_id: 's', last_used_at: fresh, summary: 'x', summary_updated_at: oldTs }, 7)).toBe(true)
  })

  it('returns false when summary fresh', () => {
    const fresh = new Date().toISOString()
    expect(needsRefresh({ session_id: 's', last_used_at: fresh, summary: 'x', summary_updated_at: fresh }, 7)).toBe(false)
  })

  it('returns true when last_used_at is newer than summary_updated_at', () => {
    const old = new Date(Date.now() - 2 * 86400_000).toISOString()
    const recent = new Date().toISOString()
    expect(needsRefresh({ session_id: 's', last_used_at: recent, summary: 'x', summary_updated_at: old }, 7)).toBe(true)
  })
})

describe('summarizer.formatSummaryRequest', () => {
  it('builds a prompt that asks for one short Chinese line', () => {
    const turns = [
      { role: 'user' as const, text: '帮我看一下 ilink-glue.ts' },
      { role: 'assistant' as const, text: '我修了 transport 那块' },
    ]
    const prompt = formatSummaryRequest(turns)
    expect(prompt).toContain('一句话')
    expect(prompt).toContain('ilink-glue')
    expect(prompt.length).toBeLessThan(2000)
  })
})
