import { describe, it, expect, vi } from 'vitest'
import { registerPolling } from './polling-lifecycle'
import type { InboundCtx } from './inbound/types'

describe('registerPolling', () => {
  it('returns Lifecycle with name=polling and reconcile()', () => {
    const lc = registerPolling({
      stateDir: '/tmp/wechat-cc',
      accounts: [],
      ilink: { getUpdates: async () => ({ updates: [] }) },
      parse: () => [],
      resolveUserName: () => undefined,
      log: () => {},
      runPipeline: async (_ctx: InboundCtx) => {},
    })
    expect(lc.name).toBe('polling')
    expect(typeof lc.reconcile).toBe('function')
  })

  it('stop() is idempotent', async () => {
    const lc = registerPolling({
      stateDir: '/tmp/wechat-cc',
      accounts: [],
      ilink: { getUpdates: async () => ({ updates: [] }) },
      parse: () => [],
      resolveUserName: () => undefined,
      log: () => {},
      runPipeline: async () => {},
    })
    await lc.stop(); await expect(lc.stop()).resolves.toBeUndefined()
  })
})
