// Task 3 — inbound messages recording e2e.
// Boots the full daemon, sends one text inbound, then verifies the
// messages table captured it (direction='in', correct text).
// Task 4 — outbound recording: verifies direction='out' row appears
// after the bot's reply is delivered.
import { describe, it, expect } from 'vitest'
import { startTestDaemon } from './harness'
import { openWechatDb } from '../../lib/db'
import { makeMessagesStore } from '../../lib/messages-store'

describe('e2e: mw-messages records inbound into messages table', () => {
  it('sends "你好" and finds 1 row direction=in in messages', async () => {
    const daemon = await startTestDaemon({
      dangerously: true,
      claudeScript: {
        async onDispatch(_text) {
          return { toolCalls: [], finalText: '好的' }
        },
      },
    })
    const db = openWechatDb(daemon.stateDir)
    try {
      daemon.sendText('chat1', '你好')
      // Wait for the reply to confirm the full pipeline ran (including mw-messages)
      await daemon.waitForReplyTo('chat1', 8000)

      const store = makeMessagesStore(db)
      const rows = await store.listRange('chat1', { limit: 20 })
      const inbound = rows.filter(r => r.direction === 'in')
      expect(inbound.length).toBe(1)
      expect(inbound[0]?.text).toBe('你好')
      expect(inbound[0]?.kind).toBe('text')
      expect(inbound[0]?.source).toBe('live')
    } finally {
      db.close()
      await daemon.stop()
    }
  })
})

describe('e2e: ilink-glue records outbound into messages table', () => {
  it('sends "你好" and finds a direction=out row with the reply text', async () => {
    const replyText = '这是一个测试回复'
    const daemon = await startTestDaemon({
      dangerously: true,
      claudeScript: {
        async onDispatch(_text) {
          return { toolCalls: [], finalText: replyText }
        },
      },
    })
    const db = openWechatDb(daemon.stateDir)
    try {
      daemon.sendText('chat1', '你好')
      await daemon.waitForReplyTo('chat1', 8000)

      const store = makeMessagesStore(db)
      const rows = await store.listRange('chat1', { limit: 20 })
      const outbound = rows.filter(r => r.direction === 'out')
      expect(outbound.length).toBeGreaterThanOrEqual(1)
      expect(outbound[0]?.text).toBe(replyText)
      expect(outbound[0]?.kind).toBe('text')
      expect(outbound[0]?.source).toBe('live')
      // provider is not in scope at the transport layer (ilink-glue sendMessage);
      // pin that so future plumbing that populates it must update this test.
      expect(outbound[0]!.provider).toBeUndefined()
    } finally {
      db.close()
      await daemon.stop()
    }
  })
})
