import { describe, it, expect, vi } from 'vitest'
import { registerCompanionPush, registerCompanionIntrospect } from './lifecycle'

describe('registerCompanionPush', () => {
  it('returns a Lifecycle with name=companion-push', () => {
    const lc = registerCompanionPush({
      isEnabled: () => false,
      isSnoozed: () => false,
      log: () => {},
      onTick: async () => {},
    })
    expect(lc.name).toBe('companion-push')
    expect(typeof lc.stop).toBe('function')
  })

  it('stop() is idempotent', async () => {
    const lc = registerCompanionPush({
      isEnabled: () => false,
      isSnoozed: () => false,
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
      isEnabled: () => false,
      isSnoozed: () => false,
      log: () => {},
      onTick: async () => {},
    })
    expect(lc.name).toBe('companion-introspect')
  })
})
