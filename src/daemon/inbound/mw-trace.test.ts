import { describe, it, expect, vi } from 'vitest'
import { makeMwTrace } from './mw-trace'
import type { InboundCtx } from './types'

const mkCtx = (): InboundCtx => ({
  msg: { chatId: 'c1' } as InboundCtx['msg'],
  receivedAtMs: Date.now(),
  requestId: 'req1',
})

describe('mwTrace', () => {
  it('logs INBOUND with consumed=dispatched when consumedBy unset', async () => {
    const lines: Array<[string, string]> = []
    const mw = makeMwTrace({ log: (t, l) => lines.push([t, l]) })
    await mw(mkCtx(), async () => {})
    expect(lines.some(([t, l]) => t === 'INBOUND' && l.includes('consumed=dispatched'))).toBe(true)
  })

  it('logs consumed=<consumedBy> when set', async () => {
    const lines: Array<[string, string]> = []
    const mw = makeMwTrace({ log: (t, l) => lines.push([t, l]) })
    const ctx = mkCtx()
    await mw(ctx, async () => { ctx.consumedBy = 'admin' })
    expect(lines.some(([t, l]) => t === 'INBOUND' && l.includes('consumed=admin'))).toBe(true)
  })

  it('catches inner error, logs INBOUND_ERROR, does not rethrow', async () => {
    const lines: Array<[string, string]> = []
    const mw = makeMwTrace({ log: (t, l) => lines.push([t, l]) })
    await expect(mw(mkCtx(), async () => { throw new Error('inner-boom') })).resolves.toBeUndefined()
    expect(lines.some(([t, l]) => t === 'INBOUND_ERROR' && l.includes('inner-boom'))).toBe(true)
  })
})
