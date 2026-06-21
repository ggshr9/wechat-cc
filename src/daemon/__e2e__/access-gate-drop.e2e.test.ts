// End-to-end acceptance test for the allowlist gate (mw-access) — the README's
// "everyone else is blocked by default" promise. Every other e2e runs with the
// harness default allowFrom: ['*'] (open), so the DROP path and its ordering
// were untested end-to-end.
//
// This also locks the security-critical middleware ORDER in build.ts: mw-access
// sits before typing/onboarding/welcome/dispatch, so a non-allowlisted sender
// must trigger ZERO downstream side effects — no typing indicator, no welcome
// leak, no agent dispatch, no API tokens. A future reorder that moved access
// after those would leak side effects to blocked senders and fail this test.
import { describe, it, expect } from 'vitest'
import { startTestDaemon } from './harness'

describe('e2e: mw-access drops a non-allowlisted sender before any side effect', () => {
  it('blocked sender gets no outbound; allowlisted sender still replies', async () => {
    const daemon = await startTestDaemon({
      access: { allowFrom: ['allowed-user'], admins: ['allowed-user'] },
      knownUsers: { 'allowed-user': 'u1' },
      claudeScript: { async onDispatch() { return { toolCalls: [], finalText: 'ok' } } },
    })
    try {
      // Send from a NON-allowlisted chat first, then from the allowlisted one.
      // The poll loop processes inbounds in order, so once the allowlisted
      // reply lands the blocked message has already been fully handled — making
      // the "no outbound for blocked" assertion deterministic (no arbitrary sleep).
      daemon.sendText('blocked-user', 'let me in')
      daemon.sendText('allowed-user', 'hi')

      await daemon.waitForReplyTo('allowed-user', 8000)

      const out = daemon.ilink.outbox()
      expect(
        out.some(m => m.chatId === 'blocked-user'),
        'a non-allowlisted sender must receive no outbound at all (no reply/typing/welcome)',
      ).toBe(false)
      // Sanity: the allowlisted user did get its reply through the same pipeline.
      expect(out.some(m => m.endpoint === 'sendmessage' && m.chatId === 'allowed-user')).toBe(true)
    } finally {
      await daemon.stop()
    }
  })
})
