import { describe, it, expect } from 'vitest'
import { makeMwAttachments } from './mw-attachments'
import type { InboundCtx } from './types'

describe('mwAttachments', () => {
  it('calls materializeAttachments before next() and sets attachmentsMaterialized', async () => {
    const order: string[] = []
    const mw = makeMwAttachments({
      materializeAttachments: async () => { order.push('mat') },
      inboxDir: '/tmp/inbox',
      log: () => {},
    })
    const ctx: InboundCtx = { msg: { chatId: 'c1' } as InboundCtx['msg'], receivedAtMs: 0, requestId: 'r' }
    await mw(ctx, async () => { order.push('next') })
    expect(order).toEqual(['mat', 'next'])
    expect(ctx.attachmentsMaterialized).toBe(true)
  })
})
