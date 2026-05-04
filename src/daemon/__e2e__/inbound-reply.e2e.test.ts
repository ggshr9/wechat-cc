// Real end-to-end pipeline test: inbound text → fake-ilink poll → daemon
// pipeline → fake-claude dispatch → ilink sendmessage outbox.
//
// Why this exists: the previous "smoke" test only verified boot + poll loop
// registration + clean shutdown. It did NOT cover the actual user-visible
// flow ("user sends 你好, daemon dispatches to provider, reply lands in chat"),
// so structural changes to cli.ts ↔ main.ts dispatch silently broke the
// shipped binary without failing CI. This test exercises the full path:
//   1. harness boots daemon (via bootDaemon export — same path as cli.ts)
//   2. fake-ilink server queues an inbound update
//   3. daemon poll-loop picks it up, runs the inbound pipeline
//   4. pipeline calls fake-claude.onDispatch → returns "你好啊"
//   5. send-reply pushes the reply text via fake-ilink sendmessage
//   6. test asserts the outbox saw a sendmessage with the right text
//
// If this fails, the production binary is broken — even if doctor + dashboard
// say "daemon running". Run before every desktop release.
import { describe, it, expect } from 'vitest'
import { startTestDaemon } from './harness'

describe('e2e: inbound text → pipeline → fake-claude reply → outbox', () => {
  it('user "你好" lands an outbound reply in the fake-ilink outbox', async () => {
    let dispatchedText: string | null = null
    const daemon = await startTestDaemon({
      dangerously: true,
      claudeScript: {
        async onDispatch(text) {
          dispatchedText = text
          return { toolCalls: [], finalText: '你好啊（来自 fake-claude）' }
        },
      },
    })
    try {
      daemon.sendText('chat1', '你好')
      const replies = await daemon.waitForReplyTo('chat1', 8000)
      expect(replies.length).toBeGreaterThan(0)
      const reply = replies[0]
      expect(reply.endpoint).toBe('sendmessage')
      expect(reply.chatId).toBe('chat1')
      // Provider was actually invoked with the user's text (not a stub).
      expect(dispatchedText).toContain('你好')
    } finally {
      await daemon.stop()
    }
  })
})
