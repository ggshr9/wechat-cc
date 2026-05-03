import { describe, it, expect, vi } from 'vitest'
import { makeMwAdmin } from './mw-admin'
import type { InboundCtx } from './types'

const mkCtx = (): InboundCtx => ({
  msg: { chatId: 'c1', text: '/health' } as InboundCtx['msg'],
  receivedAtMs: 0,
  requestId: 'r',
})

describe('mwAdmin', () => {
  it('short-circuits when handler returns true; sets consumedBy=admin', async () => {
    const next = vi.fn()
    const handler = { handle: vi.fn(async () => true) }
    const mw = makeMwAdmin({ adminHandler: handler })
    const ctx = mkCtx()
    await mw(ctx, next)
    expect(ctx.consumedBy).toBe('admin')
    expect(next).not.toHaveBeenCalled()
  })

  it('passes through when handler returns false', async () => {
    const next = vi.fn(async () => {})
    const handler = { handle: vi.fn(async () => false) }
    const mw = makeMwAdmin({ adminHandler: handler })
    const ctx = mkCtx()
    await mw(ctx, next)
    expect(ctx.consumedBy).toBeUndefined()
    expect(next).toHaveBeenCalledOnce()
  })
})
