import { describe, it, expect } from 'vitest'
import { findOnPath } from './util'

describe('findOnPath', () => {
  it('finds bun (known to be installed)', () => {
    const result = findOnPath('bun')
    expect(result).toBeTruthy()
    expect(result!.length).toBeGreaterThan(0)
    // Should be an absolute path
    expect(result!.startsWith('/') || /^[A-Z]:\\/i.test(result!)).toBe(true)
  })

  it('returns null for a nonexistent command', () => {
    expect(findOnPath('definitely-not-a-real-command-xyzzy-42')).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(findOnPath('')).toBeNull()
  })
})
