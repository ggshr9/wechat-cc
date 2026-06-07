import { describe, expect, it } from 'vitest'
import { classifyProbeResult, probeConnection, type ProbeDeps } from './connection-probe'

function deps(over: Partial<ProbeDeps> = {}): ProbeDeps {
  return {
    account: { id: 'b-im-bot', botId: 'b@im.bot', baseUrl: 'https://x.test', token: 'tok' },
    getUpdates: async () => ({ ret: 0, msgs: [] }),
    markExpired: () => true,
    probeTimeoutMs: 5000,
    ...over,
  }
}

describe('probeConnection', () => {
  it('connected result does not mark expired', async () => {
    let marked = false
    const r = await probeConnection(deps({ markExpired: () => (marked = true) }))
    expect(r).toEqual({ id: 'b-im-bot', state: 'connected' })
    expect(marked).toBe(false)
  })
  it('-14 marks the bot expired and reports taken_over', async () => {
    let markedId = ''
    const r = await probeConnection(deps({
      getUpdates: async () => ({ errcode: -14, errmsg: 'session timeout' }),
      markExpired: (id) => { markedId = id; return true },
    }))
    expect(r).toEqual({ id: 'b-im-bot', state: 'taken_over', detail: 'session timeout' })
    // The passive poll loop keys markExpired by account.id (the dir name),
    // NOT account.botId — transport.ts:getUpdatesForLoop receives account.id
    // from poll-loop.ts and passes it straight to sessionState.markExpired.
    expect(markedId).toBe('b-im-bot')
  })
  it('thrown error → inconclusive, does not mark expired', async () => {
    let marked = false
    const r = await probeConnection(deps({
      getUpdates: async () => { throw new Error('ECONNREFUSED') },
      markExpired: () => (marked = true),
    }))
    expect(r.state).toBe('inconclusive')
    expect(marked).toBe(false)
  })
  it('passes probeTimeoutMs through to getUpdates', async () => {
    let seenTimeout = 0
    await probeConnection(deps({
      getUpdates: async (_baseUrl, _token, timeoutMs) => { seenTimeout = timeoutMs; return { ret: 0, msgs: [] } },
    }))
    expect(seenTimeout).toBe(5000)
  })
})

describe('classifyProbeResult', () => {
  it('errcode -14 → taken_over with the server errmsg', () => {
    expect(classifyProbeResult({ resp: { errcode: -14, errmsg: 'session timeout' } }))
      .toEqual({ state: 'taken_over', detail: 'session timeout' })
  })
  it('ret -14 (alt field) → taken_over', () => {
    expect(classifyProbeResult({ resp: { ret: -14 } }).state).toBe('taken_over')
  })
  it('empty successful poll → connected', () => {
    expect(classifyProbeResult({ resp: { ret: 0, msgs: [] } }).state).toBe('connected')
  })
  it('thrown network error → inconclusive carrying the message', () => {
    expect(classifyProbeResult({ error: new Error('fetch failed') }))
      .toEqual({ state: 'inconclusive', detail: 'fetch failed' })
  })
})
