import { describe, it, expect, vi } from 'vitest'
import { makeMwGuard } from './mw-guard'
import type { InboundCtx } from './types'

describe('mwGuard', () => {
  it('refuses + sets consumedBy=guard when guard enabled and not reachable', async () => {
    const sendMessage = vi.fn(async () => ({ msgId: 'm1' }))
    const mw = makeMwGuard({
      guardEnabled: () => true,
      guardState: () => ({ reachable: false, ip: '1.2.3.4' }),
      sendMessage,
      log: () => {},
    })
    const ctx: InboundCtx = { msg: { chatId: 'c1' } as InboundCtx['msg'], receivedAtMs: 0, requestId: 'r' }
    const next = vi.fn()
    await mw(ctx, next)
    expect(ctx.consumedBy).toBe('guard')
    expect(sendMessage).toHaveBeenCalledOnce()
    expect(next).not.toHaveBeenCalled()
  })

  it('passes through when guard disabled', async () => {
    const next = vi.fn(async () => {})
    const mw = makeMwGuard({
      guardEnabled: () => false,
      guardState: () => ({ reachable: false, ip: '1.2.3.4' }),
      sendMessage: vi.fn(),
      log: () => {},
    })
    await mw({ msg: { chatId: 'c1' } as InboundCtx['msg'], receivedAtMs: 0, requestId: 'r' }, next)
    expect(next).toHaveBeenCalledOnce()
  })

  it('passes through when reachable', async () => {
    const next = vi.fn(async () => {})
    const mw = makeMwGuard({
      guardEnabled: () => true,
      guardState: () => ({ reachable: true, ip: '1.2.3.4' }),
      sendMessage: vi.fn(),
      log: () => {},
    })
    await mw({ msg: { chatId: 'c1' } as InboundCtx['msg'], receivedAtMs: 0, requestId: 'r' }, next)
    expect(next).toHaveBeenCalledOnce()
  })
})
