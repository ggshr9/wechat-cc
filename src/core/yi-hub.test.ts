import { describe, expect, it, vi } from 'vitest'
import { createYiHub } from './yi-hub'
import { parseMessage, buildResponse } from './yi-protocol'

describe('yi-hub', () => {
  it('dispatchTask sends task/dispatch and resolves on the correlated response', async () => {
    const hub = createYiHub()
    const sent: string[] = []
    hub.attach('home', (raw) => { sent.push(raw) })

    const p = hub.dispatchTask('home', { peer: 'claude', prompt: 'read README' }, 5000)
    const req = parseMessage(sent[0]!)
    expect(req.kind).toBe('request')
    if (req.kind !== 'request') throw new Error('expected request')
    expect(req.method).toBe('task/dispatch')
    const taskId = (req.params as { taskId: string }).taskId
    hub.onMessage('home', buildResponse(req.id, { taskId, ok: true, response: 'the readme' }))

    await expect(p).resolves.toEqual({ ok: true, response: 'the readme' })
  })

  it('ignores a response whose id is not owned by the sending hand (no cross-hand hijack)', async () => {
    const hub = createYiHub()
    const sentA: string[] = []
    hub.attach('handA', (raw) => { sentA.push(raw) })
    hub.attach('handB', () => {})
    const pA = hub.dispatchTask('handA', { peer: 'claude', prompt: 'x' }, 5000)
    const reqA = parseMessage(sentA[0]!)
    if (reqA.kind !== 'request') throw new Error('expected request')
    // Hand B replies with Hand A's request id — must be ignored, not hijack pA.
    hub.onMessage('handB', buildResponse(reqA.id, { taskId: 't', ok: true, response: 'HIJACKED' }))
    // Hand A's own reply settles it correctly.
    hub.onMessage('handA', buildResponse(reqA.id, { taskId: 't', ok: true, response: 'real' }))
    await expect(pA).resolves.toEqual({ ok: true, response: 'real' })
  })

  it('returns ok:false when the hand is not connected', async () => {
    const hub = createYiHub()
    await expect(hub.dispatchTask('ghost', { peer: 'claude', prompt: 'x' }, 1000))
      .resolves.toEqual({ ok: false, reason: 'hand_offline' })
  })

  it('times out a task with no response', async () => {
    vi.useFakeTimers()
    const hub = createYiHub()
    hub.attach('home', () => {})
    const p = hub.dispatchTask('home', { peer: 'claude', prompt: 'x' }, 1000)
    vi.advanceTimersByTime(1001)
    await expect(p).resolves.toEqual({ ok: false, reason: 'timeout' })
    vi.useRealTimers()
  })

  it('detach drops the hand (subsequent dispatch is offline)', async () => {
    const hub = createYiHub()
    hub.attach('home', () => {})
    hub.detach('home')
    await expect(hub.dispatchTask('home', { peer: 'claude', prompt: 'x' }, 1000))
      .resolves.toEqual({ ok: false, reason: 'hand_offline' })
  })

  it('isConnected reflects attach/detach', () => {
    const hub = createYiHub()
    expect(hub.isConnected('home')).toBe(false)
    hub.attach('home', () => {})
    expect(hub.isConnected('home')).toBe(true)
    hub.detach('home')
    expect(hub.isConnected('home')).toBe(false)
  })

  it('settles in-flight tasks as hand_offline when the hand detaches', async () => {
    const hub = createYiHub()
    hub.attach('home', () => {})
    const p = hub.dispatchTask('home', { peer: 'claude', prompt: 'x' }, 60_000)
    hub.detach('home')
    await expect(p).resolves.toEqual({ ok: false, reason: 'hand_offline' })
  })

  it('a stale send detaching does not evict a newer attach for the same handId', () => {
    const hub = createYiHub()
    const sendOld = () => {}
    const sendNew = () => {}
    hub.attach('home', sendOld)
    hub.attach('home', sendNew)        // reconnect: new socket takes the slot
    hub.detach('home', sendOld)        // stale socket's close fires late
    expect(hub.isConnected('home')).toBe(true)   // newer attach survives
    hub.detach('home', sendNew)
    expect(hub.isConnected('home')).toBe(false)
  })
})
