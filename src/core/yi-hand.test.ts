import { describe, expect, it, vi } from 'vitest'
import { createYiHand } from './yi-hand'
import { parseMessage, buildResponse, buildRequest } from './yi-protocol'

const base = { handId: 'home', authToken: 'k'.repeat(16), capabilities: ['exec'] }

describe('yi-hand', () => {
  it('helloFrame is an initialize request carrying handId + authToken', () => {
    const hand = createYiHand({ ...base, onExec: async () => ({ ok: true, response: 'x' }) })
    const msg = parseMessage(hand.helloFrame())
    expect(msg.kind).toBe('request')
    if (msg.kind !== 'request') throw new Error('expected request')
    expect(msg.method).toBe('initialize')
    expect(msg.params).toMatchObject({ handId: 'home', authToken: 'k'.repeat(16), capabilities: ['exec'] })
  })

  it('on task/dispatch, runs onExec and replies with the result (same id)', async () => {
    const onExec = vi.fn().mockResolvedValue({ ok: true, response: 'README body' })
    const hand = createYiHand({ ...base, onExec })
    await hand.onMessage(buildResponse(1, { sessionId: 's1' }))
    const out = await hand.onMessage(buildRequest(42, 'task/dispatch', { taskId: 't1', peer: 'claude', prompt: 'read README', cwd: '/tmp' }))
    expect(onExec).toHaveBeenCalledWith({ peer: 'claude', prompt: 'read README', cwd: '/tmp' })
    expect(out).toHaveLength(1)
    const resp = parseMessage(out[0]!)
    expect(resp).toEqual({ kind: 'response', id: 42, result: { taskId: 't1', ok: true, response: 'README body' } })
  })

  it('replies ok:false when onExec returns a failure', async () => {
    const hand = createYiHand({ ...base, onExec: async () => ({ ok: false, reason: 'no agent' }) })
    const out = await hand.onMessage(buildRequest(9, 'task/dispatch', { taskId: 't2', peer: 'claude', prompt: 'x' }))
    expect(parseMessage(out[0]!)).toEqual({ kind: 'response', id: 9, result: { taskId: 't2', ok: false, reason: 'no agent' } })
  })

  it('ignores non-dispatch messages (returns no frames)', async () => {
    const hand = createYiHand({ ...base, onExec: async () => ({ ok: true, response: 'x' }) })
    expect(await hand.onMessage(buildResponse(1, { sessionId: 's1' }))).toEqual([])
  })
})
