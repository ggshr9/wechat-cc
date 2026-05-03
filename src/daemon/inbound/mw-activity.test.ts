import { describe, it, expect, vi } from 'vitest'
import { makeMwActivity } from './mw-activity'
import type { InboundCtx } from './types'

const mkCtx = (over: Partial<InboundCtx> = {}): InboundCtx => ({
  msg: { chatId: 'c1', createTimeMs: 1000 } as InboundCtx['msg'],
  receivedAtMs: 5000,
  requestId: 'r',
  ...over,
})

describe('mwActivity', () => {
  it('calls recordInbound after next() when consumedBy unset', async () => {
    const recordInbound = vi.fn(async () => {})
    const mw = makeMwActivity({ recordInbound, log: () => {} })
    await mw(mkCtx(), async () => {})
    expect(recordInbound).toHaveBeenCalledWith('c1', new Date(1000))
  })

  it('uses receivedAtMs when createTimeMs is 0 (poll-loop normalises missing ts to 0)', async () => {
    const recordInbound = vi.fn(async () => {})
    const mw = makeMwActivity({ recordInbound, log: () => {} })
    await mw(mkCtx({ msg: { chatId: 'c1', createTimeMs: 0 } as InboundCtx['msg'] }), async () => {})
    expect(recordInbound).toHaveBeenCalledWith('c1', new Date(5000))
  })

  it('skips when consumedBy is set', async () => {
    const recordInbound = vi.fn(async () => {})
    const mw = makeMwActivity({ recordInbound, log: () => {} })
    const ctx = mkCtx()
    await mw(ctx, async () => { ctx.consumedBy = 'admin' })
    expect(recordInbound).not.toHaveBeenCalled()
  })

  it('catches recordInbound failure (does not throw)', async () => {
    const lines: string[] = []
    const mw = makeMwActivity({
      recordInbound: async () => { throw new Error('db down') },
      log: (t, l) => lines.push(`${t} ${l}`),
    })
    await expect(mw(mkCtx(), async () => {})).resolves.toBeUndefined()
    // Allow microtask queue to flush
    await new Promise(r => setImmediate(r))
    expect(lines.some(l => l.startsWith('ACTIVITY') && l.includes('db down'))).toBe(true)
  })
})
