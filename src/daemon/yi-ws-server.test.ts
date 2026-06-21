import { afterEach, describe, expect, it } from 'vitest'
import { createYiHub } from '../core/yi-hub'
import { createYiWsServer } from './yi-ws-server'
import { buildResponse, parseMessage } from '../core/yi-protocol'

let stop: (() => void) | null = null
afterEach(() => { stop?.(); stop = null })

describe('yi-ws-server', () => {
  it('authenticates initialize, attaches to hub, dispatches over the live socket', async () => {
    const hub = createYiHub()
    const server = createYiWsServer({ host: '127.0.0.1', port: 0, hub, verify: (id, tok) => id === 'home' && tok === 'k'.repeat(16) })
    await server.start(); stop = () => void server.stop()

    const ws = new WebSocket(`ws://127.0.0.1:${server.port()}`)
    await new Promise<void>((r) => { ws.onopen = () => r() })
    ws.onmessage = (ev) => {
      const m = parseMessage(String(ev.data))
      if (m.kind === 'request' && m.method === 'task/dispatch') {
        const taskId = (m.params as { taskId: string }).taskId
        ws.send(buildResponse(m.id, { taskId, ok: true, response: 'pong' }))
      }
    }
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { handId: 'home', clientName: 'x', capabilities: ['exec'], authToken: 'k'.repeat(16) } }))

    await new Promise<void>((r) => { const t = setInterval(() => { if (hub.isConnected('home')) { clearInterval(t); r() } }, 5) })
    await expect(hub.dispatchTask('home', { peer: 'claude', prompt: 'ping' }, 3000)).resolves.toEqual({ ok: true, response: 'pong' })
    ws.close()
  })

  it('rejects a bad authToken (does not attach)', async () => {
    const hub = createYiHub()
    const server = createYiWsServer({ host: '127.0.0.1', port: 0, hub, verify: () => false })
    await server.start(); stop = () => void server.stop()
    const ws = new WebSocket(`ws://127.0.0.1:${server.port()}`)
    await new Promise<void>((r) => { ws.onopen = () => r() })
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { handId: 'home', clientName: 'x', capabilities: [], authToken: 'wrong' } }))
    await new Promise((r) => setTimeout(r, 50))
    expect(hub.isConnected('home')).toBe(false)
    ws.close()
  })
})
