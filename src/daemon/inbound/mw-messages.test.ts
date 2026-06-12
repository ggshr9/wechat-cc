import { describe, it, expect } from 'vitest'
import { makeMwMessages } from './mw-messages'
import type { InboundCtx } from './types'
import { createHash } from 'node:crypto'

function ctx(text: string, consumed?: InboundCtx['consumedBy']): InboundCtx {
  return {
    msg: { chatId: 'c1', userId: 'u1', text, msgType: 'text', createTimeMs: 1780000000000, accountId: 'a1' } as InboundCtx['msg'],
    receivedAtMs: 1780000000500,
    requestId: 'r1',
    ...(consumed ? { consumedBy: consumed } : {}),
  }
}

function ctxNoTs(text: string, receivedAtMs = 1780000000500): InboundCtx {
  return {
    msg: { chatId: 'c1', userId: 'u1', text, msgType: 'text', createTimeMs: 0, accountId: 'a1' } as InboundCtx['msg'],
    receivedAtMs,
    requestId: 'r1',
  }
}

describe('mw-messages', () => {
  it('records inbound text before next() so consumed commands still land', async () => {
    const appended: Array<Record<string, unknown>> = []
    const mw = makeMwMessages({
      append: async rec => { appended.push(rec as unknown as Record<string, unknown>); return 1 },
      log: () => {},
    })
    const c = ctx('/health')
    await mw(c, async () => { c.consumedBy = 'admin' })
    expect(appended.length).toBe(1)
    expect(appended[0]).toMatchObject({ id: 'u1:1780000000000', kind: 'command', direction: 'in', text: '/health' })
  })

  it('plain text records kind=text', async () => {
    const appended: Array<Record<string, unknown>> = []
    const mw = makeMwMessages({ append: async rec => { appended.push(rec as never); return 1 }, log: () => {} })
    await mw(ctx('你好'), async () => {})
    expect(appended[0]).toMatchObject({ kind: 'text', text: '你好' })
  })

  it('append failure logs but does not break the pipeline', async () => {
    const logs: string[] = []
    const mw = makeMwMessages({
      append: async (): Promise<number> => { throw new Error('disk full') },
      log: (_tag, line) => { logs.push(line) },
    })
    let nextRan = false
    await mw(ctx('hi'), async () => { nextRan = true })
    expect(nextRan).toBe(true)
    expect(logs.join(' ')).toContain('disk full')
  })

  // A1 — stable content-keyed id for ts-less messages
  it('redelivery with createTimeMs=0 and same text produces same id (dedup)', async () => {
    const appended: Array<Record<string, unknown>> = []
    const mw = makeMwMessages({ append: async rec => { appended.push(rec as never); return 1 }, log: () => {} })
    const text = '无时间戳的消息'
    // Two deliveries with different receivedAtMs but same text
    await mw(ctxNoTs(text, 1780000000500), async () => {})
    await mw(ctxNoTs(text, 1780000001000), async () => {})
    // Both should produce the same stable id
    expect(appended.length).toBe(2)
    expect(appended[0]!['id']).toBe(appended[1]!['id'])
    // Format: userId:0:<12-hex-sha256>
    const hash = createHash('sha256').update(text).digest('hex').slice(0, 12)
    expect(appended[0]!['id']).toBe(`u1:0:${hash}`)
  })

  it('two different texts with createTimeMs=0 produce different ids', async () => {
    const appended: Array<Record<string, unknown>> = []
    const mw = makeMwMessages({ append: async rec => { appended.push(rec as never); return 1 }, log: () => {} })
    await mw(ctxNoTs('消息甲'), async () => {})
    await mw(ctxNoTs('消息乙'), async () => {})
    expect(appended[0]!['id']).not.toBe(appended[1]!['id'])
  })

  it('normal createTimeMs path still uses timestamp-based id', async () => {
    const appended: Array<Record<string, unknown>> = []
    const mw = makeMwMessages({ append: async rec => { appended.push(rec as never); return 1 }, log: () => {} })
    await mw(ctx('/health'), async () => {})
    expect(appended[0]!['id']).toBe('u1:1780000000000')
  })
})
