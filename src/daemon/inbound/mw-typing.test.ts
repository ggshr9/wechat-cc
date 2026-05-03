// mw-typing.test.ts
import { describe, it, expect, vi } from 'vitest'
import { makeMwTyping } from './mw-typing'
import type { InboundCtx } from './types'

describe('mwTyping', () => {
  it('fires sendTyping (no await) and continues', async () => {
    const sendTyping = vi.fn(async () => {})
    const mw = makeMwTyping({ sendTyping })
    let nextCalled = false
    await mw(
      { msg: { chatId: 'c1', accountId: 'a1' } as InboundCtx['msg'], receivedAtMs: 0, requestId: 'r' },
      async () => { nextCalled = true },
    )
    expect(sendTyping).toHaveBeenCalledWith('c1', 'a1')
    expect(nextCalled).toBe(true)
  })

  it('does not throw if sendTyping rejects', async () => {
    const mw = makeMwTyping({ sendTyping: async () => { throw new Error('x') } })
    await expect(mw(
      { msg: { chatId: 'c1', accountId: 'a1' } as InboundCtx['msg'], receivedAtMs: 0, requestId: 'r' },
      async () => {},
    )).resolves.toBeUndefined()
  })
})
