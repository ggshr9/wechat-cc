import { describe, it, expect, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

  it('multi-device accounts start in standby (not polled); single-device auto-poll', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'polling-md-'))
    mkdirSync(join(stateDir, 'accounts', 'bot-md'), { recursive: true })
    writeFileSync(join(stateDir, 'accounts', 'bot-md', '.multidevice'), '')
    const idle = { baseUrl: 'http://x', token: 't', syncBuf: '' }
    const lc = registerPolling({
      stateDir,
      accounts: [
        { id: 'bot-md', botId: 'bot-md', userId: 'u1', ...idle },
        { id: 'bot-single', botId: 'bot-single', userId: 'u2', ...idle },
      ],
      ilink: { getUpdates: async () => { await new Promise(r => setTimeout(r, 1000)); return { updates: [] } } },
      parse: () => [],
      resolveUserName: () => undefined,
      log: () => {},
      runPipeline: async () => {},
    })
    try {
      expect(lc.running()).toEqual(['bot-single'])  // md held back until takeover
    } finally {
      await lc.stop()
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('persists the advanced ilink cursor to accounts/<id>/sync_buf', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'polling-sb-'))
    mkdirSync(join(stateDir, 'accounts', 'bot1'), { recursive: true })
    let calls = 0
    const lc = registerPolling({
      stateDir,
      accounts: [{ id: 'bot1', botId: 'bot1', userId: 'u1', baseUrl: 'http://x', token: 't', syncBuf: '' }],
      ilink: {
        getUpdates: async () => {
          calls += 1
          if (calls === 1) return { updates: [], sync_buf: 'cursor-42' }
          await new Promise(r => setTimeout(r, 1000))
          return { updates: [], sync_buf: 'cursor-42' }
        },
      },
      parse: () => [],
      resolveUserName: () => undefined,
      log: () => {},
      runPipeline: async () => {},
    })
    try {
      // poll for the file to appear (write happens after the first batch)
      const path = join(stateDir, 'accounts', 'bot1', 'sync_buf')
      for (let i = 0; i < 50 && !existsSync(path); i++) await new Promise(r => setTimeout(r, 10))
      expect(existsSync(path)).toBe(true)
      expect(readFileSync(path, 'utf8').trim()).toBe('cursor-42')
    } finally {
      await lc.stop()
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('reconcile() is a no-op after stop() — no zombie loop starts post-shutdown', async () => {
    // Regression: stop() sets stopped=true, but reconcile() lacked the same
    // guard — a reconcile racing/after shutdown (SIGUSR1 takeover, queued
    // reconcile) called addAccount on the stopped handle, spinning a poll loop
    // nothing would ever stop (leaked sockets + multi-device session theft).
    const stateDir = mkdtempSync(join(tmpdir(), 'polling-stopped-'))
    const acctDir = join(stateDir, 'accounts', 'bot-x')
    mkdirSync(acctDir, { recursive: true })
    writeFileSync(join(acctDir, 'account.json'), JSON.stringify({ botId: 'bot-x', userId: 'u1', baseUrl: 'http://x' }))
    writeFileSync(join(acctDir, 'token'), 'tok')
    const mkLc = () => registerPolling({
      stateDir,
      accounts: [],
      ilink: { getUpdates: async () => { await new Promise(r => setTimeout(r, 1000)); return { updates: [] } } },
      parse: () => [],
      resolveUserName: () => undefined,
      log: () => {},
      runPipeline: async () => {},
    })
    try {
      // Positive control: a live lifecycle DOES pick the account up via reconcile.
      const live = mkLc()
      await live.reconcile()
      expect(live.running()).toContain('bot-x')
      await live.stop()
      // The guard: a STOPPED lifecycle must not start it.
      const dead = mkLc()
      await dead.stop()
      await dead.reconcile()
      expect(dead.running()).toEqual([])
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
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
