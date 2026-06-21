import { afterEach, describe, expect, it, vi } from 'vitest'
import { createYiHub } from '../core/yi-hub'
import { createYiWsServer } from './yi-ws-server'
import { createYiWsClient } from './yi-ws-client'
import { makeDelegateToHand } from './wiring/pipeline-deps'

let cleanup: Array<() => void> = []
afterEach(() => { cleanup.forEach((f) => f()); cleanup = [] })

const wsHand = { id: 'home', name: '家里', url: 'http://x/a2a', inbound_api_key: 'k'.repeat(16), outbound_api_key: 'o', capabilities: ['exec'], paused: false, transport: 'ws' as const }
const pushHand = { ...wsHand, id: 'office', name: '公司', transport: 'push' as const }

describe('乙 v2 end-to-end', () => {
  it('让X执行 reaches a ws hand over a live socket', async () => {
    const hub = createYiHub()
    const server = createYiWsServer({ host: '127.0.0.1', port: 0, hub, verify: (id, t) => id === 'home' && t === 'k'.repeat(16) })
    await server.start(); cleanup.push(() => void server.stop())
    const client = createYiWsClient({ brainUrl: `ws://127.0.0.1:${server.port()}`, handId: 'home', authToken: 'k'.repeat(16), capabilities: ['exec'], onExec: async (t) => ({ ok: true, response: `ran:${t.prompt}` }) })
    client.start(); cleanup.push(() => client.stop())
    await new Promise<void>((r) => { const t = setInterval(() => { if (hub.isConnected('home')) { clearInterval(t); r() } }, 5) })

    const delegate = makeDelegateToHand({ listHands: () => [wsHand], hub, pushDelegate: vi.fn(), selfId: 'wechat-cc', timeoutMs: 3000 })
    await expect(delegate('家里', 'sync logs')).resolves.toEqual({ ok: true, response: 'ran:sync logs' })
  })

  it('a push hand still uses the HTTP path (hub untouched)', async () => {
    const hub = { dispatchTask: vi.fn(), isConnected: () => false } as never
    const pushDelegate = vi.fn().mockResolvedValue({ ok: true, response: 'via-http' })
    const delegate = makeDelegateToHand({ listHands: () => [pushHand], hub, pushDelegate, selfId: 'wechat-cc', timeoutMs: 3000 })
    await expect(delegate('公司', 'x')).resolves.toEqual({ ok: true, response: 'via-http' })
    expect(pushDelegate).toHaveBeenCalledTimes(1)
  })
})
