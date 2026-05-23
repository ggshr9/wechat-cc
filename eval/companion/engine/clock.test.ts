import { describe, it, expect } from 'vitest'
import { parseIso, toIsoUtc, SAFE_INFINITY_MS } from './clock'

describe('clock helpers', () => {
  it('parses ISO 8601 with timezone offset', () => {
    const d = parseIso('2026-05-13T09:30:00+08:00')
    // 09:30 +0800 == 01:30 UTC
    expect(d.toISOString()).toBe('2026-05-13T01:30:00.000Z')
  })

  it('toIsoUtc returns Z-suffixed UTC iso', () => {
    const d = parseIso('2026-05-13T09:30:00+08:00')
    expect(toIsoUtc(d)).toBe('2026-05-13T01:30:00.000Z')
  })

  it('rejects malformed input', () => {
    expect(() => parseIso('not a date')).toThrow(/parseIso/)
  })

  it('SAFE_INFINITY_MS leaves jitter headroom under int32 setTimeout cap', () => {
    expect(SAFE_INFINITY_MS).toBe(1_000_000_000)
    // 1.3x jitter still fits in int32 (2^31 - 1 ≈ 2.147B)
    expect(SAFE_INFINITY_MS * 1.3).toBeLessThan(2 ** 31 - 1)
  })
})
