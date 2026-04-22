import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { PendingPermissions, parsePermissionReply } from './pending-permissions'

describe('PendingPermissions', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('consume resolves register() promise with allow', async () => {
    const reg = new PendingPermissions()
    const p = reg.register('abc12', 10_000)
    const matched = reg.consume('abc12', 'allow')
    expect(matched).toBe(true)
    await expect(p).resolves.toBe('allow')
  })

  it('consume resolves register() promise with deny', async () => {
    const reg = new PendingPermissions()
    const p = reg.register('xyz99', 10_000)
    expect(reg.consume('xyz99', 'deny')).toBe(true)
    await expect(p).resolves.toBe('deny')
  })

  it('consume returns false when hash not registered', () => {
    const reg = new PendingPermissions()
    expect(reg.consume('ghost', 'allow')).toBe(false)
  })

  it('consume returns false when hash already consumed', async () => {
    const reg = new PendingPermissions()
    const p = reg.register('dup', 10_000)
    reg.consume('dup', 'allow')
    await p
    expect(reg.consume('dup', 'deny')).toBe(false)
  })

  it('sweep resolves expired entries as timeout', async () => {
    const reg = new PendingPermissions()
    const p = reg.register('exp', 1_000)
    vi.advanceTimersByTime(2_000)
    reg.sweep()
    await expect(p).resolves.toBe('timeout')
  })

  it('sweep does not resolve non-expired entries', () => {
    const reg = new PendingPermissions()
    reg.register('fresh', 10_000)
    vi.advanceTimersByTime(1_000)
    reg.sweep()
    expect(reg.size()).toBe(1)
  })

  it('size reflects active pending entries', async () => {
    const reg = new PendingPermissions()
    expect(reg.size()).toBe(0)
    reg.register('a', 10_000)
    reg.register('b', 10_000)
    expect(reg.size()).toBe(2)
    reg.consume('a', 'allow')
    expect(reg.size()).toBe(1)
  })
})

describe('parsePermissionReply', () => {
  it('parses strict form: "y abc12"', () => {
    expect(parsePermissionReply('y abc12')).toEqual({ decision: 'allow', hash: 'abc12' })
    expect(parsePermissionReply('n xyz99')).toEqual({ decision: 'deny', hash: 'xyz99' })
  })

  it('is case-insensitive on the y/n letter', () => {
    expect(parsePermissionReply('Y abc12')).toEqual({ decision: 'allow', hash: 'abc12' })
    expect(parsePermissionReply('N xyz99')).toEqual({ decision: 'deny', hash: 'xyz99' })
  })

  it('tolerates leading/trailing whitespace', () => {
    expect(parsePermissionReply('  y abc12  ')).toEqual({ decision: 'allow', hash: 'abc12' })
  })

  it('returns null for non-matching input', () => {
    expect(parsePermissionReply('yes')).toBeNull()
    expect(parsePermissionReply('y')).toBeNull()
    expect(parsePermissionReply('allow abc12')).toBeNull()
    expect(parsePermissionReply('y abc12 extra')).toBeNull()
  })

  it('expects a 5-char hash', () => {
    expect(parsePermissionReply('y abcd')).toBeNull()   // 4 chars
    expect(parsePermissionReply('y abcdef')).toBeNull() // 6 chars
    expect(parsePermissionReply('y abc12')).not.toBeNull()
  })
})
