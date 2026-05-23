import { describe, it, expect, vi } from 'vitest'
import { makeMwAccess } from './mw-access'
import type { InboundCtx } from './types'
import type { Access } from '../../lib/access'

function makeCtx(chatId: string): InboundCtx {
  return {
    msg: { chatId } as InboundCtx['msg'],
    receivedAtMs: 0,
    requestId: 'r',
  }
}

describe('mwAccess', () => {
  it('passes through allowlisted chat', async () => {
    const mw = makeMwAccess({
      loadAccess: (): Access => ({ dmPolicy: 'allowlist', allowFrom: ['ok'] }),
      log: () => {},
    })
    const ctx = makeCtx('ok')
    const next = vi.fn(async () => {})
    await mw(ctx, next)
    expect(next).toHaveBeenCalledOnce()
    expect(ctx.consumedBy).toBeUndefined()
  })

  it('drops non-allowlisted chat with consumedBy=access', async () => {
    const log = vi.fn()
    const mw = makeMwAccess({
      loadAccess: (): Access => ({ dmPolicy: 'allowlist', allowFrom: ['ok'] }),
      log,
    })
    const ctx = makeCtx('blocked')
    const next = vi.fn(async () => {})
    await mw(ctx, next)
    expect(next).not.toHaveBeenCalled()
    expect(ctx.consumedBy).toBe('access')
    expect(log).toHaveBeenCalledWith('ACCESS', expect.stringContaining('drop'))
    expect(log).toHaveBeenCalledWith('ACCESS', expect.stringContaining('not_in_allowlist'))
  })

  it('drops everything when dmPolicy=disabled (even allowlisted chats)', async () => {
    const log = vi.fn()
    const mw = makeMwAccess({
      loadAccess: (): Access => ({ dmPolicy: 'disabled', allowFrom: ['ok'] }),
      log,
    })
    const ctx = makeCtx('ok')
    const next = vi.fn(async () => {})
    await mw(ctx, next)
    expect(next).not.toHaveBeenCalled()
    expect(ctx.consumedBy).toBe('access')
    expect(log).toHaveBeenCalledWith('ACCESS', expect.stringContaining('dm_policy_disabled'))
  })

  it("'*' wildcard in allowFrom matches every chat (e2e harness default)", async () => {
    const mw = makeMwAccess({
      loadAccess: (): Access => ({ dmPolicy: 'allowlist', allowFrom: ['*'] }),
      log: () => {},
    })
    const ctx = makeCtx('anyone')
    const next = vi.fn(async () => {})
    await mw(ctx, next)
    expect(next).toHaveBeenCalledOnce()
    expect(ctx.consumedBy).toBeUndefined()
  })

  it("'*' wildcard still drops when dmPolicy=disabled (disabled wins)", async () => {
    const mw = makeMwAccess({
      loadAccess: (): Access => ({ dmPolicy: 'disabled', allowFrom: ['*'] }),
      log: () => {},
    })
    const ctx = makeCtx('anyone')
    const next = vi.fn(async () => {})
    await mw(ctx, next)
    expect(next).not.toHaveBeenCalled()
    expect(ctx.consumedBy).toBe('access')
  })

  it('drops when allowFrom is empty (first-run / no access.json setup)', async () => {
    // Default access from disk is { dmPolicy: 'allowlist', allowFrom: [] } —
    // verify that *every* sender is blocked when nothing has been allowlisted yet.
    const mw = makeMwAccess({
      loadAccess: (): Access => ({ dmPolicy: 'allowlist', allowFrom: [] }),
      log: () => {},
    })
    const ctx = makeCtx('anyone')
    const next = vi.fn(async () => {})
    await mw(ctx, next)
    expect(next).not.toHaveBeenCalled()
    expect(ctx.consumedBy).toBe('access')
  })
})
