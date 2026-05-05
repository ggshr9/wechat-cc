/**
 * transport unit tests — currently focused on errcode=-14 callback
 * (PR4 #18). The other transport methods (sendTyping, markChatActive,
 * captureContextToken, lastActiveChatId) are exercised via integration
 * paths in ilink-glue.test.ts and the e2e harness.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the ilink module before importing transport so vi.mocked works.
vi.mock('../../lib/ilink', () => ({
  ilinkGetUpdates: vi.fn(),
  ilinkSendTyping: vi.fn(),
  ilinkGetConfig: vi.fn(),
}))

import { makeTransport } from './transport'
import { ilinkGetUpdates } from '../../lib/ilink'
import type { IlinkContext } from './context'
import { makeAccountChatIndex } from '../account-chat-index'
import { makeConversationStore } from '../../core/conversation-store'
import { openTestDb } from '../../lib/db'

function makeStubCtx(): IlinkContext {
  // Minimal context shape — only fields read by getUpdatesForLoop matter
  // for these tests. Other methods aren't exercised.
  const transitions = new Map<string, string>()
  return {
    stateDir: '/tmp',
    accounts: [],
    projectsFile: '/tmp/projects.json',
    ctxStore: { get: () => undefined, set: () => {}, all: () => ({}), flush: async () => {} } as never,
    acctStore: { get: () => undefined, set: () => {}, all: () => ({}), flush: async () => {} } as never,
    conversationStore: makeConversationStore(openTestDb()),
    sessionState: {
      markExpired: (id: string, reason: string) => {
        if (transitions.has(id)) return false  // already expired
        transitions.set(id, reason)
        return true
      },
      isExpired: (id: string) => transitions.has(id),
      list: () => Array.from(transitions.entries()).map(([id, reason]) => ({ accountId: id, reason })),
    } as never,
    pending: new Map() as never,
    sweepTimer: setInterval(() => {}, 1_000_000) as never,
    typingTickets: new Map(),
    typingTTLMs: 60_000,
    lastActiveRef: { current: null },
    accountChatIndex: makeAccountChatIndex(),
    resolveAccount: () => { throw new Error('stub') },
    assertChatRoutable: () => {},
  }
}

describe('transport getUpdatesForLoop — onAccountExpired', () => {
  beforeEach(() => {
    vi.mocked(ilinkGetUpdates).mockReset()
  })

  it('fires onAccountExpired when ilink returns errcode=-14', async () => {
    vi.mocked(ilinkGetUpdates).mockResolvedValue({ errcode: -14, errmsg: 'session expired' })
    const calls: Array<{ accountId: string; reason: string }> = []
    const transport = makeTransport(makeStubCtx(), {
      onAccountExpired: (id, reason) => calls.push({ accountId: id, reason }),
    })

    const result = await transport.getUpdatesForLoop('acct1', 'http://x', 'tok', '')

    expect(result).toEqual({ expired: true })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.accountId).toBe('acct1')
    expect(calls[0]?.reason).toMatch(/-14|expired|rebound/i)
  })

  it('also handles ret=-14 (alternate wire field)', async () => {
    vi.mocked(ilinkGetUpdates).mockResolvedValue({ ret: -14, errmsg: 'session timeout' })
    const calls: Array<{ accountId: string; reason: string }> = []
    const transport = makeTransport(makeStubCtx(), {
      onAccountExpired: (id, reason) => calls.push({ accountId: id, reason }),
    })

    const result = await transport.getUpdatesForLoop('acct1', 'http://x', 'tok', '')
    expect(result).toEqual({ expired: true })
    expect(calls).toHaveLength(1)
  })

  it('does NOT fire onAccountExpired on success (errcode=0)', async () => {
    vi.mocked(ilinkGetUpdates).mockResolvedValue({ errcode: 0, msgs: [], get_updates_buf: 'buf1' })
    const calls: Array<{ accountId: string; reason: string }> = []
    const transport = makeTransport(makeStubCtx(), {
      onAccountExpired: (id, reason) => calls.push({ accountId: id, reason }),
    })

    const result = await transport.getUpdatesForLoop('acct1', 'http://x', 'tok', '')
    expect(result).toEqual({ updates: [], sync_buf: 'buf1' })
    expect(calls).toHaveLength(0)
  })

  it('only fires once per account (sessionState.markExpired dedups)', async () => {
    vi.mocked(ilinkGetUpdates).mockResolvedValue({ errcode: -14 })
    const calls: Array<{ accountId: string; reason: string }> = []
    const transport = makeTransport(makeStubCtx(), {
      onAccountExpired: (id, reason) => calls.push({ accountId: id, reason }),
    })

    await transport.getUpdatesForLoop('acct1', 'http://x', 'tok', '')
    await transport.getUpdatesForLoop('acct1', 'http://x', 'tok', '')
    await transport.getUpdatesForLoop('acct1', 'http://x', 'tok', '')

    expect(calls).toHaveLength(1)  // dedup via markExpired returning false
  })

  it('still works when onAccountExpired is omitted (optional)', async () => {
    vi.mocked(ilinkGetUpdates).mockResolvedValue({ errcode: -14 })
    const transport = makeTransport(makeStubCtx())  // no opts
    const result = await transport.getUpdatesForLoop('acct1', 'http://x', 'tok', '')
    expect(result).toEqual({ expired: true })
    // No throw — that's the assertion
  })
})
