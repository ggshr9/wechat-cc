import { describe, expect, it, vi } from 'vitest'
import { makeDelegateToHand } from './pipeline-deps'

describe('makeDelegateToHand routing', () => {
  const wsHand = { id: 'home', name: '家里', url: 'http://x/a2a', inbound_api_key: 'k'.repeat(16), outbound_api_key: 'o', capabilities: ['exec'], paused: false, transport: 'ws' as const }

  it('routes a ws hand through the hub', async () => {
    const hub = { dispatchTask: vi.fn().mockResolvedValue({ ok: true, response: 'via-ws' }), attach: vi.fn(), detach: vi.fn(), isConnected: () => true, onMessage: vi.fn() }
    const delegate = makeDelegateToHand({
      listHands: () => [wsHand],
      hub,
      pushDelegate: vi.fn(),
      selfId: 'wechat-cc',
      timeoutMs: 1000,
    })
    await expect(delegate('家里', 'do x')).resolves.toEqual({ ok: true, response: 'via-ws' })
    expect(hub.dispatchTask).toHaveBeenCalledWith('home', { peer: 'claude', prompt: 'do x' }, 1000)
  })

  it('unknown hand → known list', async () => {
    const delegate = makeDelegateToHand({ listHands: () => [wsHand], hub: { dispatchTask: vi.fn() } as never, pushDelegate: vi.fn(), selfId: 'x', timeoutMs: 1000 })
    await expect(delegate('火星', 'x')).resolves.toEqual({ ok: false, reason: 'unknown_hand', knownHands: ['家里'] })
  })
})
