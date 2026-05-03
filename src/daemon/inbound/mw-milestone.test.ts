import { describe, it, expect, vi } from 'vitest'
import { makeMwMilestone } from './mw-milestone'
import type { InboundCtx } from './types'

const mkCtx = (over: Partial<InboundCtx> = {}): InboundCtx => ({
  msg: { chatId: 'c1', createTimeMs: 1000 } as InboundCtx['msg'],
  receivedAtMs: 5000,
  requestId: 'r',
  ...over,
})

describe('mwMilestone', () => {
  it('calls fireMilestonesFor after next() when consumedBy unset', async () => {
    const fireMilestonesFor = vi.fn(async () => {})
    const mw = makeMwMilestone({ fireMilestonesFor, log: () => {} })
    await mw(mkCtx(), async () => {})
    expect(fireMilestonesFor).toHaveBeenCalledWith('c1')
  })

  it('fires for the correct chatId', async () => {
    const fireMilestonesFor = vi.fn(async () => {})
    const mw = makeMwMilestone({ fireMilestonesFor, log: () => {} })
    await mw(mkCtx({ msg: { chatId: 'c2', createTimeMs: 2000 } as InboundCtx['msg'] }), async () => {})
    expect(fireMilestonesFor).toHaveBeenCalledWith('c2')
  })

  it('skips when consumedBy is set', async () => {
    const fireMilestonesFor = vi.fn(async () => {})
    const mw = makeMwMilestone({ fireMilestonesFor, log: () => {} })
    const ctx = mkCtx()
    await mw(ctx, async () => { ctx.consumedBy = 'admin' })
    expect(fireMilestonesFor).not.toHaveBeenCalled()
  })

  it('catches fireMilestonesFor failure (does not throw)', async () => {
    const lines: string[] = []
    const mw = makeMwMilestone({
      fireMilestonesFor: async () => { throw new Error('milestone err') },
      log: (t, l) => lines.push(`${t} ${l}`),
    })
    await expect(mw(mkCtx(), async () => {})).resolves.toBeUndefined()
    // Allow microtask queue to flush
    await new Promise(r => setImmediate(r))
    expect(lines.some(l => l.startsWith('MILESTONE') && l.includes('milestone err'))).toBe(true)
  })
})
