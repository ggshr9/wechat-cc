import { describe, it, expect, vi } from 'vitest'
import { registerCompanionPush, registerCompanionIntrospect } from './lifecycle'

describe('registerCompanionPush', () => {
  it('returns a Lifecycle with name=companion-push', () => {
    const lc = registerCompanionPush({
      shouldRun: () => false,
      log: () => {},
      onTick: async () => {},
    })
    expect(lc.name).toBe('companion-push')
    expect(typeof lc.stop).toBe('function')
  })

  it('stop() is idempotent', async () => {
    const lc = registerCompanionPush({
      shouldRun: () => false,
      log: () => {},
      onTick: async () => {},
    })
    await lc.stop()
    await expect(lc.stop()).resolves.toBeUndefined()
  })
})

describe('registerCompanionIntrospect', () => {
  it('returns a Lifecycle with name=companion-introspect', () => {
    const lc = registerCompanionIntrospect({
      shouldRun: () => false,
      log: () => {},
      onTick: async () => {},
    })
    expect(lc.name).toBe('companion-introspect')
  })
})

describe('intervalMs override', () => {
  // 1B ms ≈ 11.5 days. Chosen so even after the scheduler's ±30% jitter the
  // resulting setTimeout delay (≤1.3B ms) stays under int32 max (~2.15B ms).
  // Passing the raw int32 max would overflow when multiplied by jitter and
  // Node would clamp the timer to ~1ms — defeating the suppression intent.
  const SAFE_INFINITY_MS = 1_000_000_000

  it('honors an intervalMs override (push)', () => {
    const onTick = vi.fn(async () => {})
    // SAFE_INFINITY-style large value so the scheduler never fires within the test.
    const lc = registerCompanionPush({
      shouldRun: () => true,
      log: () => {},
      onTick,
      intervalMs: SAFE_INFINITY_MS,
    })
    // No assertion on tick count — just verify the call doesn't crash and the
    // scheduler accepts the override. setTimeout with INT32_MAX is well-formed.
    expect(lc.name).toBe('companion-push')
    return lc.stop()
  })

  it('honors an intervalMs override (introspect)', () => {
    const onTick = vi.fn(async () => {})
    const lc = registerCompanionIntrospect({
      shouldRun: () => true,
      log: () => {},
      onTick,
      intervalMs: SAFE_INFINITY_MS,
    })
    expect(lc.name).toBe('companion-introspect')
    return lc.stop()
  })
})
