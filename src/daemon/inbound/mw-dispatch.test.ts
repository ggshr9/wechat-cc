import { describe, it, expect, vi } from 'vitest'
import { makeMwDispatch } from './mw-dispatch'
import type { InboundCtx } from './types'

describe('mwDispatch', () => {
  it('calls coordinator.dispatch with ctx.msg; never calls next()', async () => {
    const dispatch = vi.fn(async () => {})
    const next = vi.fn()
    const mw = makeMwDispatch({ coordinator: { dispatch } })
    const msg = { chatId: 'c1' } as InboundCtx['msg']
    await mw({ msg, receivedAtMs: 0, requestId: 'r' }, next)
    expect(dispatch).toHaveBeenCalledWith(msg)
    expect(next).not.toHaveBeenCalled()
  })

  it('propagates dispatch errors (caught by mwTrace at outer)', async () => {
    const mw = makeMwDispatch({ coordinator: { dispatch: async () => { throw new Error('coord-boom') } } })
    await expect(mw({ msg: {} as InboundCtx['msg'], receivedAtMs: 0, requestId: 'r' }, async () => {}))
      .rejects.toThrow('coord-boom')
  })
})
