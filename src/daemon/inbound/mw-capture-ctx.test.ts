import { describe, it, expect, vi } from 'vitest'
import { makeMwCaptureCtx } from './mw-capture-ctx'
import type { InboundCtx } from './types'

const mkCtx = (over: Partial<InboundCtx['msg']> = {}): InboundCtx => ({
  msg: { chatId: 'c1', accountId: 'a1', contextToken: 'ct1', ...over } as InboundCtx['msg'],
  receivedAtMs: Date.now(),
  requestId: 'r1',
})

describe('mwCaptureCtx', () => {
  it('calls markChatActive + captureContextToken before next()', async () => {
    const calls: string[] = []
    const mw = makeMwCaptureCtx({
      markChatActive: (c, a) => calls.push(`mark:${c}:${a}`),
      captureContextToken: (c, t) => calls.push(`tok:${c}:${t}`),
    })
    await mw(mkCtx(), async () => { calls.push('next') })
    expect(calls).toEqual(['mark:c1:a1', 'tok:c1:ct1', 'next'])
  })

  it('skips captureContextToken when token absent', async () => {
    const tokens: string[] = []
    const mw = makeMwCaptureCtx({
      markChatActive: () => {},
      captureContextToken: (c, t) => tokens.push(`${c}:${t}`),
    })
    await mw(mkCtx({ contextToken: undefined }), async () => {})
    expect(tokens).toEqual([])
  })
})
