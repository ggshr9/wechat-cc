import { describe, it, expect } from 'vitest'
import { isoFromMs } from './iso-time'

describe('isoFromMs', () => {
  it('returns the ISO string for a normal epoch-ms value', () => {
    expect(isoFromMs(1.7e12, 0)).toBe(new Date(1.7e12).toISOString())
  })

  it('falls back to fallbackMs for an out-of-range value (no RangeError)', () => {
    const fallback = 1.7e12
    expect(() => isoFromMs(1e16, fallback)).not.toThrow()
    expect(isoFromMs(1e16, fallback)).toBe(new Date(fallback).toISOString())
  })

  it('falls back to now when BOTH value and fallback are out of range', () => {
    expect(() => isoFromMs(1e16, 1e16)).not.toThrow()
    expect(isoFromMs(1e16, 1e16)).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/)
  })

  it('handles negative out-of-range values too', () => {
    expect(() => isoFromMs(-1e16, 1.7e12)).not.toThrow()
    expect(isoFromMs(-1e16, 1.7e12)).toBe(new Date(1.7e12).toISOString())
  })
})
