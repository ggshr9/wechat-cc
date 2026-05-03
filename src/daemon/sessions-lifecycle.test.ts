import { describe, it, expect, vi } from 'vitest'
import { registerSessions } from './sessions-lifecycle'

describe('registerSessions', () => {
  it('stop() calls shutdown, then both flushes, in order', async () => {
    const order: string[] = []
    const lc = registerSessions({
      sessionManager: { shutdown: vi.fn(async () => { order.push('shutdown') }) },
      sessionStore: { flush: vi.fn(async () => { order.push('store') }) },
      conversationStore: { flush: vi.fn(async () => { order.push('conv') }) },
    })
    await lc.stop()
    expect(order).toEqual(['shutdown', 'store', 'conv'])
  })

  it('stop() is idempotent', async () => {
    const shutdown = vi.fn(async () => {})
    const lc = registerSessions({
      sessionManager: { shutdown },
      sessionStore: { flush: vi.fn(async () => {}) },
      conversationStore: { flush: vi.fn(async () => {}) },
    })
    await lc.stop(); await lc.stop()
    expect(shutdown).toHaveBeenCalledOnce()
  })
})
