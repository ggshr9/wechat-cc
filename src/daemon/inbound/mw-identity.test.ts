import { describe, it, expect } from 'vitest'
import { makeMwIdentity } from './mw-identity'
import type { InboundCtx } from './types'
import type { InboundMsg } from '../../core/prompt-format'

function makeCtx(msg: Partial<InboundMsg>): InboundCtx {
  return {
    msg: {
      chatId: 'c1', userId: 'u1', userName: '张三',
      accountId: 'a1', text: 'hi', msgType: 'text', createTimeMs: 0,
      ...msg,
    },
    receivedAtMs: Date.now(),
    requestId: 'req-1',
  }
}

describe('mw-identity', () => {
  it('upserts identity from every inbound and continues the chain', async () => {
    const calls: Array<{ chatId: string; ids: any }> = []
    const mw = makeMwIdentity({
      upsertIdentity: (chatId, ids) => calls.push({ chatId, ids }),
    })
    let nextCalled = false
    await mw(makeCtx({}), async () => { nextCalled = true })

    expect(nextCalled).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({
      chatId: 'c1',
      ids: { userId: 'u1', accountId: 'a1', userName: '张三' },
    })
  })

  it('passes undefined userName through (mw-identity does not invent a default)', async () => {
    const calls: Array<{ chatId: string; ids: any }> = []
    const mw = makeMwIdentity({
      upsertIdentity: (chatId, ids) => calls.push({ chatId, ids }),
    })
    await mw(makeCtx({ userName: undefined }), async () => {})

    expect(calls[0]?.ids).toEqual({
      userId: 'u1',
      accountId: 'a1',
      userName: undefined,
    })
  })
})
