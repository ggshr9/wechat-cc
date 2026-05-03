import { describe, it, expect, vi } from 'vitest'
import { registerIlink } from './ilink-lifecycle'

describe('registerIlink', () => {
  it('stop() calls ilink.flush', async () => {
    const flush = vi.fn(async () => {})
    const lc = registerIlink({ ilink: { flush } })
    await lc.stop()
    expect(flush).toHaveBeenCalledOnce()
  })

  it('stop() is idempotent', async () => {
    const flush = vi.fn(async () => {})
    const lc = registerIlink({ ilink: { flush } })
    await lc.stop(); await lc.stop()
    expect(flush).toHaveBeenCalledOnce()
  })
})
