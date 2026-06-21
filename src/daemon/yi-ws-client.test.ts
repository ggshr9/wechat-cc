import { afterEach, describe, expect, it } from 'vitest'
import { createYiHub } from '../core/yi-hub'
import { createYiWsServer } from './yi-ws-server'
import { createYiWsClient } from './yi-ws-client'

let cleanup: Array<() => void> = []
afterEach(() => { cleanup.forEach((f) => f()); cleanup = [] })

describe('yi-ws-client', () => {
  it('connects out, handshakes, and serves a dispatched task end-to-end', async () => {
    const hub = createYiHub()
    const server = createYiWsServer({ host: '127.0.0.1', port: 0, hub, verify: (id, t) => id === 'home' && t === 'k'.repeat(16) })
    await server.start(); cleanup.push(() => void server.stop())

    const client = createYiWsClient({
      brainUrl: `ws://127.0.0.1:${server.port()}`,
      handId: 'home', authToken: 'k'.repeat(16), capabilities: ['exec'],
      onExec: async (task) => ({ ok: true, response: `ran:${task.prompt}` }),
    })
    client.start(); cleanup.push(() => client.stop())

    await new Promise<void>((r) => { const t = setInterval(() => { if (hub.isConnected('home')) { clearInterval(t); r() } }, 5) })
    await expect(hub.dispatchTask('home', { peer: 'claude', prompt: 'hello' }, 3000)).resolves.toEqual({ ok: true, response: 'ran:hello' })
  })
})
