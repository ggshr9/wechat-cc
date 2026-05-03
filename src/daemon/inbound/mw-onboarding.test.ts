import { describe, it, expect, vi } from 'vitest'
import { makeMwOnboarding } from './mw-onboarding'
import type { InboundCtx } from './types'

const mkCtx = (): InboundCtx => ({
  msg: { chatId: 'c1', text: 'hi' } as InboundCtx['msg'],
  receivedAtMs: 0,
  requestId: 'r',
})

describe('mwOnboarding', () => {
  it('short-circuits when handler returns true; sets consumedBy=onboarding', async () => {
    const next = vi.fn()
    const handler = { handle: vi.fn(async () => true) }
    const mw = makeMwOnboarding({ onboardingHandler: handler })
    const ctx = mkCtx()
    await mw(ctx, next)
    expect(ctx.consumedBy).toBe('onboarding')
    expect(next).not.toHaveBeenCalled()
    expect(handler.handle).toHaveBeenCalledWith(ctx.msg)
  })

  it('passes through when handler returns false', async () => {
    const next = vi.fn(async () => {})
    const handler = { handle: vi.fn(async () => false) }
    const mw = makeMwOnboarding({ onboardingHandler: handler })
    const ctx = mkCtx()
    await mw(ctx, next)
    expect(ctx.consumedBy).toBeUndefined()
    expect(next).toHaveBeenCalledOnce()
  })
})
