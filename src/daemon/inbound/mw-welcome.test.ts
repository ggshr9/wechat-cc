import { describe, it, expect, vi } from 'vitest'
import { makeMwWelcome } from './mw-welcome'
import type { InboundCtx } from './types'

const mkCtx = (over: Partial<InboundCtx> = {}): InboundCtx => ({
  msg: { chatId: 'c1', createTimeMs: 1000 } as InboundCtx['msg'],
  receivedAtMs: 5000,
  requestId: 'r',
  ...over,
})

describe('mwWelcome', () => {
  it('calls maybeWriteWelcomeObservation after next() when consumedBy unset', async () => {
    const maybeWriteWelcomeObservation = vi.fn(async () => {})
    const mw = makeMwWelcome({ maybeWriteWelcomeObservation, log: () => {} })
    await mw(mkCtx(), async () => {})
    expect(maybeWriteWelcomeObservation).toHaveBeenCalledWith('c1')
  })

  it('fires for the correct chatId', async () => {
    const maybeWriteWelcomeObservation = vi.fn(async () => {})
    const mw = makeMwWelcome({ maybeWriteWelcomeObservation, log: () => {} })
    await mw(mkCtx({ msg: { chatId: 'c2', createTimeMs: 2000 } as InboundCtx['msg'] }), async () => {})
    expect(maybeWriteWelcomeObservation).toHaveBeenCalledWith('c2')
  })

  it('skips when consumedBy is set', async () => {
    const maybeWriteWelcomeObservation = vi.fn(async () => {})
    const mw = makeMwWelcome({ maybeWriteWelcomeObservation, log: () => {} })
    const ctx = mkCtx()
    await mw(ctx, async () => { ctx.consumedBy = 'admin' })
    expect(maybeWriteWelcomeObservation).not.toHaveBeenCalled()
  })

  it('catches maybeWriteWelcomeObservation failure (does not throw)', async () => {
    const lines: string[] = []
    const mw = makeMwWelcome({
      maybeWriteWelcomeObservation: async () => { throw new Error('welcome err') },
      log: (t, l) => lines.push(`${t} ${l}`),
    })
    await expect(mw(mkCtx(), async () => {})).resolves.toBeUndefined()
    // Allow microtask queue to flush
    await new Promise(r => setImmediate(r))
    expect(lines.some(l => l.startsWith('OBSERVE') && l.includes('welcome err'))).toBe(true)
  })
})
