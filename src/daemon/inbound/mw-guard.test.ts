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

  it('still fires when reachable=false and ip=null (probe failed completely)', async () => {
    // ip=null means we could not even determine the outbound IP — that's a
    // worse network state than knowing-the-IP-but-can't-reach, not a reason
    // to let the message through silently. Fire with a fallback marker so
    // the user still gets the heads-up.
    const sendMessage = vi.fn(async (_chatId: string, _text: string) => ({ msgId: 'm1' }))
    const next = vi.fn()
    const mw = makeMwGuard({
      guardEnabled: () => true,
      guardState: () => ({ reachable: false, ip: null }),
      sendMessage,
      log: () => {},
    })
    const ctx: InboundCtx = { msg: { chatId: 'c1' } as InboundCtx['msg'], receivedAtMs: 0, requestId: 'r' }
    await mw(ctx, next)
    expect(ctx.consumedBy).toBe('guard')
    expect(sendMessage).toHaveBeenCalledOnce()
    expect(next).not.toHaveBeenCalled()
    const sentText = sendMessage.mock.calls[0]?.[1]
    expect(sentText).toMatch(/未知|unknown/i)
  })
})
