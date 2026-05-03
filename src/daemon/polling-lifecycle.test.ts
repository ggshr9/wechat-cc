import { describe, it, expect, vi } from 'vitest'
import { registerPolling } from './polling-lifecycle'
import { parseUpdates } from './poll-loop'
import type { InboundCtx } from './inbound/types'

describe('registerPolling', () => {
  it('returns Lifecycle with name=polling and reconcile()', () => {
    const lc = registerPolling({
      stateDir: '/tmp/wechat-cc',
      accounts: [],
      ilink: { getUpdates: async () => ({ updates: [] }) },
      parse: () => [],
      resolveUserName: () => undefined,
      log: () => {},
      runPipeline: async (_ctx: InboundCtx) => {},
    })
    expect(lc.name).toBe('polling')
    expect(typeof lc.reconcile).toBe('function')
  })

  it('stop() is idempotent', async () => {
    const lc = registerPolling({
      stateDir: '/tmp/wechat-cc',
      accounts: [],
      ilink: { getUpdates: async () => ({ updates: [] }) },
      parse: () => [],
      resolveUserName: () => undefined,
      log: () => {},
      runPipeline: async () => {},
    })
    await lc.stop(); await expect(lc.stop()).resolves.toBeUndefined()
  })

  /**
   * Regression for the C1 bug discovered in final review of P-Task 22:
   * main-wiring.ts originally used `parse: (raws) => raws as never`, an
   * identity cast that bypassed parseUpdates entirely. Result: every inbound
   * arrived at the pipeline as a raw WeixinMessage (with `from_user_id`,
   * `item_list`) rather than a proper InboundMsg (with `chatId`, `text`).
   *
   * This test wires the *real* parseUpdates through registerPolling and
   * confirms runPipeline receives a properly-shaped InboundCtx — which would
   * have failed loudly if the production wiring used the identity cast.
   */
  it('runs the parse fn so runPipeline receives a properly-shaped InboundMsg', async () => {
    const received: InboundCtx[] = []
    let resolveOne!: () => void
    const oneInbound = new Promise<void>(r => { resolveOne = r })
    const account = { id: 'bot1', botId: 'bot1', userId: 'u-owner', baseUrl: 'http://ilink.test', token: 'tok', syncBuf: '' }
    let getUpdatesCalls = 0
    const lc = registerPolling({
      stateDir: '/tmp/wechat-cc',
      accounts: [account],
      ilink: {
        getUpdates: async () => {
          getUpdatesCalls += 1
          if (getUpdatesCalls === 1) {
            return {
              updates: [{
                message_type: 1,
                message_state: 2,
                from_user_id: 'u1',
                create_time_ms: 12345,
                item_list: [{ type: 1, text_item: { text: 'hello' } }],
              }],
              sync_buf: '',
            }
          }
          // Subsequent polls return empty until the test aborts (stop()).
          await new Promise(r => setTimeout(r, 1000))
          return { updates: [] }
        },
      },
      parse: parseUpdates,           // ← the real production wiring under test
      resolveUserName: () => 'alice',
      log: () => {},
      runPipeline: async (ctx) => { received.push(ctx); resolveOne() },
    })
    try {
      await oneInbound
      expect(received).toHaveLength(1)
      const msg = received[0]!.msg
      expect(msg.chatId).toBe('u1')
      expect(msg.text).toBe('hello')
      expect(msg.accountId).toBe('bot1')
      expect(msg.userName).toBe('alice')
      expect(msg.createTimeMs).toBe(12345)
      // requestId is generated per-inbound (8-char hex)
      expect(received[0]!.requestId).toMatch(/^[0-9a-f]{8}$/)
    } finally {
      await lc.stop()
    }
  }, 5000)
})
