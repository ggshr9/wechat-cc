import { describe, it, expect, vi } from 'vitest'
import { makeMwPermissionReply } from './mw-permission-reply'
import type { InboundCtx } from './types'

describe('mwPermissionReply', () => {
  it('short-circuits when handlePermissionReply consumes (returns true); sets consumedBy=permission-reply', async () => {
    const next = vi.fn()
    const mw = makeMwPermissionReply({ handlePermissionReply: () => true, log: () => {} })
    const ctx: InboundCtx = { msg: { chatId: 'c1', text: 'y abc12' } as InboundCtx['msg'], receivedAtMs: 0, requestId: 'r' }
    await mw(ctx, next)
    expect(ctx.consumedBy).toBe('permission-reply')
    expect(next).not.toHaveBeenCalled()
  })

  it('passes through when handler returns false', async () => {
    const next = vi.fn(async () => {})
    const mw = makeMwPermissionReply({ handlePermissionReply: () => false, log: () => {} })
    await mw({ msg: { chatId: 'c1', text: 'hi' } as InboundCtx['msg'], receivedAtMs: 0, requestId: 'r' }, next)
    expect(next).toHaveBeenCalledOnce()
  })
})
