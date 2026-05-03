import { describe, it, expect } from 'vitest'
import { registerGuard } from './lifecycle'

describe('registerGuard', () => {
  it('returns a Lifecycle with name=guard and current() method', () => {
    const lc = registerGuard({
      pollMs: 30_000,
      isEnabled: () => false,
      probeUrl: () => 'https://google.com',
      ipifyUrl: () => 'https://api.ipify.org',
      log: () => {},
      onStateChange: async () => {},
    })
    expect(lc.name).toBe('guard')
    expect(typeof lc.current).toBe('function')
    expect(lc.current()).toEqual(expect.objectContaining({ reachable: expect.any(Boolean) }))
  })

  it('stop() is idempotent', async () => {
    const lc = registerGuard({
      pollMs: 30_000,
      isEnabled: () => false,
      probeUrl: () => 'https://google.com',
      ipifyUrl: () => 'https://api.ipify.org',
      log: () => {},
      onStateChange: async () => {},
    })
    await lc.stop()
    await expect(lc.stop()).resolves.toBeUndefined()
  })
})
