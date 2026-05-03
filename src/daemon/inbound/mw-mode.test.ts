import { describe, it, expect, vi } from 'vitest'
import { makeMwMode } from './mw-mode'
import type { InboundCtx } from './types'

const mkCtx = (): InboundCtx => ({
  msg: { chatId: 'c1', text: '/cc' } as InboundCtx['msg'],
  receivedAtMs: 0,
  requestId: 'r',
})

describe('mwMode', () => {
  it('short-circuits when handler returns true; sets consumedBy=mode', async () => {
    const next = vi.fn()
    const handler = { handle: vi.fn(async () => true) }
    const mw = makeMwMode({ modeHandler: handler })
    const ctx = mkCtx()
    await mw(ctx, next)
    expect(ctx.consumedBy).toBe('mode')
    expect(next).not.toHaveBeenCalled()
    expect(handler.handle).toHaveBeenCalledWith(ctx.msg)
  })

  it('passes through when handler returns false', async () => {
    const next = vi.fn(async () => {})
    const handler = { handle: vi.fn(async () => false) }
    const mw = makeMwMode({ modeHandler: handler })
    const ctx = mkCtx()
    await mw(ctx, next)
    expect(ctx.consumedBy).toBeUndefined()
    expect(next).toHaveBeenCalledOnce()
  })
})
