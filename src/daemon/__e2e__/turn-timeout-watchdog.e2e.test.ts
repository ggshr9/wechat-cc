// End-to-end acceptance test for the per-turn watchdog — the root-cause fix
// for the daemon-stability bug class (a stalled agent turn wedging the whole
// daemon). collectTurn's idle timer and the coordinator's handleTurnTimeout
// recovery are well unit-tested; this proves the WIRING those unit tests mock:
//   - WECHAT_TURN_TIMEOUT_MS actually reaches the coordinator (bootstrap parse),
//   - a real stalled spawn trips the watchdog through the real pipeline,
//   - the user gets the timeout notice over the real ilink outbound, and
//   - the daemon is NOT wedged — a later chat is still served end-to-end.
import { describe, it, expect } from 'vitest'
import { startTestDaemon } from './harness'

describe('e2e: per-turn watchdog ends a stalled turn without wedging the daemon', () => {
  it('a hung turn yields the timeout notice, and a later chat still gets a reply', async () => {
    // Small watchdog so the stall trips quickly. Set before boot — bootstrap
    // reads WECHAT_TURN_TIMEOUT_MS at startup (and heartbeatStaleMs derives
    // from it, staying well above this floor).
    const orig = process.env.WECHAT_TURN_TIMEOUT_MS
    process.env.WECHAT_TURN_TIMEOUT_MS = '300'
    try {
      const daemon = await startTestDaemon({
        knownUsers: { chat1: 'u1', chat2: 'u2' },
        claudeScript: {
          async onDispatch(text) {
            if (text.includes('HANG')) {
              // Stall well past the 300ms watchdog. unref() so this dangling
              // timer never keeps the test process alive at teardown — the
              // watchdog returns without awaiting this turn (collectTurn does
              // not await it.return() on a wedged producer).
              await new Promise<void>(resolve => {
                const t = setTimeout(resolve, 30_000)
                ;(t as { unref?: () => void }).unref?.()
              })
              return { toolCalls: [], finalText: 'too late' }
            }
            return { toolCalls: [], finalText: 'ok' }
          },
        },
      })
      try {
        // 1. A turn that stalls past the watchdog → the user gets the
        //    timeout notice (NOT an indefinite hang).
        daemon.sendText('chat1', 'HANG please')
        const replies = await daemon.waitForReplyTo('chat1', 8000)
        expect(
          replies.some(m => m.endpoint === 'sendmessage' && m.chatId === 'chat1' && /超时|重发/.test(m.text ?? '')),
          'chat1 should receive the watchdog timeout notice',
        ).toBe(true)

        // 2. The daemon is NOT wedged by the stalled turn — a fresh chat
        //    dispatches and replies normally through the real pipeline.
        daemon.sendText('chat2', 'hello')
        const ok = await daemon.waitForOutbound(
          msgs => msgs.some(m => m.endpoint === 'sendmessage' && m.chatId === 'chat2' && (m.text ?? '').includes('ok')),
          8000,
        )
        expect(ok.some(m => m.chatId === 'chat2' && (m.text ?? '').includes('ok'))).toBe(true)
      } finally {
        await daemon.stop()
      }
    } finally {
      if (orig === undefined) delete process.env.WECHAT_TURN_TIMEOUT_MS
      else process.env.WECHAT_TURN_TIMEOUT_MS = orig
    }
  })
})
