import { describe, expect, it, vi } from 'vitest'
import { createConversationCoordinator, authFailNotice } from './conversation-coordinator'
import { createProviderRegistry } from './provider-registry'
import * as capabilityMatrix from './capability-matrix'
import { makeFakeSession } from './test-helpers'
import type { AgentEvent, AgentProvider, AgentSession } from './agent-provider'
import type { Mode, ProviderId } from './conversation'
import { formatInbound, type InboundMsg } from './prompt-format'
import type { AcquireRequest } from './session-manager'
import { TIER_PROFILES, type TierProfile } from './user-tier'
import type { Access } from '../lib/access'

describe('authFailNotice', () => {
  it('returns the provider-specific hint from ProviderCapabilities (incl. cursor)', () => {
    expect(authFailNotice('claude')).toContain('claude login')
    expect(authFailNotice('codex')).toContain('codex login')
    // cursor uses an API key, not a login command — the old ternary wrongly
    // fell through to the Claude string. Now sourced from capabilities.
    const cur = authFailNotice('cursor')
    expect(cur).toContain('Cursor')
    expect(cur).not.toContain('claude login')
  })
})

/**
 * Default access fixture used by most coordinator tests: every chatId
 * those tests touch is listed in `admins`, so `resolveTier()` returns
 * 'admin' and acquire() receives `TIER_PROFILES.admin` — the behaviour
 * pre-Task 10 tests were written against. Tests that need to exercise
 * trusted/guest behaviour should construct their own access fixture.
 */
function adminAccess(): Access {
  return {
    dmPolicy: 'allowlist',
    allowFrom: [],
    admins: ['chat-1', 'chat-2', 'chat-p', 'chat-r', 'chat-abc'],
  }
}

/** Minimal AgentProvider whose spawn() returns a session that emits no events. */
const dummyProvider: AgentProvider = {
  spawn: async () => makeFakeSession({
    events: [{ kind: 'result', sessionId: '_', numTurns: 1, durationMs: 0 }],
  }),
}

function makeMockStore() {
  const data = new Map<string, { mode: Mode }>()
  return {
    get: (chatId: string) => data.get(chatId) ?? null,
    set: vi.fn((chatId: string, mode: Mode) => { data.set(chatId, { mode }) }),
    setParticipants: vi.fn((chatId: string, participants: string[] | null) => {
      const cur = data.get(chatId)
      if (!cur) return
      if (cur.mode.kind !== 'parallel' && cur.mode.kind !== 'chatroom') {
        throw new Error(`setParticipants on ${cur.mode.kind}`)
      }
      const next = participants
        ? { ...cur.mode, participants }
        : (() => { const m = { ...cur.mode } as Mode & { participants?: string[] }; delete m.participants; return m })()
      data.set(chatId, { mode: next as Mode })
    }),
    _peek: () => data,
  }
}

function inbound(chatId: string, text: string): InboundMsg {
  return {
    chatId, userId: chatId, text, msgType: 'text',
    createTimeMs: Date.now(), accountId: 'acct-1',
  }
}

/**
 * A session whose dispatch yields `emit` then hangs forever (never emits a
 * `result`, never closes) — models the Claude SDK subprocess going silent
 * mid-turn. `next()` hangs once the buffer drains; `return()` resolves
 * immediately, mirroring the real provider's AsyncQueue iterator.
 */
function hangingSession(emit: AgentEvent[] = []): AgentSession {
  return {
    dispatch() {
      const buf = [...emit]
      const it: AsyncIterator<AgentEvent> = {
        next() {
          if (buf.length > 0) return Promise.resolve({ value: buf.shift()!, done: false })
          return new Promise<IteratorResult<AgentEvent>>(() => {})
        },
        return() { return Promise.resolve({ value: undefined, done: true }) },
      }
      return { [Symbol.asyncIterator]: () => it }
    },
    async cancel() {},
    async close() {},
  }
}

/** Make a fake handle that the acquire mock returns. */
function makeHandle(providerId: string, session: ReturnType<typeof makeFakeSession>) {
  return {
    alias: 'a',
    path: '/p',
    providerId,
    lastUsedAt: 0,
    dispatch: (text: string) => session.dispatch(text),
    cancel: async () => { await session.cancel?.() },
    close: async () => {},
  }
}

describe('ConversationCoordinator', () => {
  it('falls back to default mode when no persisted mode exists', () => {
    const registry = createProviderRegistry()
    registry.register('claude', dummyProvider, { displayName: 'Claude', canResume: () => true })
    const c = createConversationCoordinator({
      resolveProject: () => null,
      manager: { acquire: vi.fn() },
      conversationStore: makeMockStore(),
      registry,
      defaultProviderId: 'claude',
      format: () => 'x',
      permissionMode: 'strict',
      loadAccess: adminAccess,
      log: () => {},
    })
    expect(c.getMode('chat-1')).toEqual({ kind: 'solo', provider: 'claude' })
  })

  it('returns persisted mode when present', () => {
    const store = makeMockStore()
    store.set('chat-1', { kind: 'solo', provider: 'codex' })
    const registry = createProviderRegistry()
    registry.register('claude', dummyProvider, { displayName: 'Claude', canResume: () => true })
    registry.register('codex', dummyProvider, { displayName: 'Codex', canResume: () => true })
    const c = createConversationCoordinator({
      resolveProject: () => null,
      manager: { acquire: vi.fn() },
      conversationStore: store,
      registry,
      defaultProviderId: 'claude',
      format: () => 'x',
      permissionMode: 'strict',
      loadAccess: adminAccess,
      log: () => {},
    })
    expect(c.getMode('chat-1')).toEqual({ kind: 'solo', provider: 'codex' })
  })

  it('setMode rejects unknown provider in solo', () => {
    const registry = createProviderRegistry()
    registry.register('claude', dummyProvider, { displayName: 'Claude', canResume: () => true })
    const c = createConversationCoordinator({
      resolveProject: () => null,
      manager: { acquire: vi.fn() },
      conversationStore: makeMockStore(),
      registry,
      defaultProviderId: 'claude',
      format: () => 'x',
      permissionMode: 'strict',
      loadAccess: adminAccess,
      log: () => {},
    })
    expect(() => c.setMode('chat-1', { kind: 'solo', provider: 'mystery' }))
      .toThrow(/unknown provider: mystery/)
  })

  it('setMode persists valid solo mode', () => {
    const store = makeMockStore()
    const registry = createProviderRegistry()
    registry.register('claude', dummyProvider, { displayName: 'Claude', canResume: () => true })
    registry.register('codex', dummyProvider, { displayName: 'Codex', canResume: () => true })
    const c = createConversationCoordinator({
      resolveProject: () => null,
      manager: { acquire: vi.fn() },
      conversationStore: store,
      registry,
      defaultProviderId: 'claude',
      format: () => 'x',
      permissionMode: 'strict',
      loadAccess: adminAccess,
      log: () => {},
    })
    c.setMode('chat-1', { kind: 'solo', provider: 'codex' })
    expect(store.set).toHaveBeenCalledWith('chat-1', { kind: 'solo', provider: 'codex' })
  })

  it('dispatch drops when resolver returns null (no project)', async () => {
    const acquire = vi.fn()
    const registry = createProviderRegistry()
    registry.register('claude', dummyProvider, { displayName: 'Claude', canResume: () => true })
    const log = vi.fn()
    const c = createConversationCoordinator({
      resolveProject: () => null,
      manager: { acquire },
      conversationStore: makeMockStore(),
      registry,
      defaultProviderId: 'claude',
      format: () => 'x',
      permissionMode: 'strict',
      loadAccess: adminAccess,
      log,
    })
    await c.dispatch(inbound('chat-1', 'hi'))
    expect(acquire).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith('COORDINATOR', expect.stringContaining('drop'))
  })

  it('dispatch acquires session under the chat\'s persisted provider', async () => {
    const store = makeMockStore()
    store.set('chat-1', { kind: 'solo', provider: 'codex' })
    const dispatched: string[] = []
    const session = makeFakeSession({
      events: [{ kind: 'result', sessionId: '_', numTurns: 1, durationMs: 0 }],
      onDispatch: t => dispatched.push(t),
    })
    const acquire = vi.fn(async (_req: AcquireRequest) =>
      makeHandle('codex', session)
    )
    const registry = createProviderRegistry()
    registry.register('claude', dummyProvider, { displayName: 'Claude', canResume: () => true })
    registry.register('codex', dummyProvider, { displayName: 'Codex', canResume: () => true })
    const c = createConversationCoordinator({
      resolveProject: () => ({ alias: 'a', path: '/p' }),
      manager: { acquire },
      conversationStore: store,
      registry,
      defaultProviderId: 'claude',
      format: (m) => `[fmt]${m.text}`,
      permissionMode: 'strict',
      loadAccess: adminAccess,
      log: () => {},
    })
    await c.dispatch(inbound('chat-1', 'hi codex'))
    expect(acquire).toHaveBeenCalledWith({
      alias: 'a',
      path: '/p',
      providerId: 'codex',
      chatId: 'chat-1',
      tierProfile: TIER_PROFILES.admin,
      permissionMode: 'strict',
    })
    expect(dispatched).toContain('[fmt]hi codex')
  })

  it('dispatch threads chatId into session acquire with resolved tier (admin lookup)', async () => {
    // Task 10 — coordinator now uses the inbound's real chatId (not the
    // pre-task '_legacy' placeholder) and computes the TierProfile from
    // resolveTier(chatId, loadAccess()). adminChat ∈ access.admins so
    // TIER_PROFILES.admin is passed; a different chatId (guestChat) not
    // listed anywhere collapses to TIER_PROFILES.guest. This pins the
    // chatId pass-through + per-chatId tier resolution in one test.
    const acquireCalls: Array<{ alias: string; chatId: string; tierProfile: TierProfile }> = []
    const session = makeFakeSession({
      events: [{ kind: 'result', sessionId: '_', numTurns: 1, durationMs: 0 }],
    })
    const acquire = vi.fn(async (req: AcquireRequest) => {
      acquireCalls.push({ alias: req.alias, chatId: req.chatId, tierProfile: req.tierProfile })
      return makeHandle(req.providerId, session)
    })
    const registry = createProviderRegistry()
    registry.register('claude', dummyProvider, { displayName: 'Claude', canResume: () => true })
    const c = createConversationCoordinator({
      resolveProject: () => ({ alias: 'a', path: '/p' }),
      manager: { acquire },
      conversationStore: makeMockStore(),
      registry,
      defaultProviderId: 'claude',
      format: () => 'x',
      permissionMode: 'strict',
      // adminChat is admin; guestChat is neither admin nor trusted → guest.
      loadAccess: () => ({
        dmPolicy: 'allowlist',
        allowFrom: [],
        admins: ['adminChat'],
      }),
      log: () => {},
    })
    await c.dispatch(inbound('adminChat', 'hi'))
    expect(acquireCalls[0]).toMatchObject({ chatId: 'adminChat' })
    expect(acquireCalls[0]?.tierProfile).toBe(TIER_PROFILES.admin)
    await c.dispatch(inbound('guestChat', 'hi'))
    expect(acquireCalls[1]).toMatchObject({ chatId: 'guestChat' })
    expect(acquireCalls[1]?.tierProfile).toBe(TIER_PROFILES.guest)
  })

  it('dispatch falls back to default provider when persisted mode references unknown provider', async () => {
    const store = makeMockStore()
    store.set('chat-1', { kind: 'solo', provider: 'gemini' })  // not registered
    const session = makeFakeSession({
      events: [{ kind: 'result', sessionId: '_', numTurns: 1, durationMs: 0 }],
    })
    const acquire = vi.fn(async (_req: AcquireRequest) =>
      makeHandle('claude', session)
    )
    const registry = createProviderRegistry()
    registry.register('claude', dummyProvider, { displayName: 'Claude', canResume: () => true })
    const log = vi.fn()
    const c = createConversationCoordinator({
      resolveProject: () => ({ alias: 'a', path: '/p' }),
      manager: { acquire },
      conversationStore: store,
      registry,
      defaultProviderId: 'claude',
      format: () => 'x',
      permissionMode: 'strict',
      loadAccess: adminAccess,
      log,
    })
    await c.dispatch(inbound('chat-1', 'hi'))
    expect(acquire).toHaveBeenCalledWith({
      alias: 'a',
      path: '/p',
      providerId: 'claude',
      chatId: 'chat-1',
      tierProfile: TIER_PROFILES.admin,
      permissionMode: 'strict',
    })
    expect(log).toHaveBeenCalledWith('COORDINATOR', expect.stringContaining("provider 'gemini' not registered"))
  })

  it('skips fallback sendAssistantText when reply tool was called', async () => {
    const session = makeFakeSession({
      events: [
        { kind: 'tool_call', server: 'wechat', tool: 'reply' },
        { kind: 'result', sessionId: '_', numTurns: 1, durationMs: 0 },
      ],
    })
    const acquire = vi.fn(async (_req: AcquireRequest) =>
      makeHandle('claude', session)
    )
    const sendAssistantText = vi.fn(async (_chatId: string, _text: string) => {})
    const registry = createProviderRegistry()
    registry.register('claude', dummyProvider, { displayName: 'Claude', canResume: () => true })
    const c = createConversationCoordinator({
      resolveProject: () => ({ alias: 'a', path: '/p' }),
      manager: { acquire },
      conversationStore: makeMockStore(),
      registry,
      defaultProviderId: 'claude',
      format: () => 'x',
      sendAssistantText,
      permissionMode: 'strict',
      loadAccess: adminAccess,
      log: () => {},
    })
    await c.dispatch(inbound('chat-1', 'hi'))
    expect(sendAssistantText).not.toHaveBeenCalled()
  })

  it('forwards assistantText via fallback when reply tool was NOT called', async () => {
    const session = makeFakeSession({
      events: [
        { kind: 'text', text: 'raw text 1' },
        { kind: 'text', text: 'raw text 2' },
        { kind: 'result', sessionId: '_', numTurns: 1, durationMs: 0 },
      ],
    })
    const acquire = vi.fn(async (_req: AcquireRequest) =>
      makeHandle('claude', session)
    )
    const sendAssistantText = vi.fn(async (_chatId: string, _text: string) => {})
    const registry = createProviderRegistry()
    registry.register('claude', dummyProvider, { displayName: 'Claude', canResume: () => true })
    const c = createConversationCoordinator({
      resolveProject: () => ({ alias: 'a', path: '/p' }),
      manager: { acquire },
      conversationStore: makeMockStore(),
      registry,
      defaultProviderId: 'claude',
      format: () => 'x',
      sendAssistantText,
      permissionMode: 'strict',
      loadAccess: adminAccess,
      log: () => {},
    })
    await c.dispatch(inbound('chat-1', 'hi'))
    expect(sendAssistantText).toHaveBeenCalledTimes(2)
    expect(sendAssistantText).toHaveBeenCalledWith('chat-1', 'raw text 1')
    expect(sendAssistantText).toHaveBeenCalledWith('chat-1', 'raw text 2')
  })

  it('on auth_failed: suppresses raw assistant text AND sends a single neutral notice', async () => {
    // When the provider emits a structured auth_failed error (claude binary
    // surfaced "Please run /login" as assistant text), the coordinator must
    // NOT forward any of the text via fallback-reply. It instead sends one
    // controlled user-facing notice — generic, no terminal instructions.
    const session = makeFakeSession({
      events: [
        // Provider intercepts the "Please run /login" text and emits a
        // structured error in its place (see claude-agent-provider).
        { kind: 'error', code: 'auth_failed', message: 'claude reports not logged in: Not logged in · Please run /login' },
        { kind: 'result', sessionId: '_', numTurns: 1, durationMs: 0 },
      ],
    })
    const acquire = vi.fn(async (_req: AcquireRequest) =>
      makeHandle('claude', session)
    )
    const sendAssistantText = vi.fn(async (_chatId: string, _text: string) => {})
    const registry = createProviderRegistry()
    registry.register('claude', dummyProvider, { displayName: 'Claude', canResume: () => true })
    const c = createConversationCoordinator({
      resolveProject: () => ({ alias: 'a', path: '/p' }),
      manager: { acquire },
      conversationStore: makeMockStore(),
      registry,
      defaultProviderId: 'claude',
      format: () => 'x',
      sendAssistantText,
      permissionMode: 'strict',
      loadAccess: adminAccess,
      log: () => {},
    })
    await c.dispatch(inbound('chat-1', 'hi'))
    // Exactly one outbound message, NOT the raw "Please run /login" text.
    expect(sendAssistantText).toHaveBeenCalledTimes(1)
    const [chatId, text] = sendAssistantText.mock.calls[0]!
    expect(chatId).toBe('chat-1')
    expect(text).not.toContain('Please run /login')
    expect(text).not.toContain('Not logged in')
    expect(text).toMatch(/Claude 登录已过期/)
    expect(text).toContain('claude login')
  })

  it('on auth_failed: releases the in-memory session so the next dispatch starts a fresh subprocess', async () => {
    // The notice alone is not enough — without releasing the session, a
    // busy chat (where dispatch() keeps bumping lastUsedAt) never goes
    // idle, so sweepIdle never recycles the poisoned subprocess and the
    // user is stuck behind the throttle window with no recovery.
    const release = vi.fn(async () => {})
    const session = makeFakeSession({
      events: [
        { kind: 'error', code: 'auth_failed', message: 'x' },
        { kind: 'result', sessionId: '_', numTurns: 1, durationMs: 0 },
      ],
    })
    const acquire = vi.fn(async (req: AcquireRequest) =>
      makeHandle(req.providerId, session)
    )
    const registry = createProviderRegistry()
    registry.register('claude', dummyProvider, { displayName: 'Claude', canResume: () => true })
    const c = createConversationCoordinator({
      resolveProject: () => ({ alias: 'a', path: '/p' }),
      manager: { acquire, release },
      conversationStore: makeMockStore(),
      registry,
      defaultProviderId: 'claude',
      format: () => 'x',
      sendAssistantText: async () => {},
      permissionMode: 'strict',
      loadAccess: adminAccess,
      log: () => {},
    })
    await c.dispatch(inbound('chat-1', 'hi'))
    expect(release).toHaveBeenCalledTimes(1)
    expect(release).toHaveBeenCalledWith({ alias: 'a', providerId: 'claude', chatId: 'chat-1' })
  })

  it('on turn timeout: returns (no hang), releases the wedged session, and sends a retry notice', async () => {
    // The reported failure: a silently-stalled turn left the pipeline wedged
    // forever. With a per-turn watchdog, dispatch must RETURN, discard the
    // poisoned session (so the next message gets a fresh subprocess), and
    // tell the user to retry.
    const release = vi.fn(async () => {})
    const acquire = vi.fn(async (req: AcquireRequest) =>
      makeHandle(req.providerId, hangingSession([{ kind: 'text', text: 'partial…' }]))
    )
    const sendAssistantText = vi.fn(async (_chatId: string, _text: string) => {})
    const registry = createProviderRegistry()
    registry.register('claude', dummyProvider, { displayName: 'Claude', canResume: () => true })
    const c = createConversationCoordinator({
      resolveProject: () => ({ alias: 'a', path: '/p' }),
      manager: { acquire, release },
      conversationStore: makeMockStore(),
      registry,
      defaultProviderId: 'claude',
      format: () => 'x',
      sendAssistantText,
      permissionMode: 'strict',
      loadAccess: adminAccess,
      log: () => {},
      turnTimeoutMs: 30,
    })
    await c.dispatch(inbound('chat-1', 'hi'))
    expect(release).toHaveBeenCalledTimes(1)
    expect(release).toHaveBeenCalledWith({ alias: 'a', providerId: 'claude', chatId: 'chat-1' })
    expect(sendAssistantText).toHaveBeenCalledTimes(1)
    const [chatId, text] = sendAssistantText.mock.calls[0]!
    expect(chatId).toBe('chat-1')
    expect(text).toMatch(/超时|重发/)
  }, 3000)

  it('emits a structured TurnRecord for a completed solo turn', async () => {
    const session = makeFakeSession({
      events: [
        { kind: 'text', text: 'hi there' },
        { kind: 'tool_call', server: 'wechat', tool: 'reply' },
        { kind: 'result', sessionId: 's1', numTurns: 1, durationMs: 0 },
      ],
    })
    const acquire = vi.fn(async (req: AcquireRequest) => makeHandle(req.providerId, session))
    const recordTurn = vi.fn()
    const registry = createProviderRegistry()
    registry.register('claude', dummyProvider, { displayName: 'Claude', canResume: () => true })
    let clock = 1_000
    const c = createConversationCoordinator({
      resolveProject: () => ({ alias: 'a', path: '/p' }),
      manager: { acquire },
      conversationStore: makeMockStore(),
      registry,
      defaultProviderId: 'claude',
      format: () => 'x',
      permissionMode: 'strict',
      loadAccess: adminAccess,
      log: () => {},
      recordTurn,
      now: () => clock,
    })
    await c.dispatch(inbound('chat-1', 'hi'))
    expect(recordTurn).toHaveBeenCalledTimes(1)
    expect(recordTurn.mock.calls[0]![0]).toMatchObject({
      chatId: 'chat-1',
      provider: 'claude',
      alias: 'a',
      mode: 'solo',
      outcome: 'completed',
      replyToolCalled: true,
    })
  })

  it('labels a primary_tool turn as mode=primary_tool (not solo) in its TurnRecord', async () => {
    // primary_tool dispatches through dispatchSolo; a literal mode:'solo' would
    // mislabel it in GET /v1/turns and misdirect "why did chat X stop replying".
    const session = makeFakeSession({ events: [
      { kind: 'tool_call', server: 'wechat', tool: 'reply' },
      { kind: 'result', sessionId: 's1', numTurns: 1, durationMs: 0 },
    ] })
    const acquire = vi.fn(async (req: AcquireRequest) => makeHandle(req.providerId, session))
    const recordTurn = vi.fn()
    const registry = createProviderRegistry()
    registry.register('claude', dummyProvider, { displayName: 'Claude', canResume: () => true })
    registry.register('codex', dummyProvider, { displayName: 'Codex', canResume: () => true })
    const store = makeMockStore()
    store.set('chat-pt', { kind: 'primary_tool', primary: 'claude' })
    const c = createConversationCoordinator({
      resolveProject: () => ({ alias: 'a', path: '/p' }),
      manager: { acquire },
      conversationStore: store,
      registry,
      defaultProviderId: 'claude',
      format: () => 'x',
      permissionMode: 'strict',
      loadAccess: adminAccess,
      log: () => {},
      recordTurn,
    })
    await c.dispatch(inbound('chat-pt', 'hi'))
    expect(recordTurn).toHaveBeenCalledTimes(1)
    expect(recordTurn.mock.calls[0]![0]).toMatchObject({ chatId: 'chat-pt', mode: 'primary_tool', outcome: 'completed' })
  })

  it('emits a TurnRecord with outcome=timeout when the watchdog fires', async () => {
    const acquire = vi.fn(async (req: AcquireRequest) => makeHandle(req.providerId, hangingSession()))
    const recordTurn = vi.fn()
    const registry = createProviderRegistry()
    registry.register('claude', dummyProvider, { displayName: 'Claude', canResume: () => true })
    const c = createConversationCoordinator({
      resolveProject: () => ({ alias: 'a', path: '/p' }),
      manager: { acquire, release: async () => {} },
      conversationStore: makeMockStore(),
      registry,
      defaultProviderId: 'claude',
      format: () => 'x',
      sendAssistantText: async () => {},
      permissionMode: 'strict',
      loadAccess: adminAccess,
      log: () => {},
      recordTurn,
      turnTimeoutMs: 30,
    })
    await c.dispatch(inbound('chat-1', 'hi'))
    expect(recordTurn).toHaveBeenCalledTimes(1)
    expect(recordTurn.mock.calls[0]![0]).toMatchObject({ chatId: 'chat-1', provider: 'claude', outcome: 'timeout' })
  }, 3000)

  it('on auth_failed: throttles repeated notices for the same chat', async () => {
    const session = makeFakeSession({
      events: [
        { kind: 'error', code: 'auth_failed', message: 'x' },
        { kind: 'result', sessionId: '_', numTurns: 1, durationMs: 0 },
      ],
    })
    const acquire = vi.fn(async (_req: AcquireRequest) =>
      makeHandle('claude', session)
    )
    const sendAssistantText = vi.fn(async (_chatId: string, _text: string) => {})
    const registry = createProviderRegistry()
    registry.register('claude', dummyProvider, { displayName: 'Claude', canResume: () => true })
    let clock = 1_000_000
    const c = createConversationCoordinator({
      resolveProject: () => ({ alias: 'a', path: '/p' }),
      manager: { acquire },
      conversationStore: makeMockStore(),
      registry,
      defaultProviderId: 'claude',
      format: () => 'x',
      sendAssistantText,
      permissionMode: 'strict',
      loadAccess: adminAccess,
      log: () => {},
      authFailNotifyThrottleMs: 1000,
      now: () => clock,
    })
    // First failure: one notice.
    await c.dispatch(inbound('chat-1', 'hi'))
    expect(sendAssistantText).toHaveBeenCalledTimes(1)
    // 500ms later (within throttle window): silent.
    clock += 500
    await c.dispatch(inbound('chat-1', 'hi again'))
    expect(sendAssistantText).toHaveBeenCalledTimes(1)
    // Past the window: notice again.
    clock += 600
    await c.dispatch(inbound('chat-1', 'still broken?'))
    expect(sendAssistantText).toHaveBeenCalledTimes(2)
    // Different chat shares no throttle slot — first hit notifies immediately.
    await c.dispatch(inbound('chat-2', 'hi'))
    expect(sendAssistantText).toHaveBeenCalledTimes(3)
  })

  // chatroom is now implemented in P5 — see "chatroom mode (P5)" describe block below.

  it('dispatch calls assertSupported for the effective provider before acquiring session', async () => {
    // Spy on assertSupported — verify it's called with correct (mode, provider, permissionMode)
    const spy = vi.spyOn(capabilityMatrix, 'assertSupported')
    const session = makeFakeSession({
      events: [{ kind: 'result', sessionId: '_', numTurns: 1, durationMs: 0 }],
    })
    const acquire = vi.fn(async (_req: AcquireRequest) =>
      makeHandle('claude', session)
    )
    const registry = createProviderRegistry()
    registry.register('claude', dummyProvider, { displayName: 'Claude', canResume: () => true })
    const c = createConversationCoordinator({
      resolveProject: () => ({ alias: 'a', path: '/p' }),
      manager: { acquire },
      conversationStore: makeMockStore(),
      registry,
      defaultProviderId: 'claude',
      format: () => 'x',
      permissionMode: 'strict',
      loadAccess: adminAccess,
      log: () => {},
    })
    await c.dispatch(inbound('chat-1', 'hi'))
    expect(spy).toHaveBeenCalledWith('solo', 'claude', 'strict')
    spy.mockRestore()
  })

  // ─── primary_tool mode (RFC 03 P4) ──────────────────────────────────

  describe('primary_tool mode (P4)', () => {
    function setupPrimaryTool(opts: { initialMode?: { kind: 'primary_tool'; primary: string } } = {}) {
      const store = makeMockStore()
      if (opts.initialMode) store.set('chat-1', opts.initialMode)
      const registry = createProviderRegistry()
      registry.register('claude', dummyProvider, { displayName: 'Claude', canResume: () => true })
      registry.register('codex', dummyProvider, { displayName: 'Codex', canResume: () => true })
      const dispatched: string[] = []
      const session = makeFakeSession({
        events: [
          { kind: 'tool_call', server: 'wechat', tool: 'reply' },
          { kind: 'result', sessionId: '_', numTurns: 1, durationMs: 0 },
        ],
        onDispatch: t => dispatched.push(t),
      })
      const acquire = vi.fn(async (req: AcquireRequest) =>
        makeHandle(req.providerId, session)
      )
      const log = vi.fn()
      const c = createConversationCoordinator({
        resolveProject: () => ({ alias: 'a', path: '/p' }),
        manager: { acquire },
        conversationStore: store,
        registry,
        defaultProviderId: 'claude',
        format: () => 'x',
        permissionMode: 'strict',
        loadAccess: adminAccess,
        log,
      })
      return { c, acquire, dispatched, log, store }
    }

    it('dispatches solo to the primary provider (peer reachable via delegate-mcp tool, not parallel session)', async () => {
      const { c, acquire, dispatched } = setupPrimaryTool({ initialMode: { kind: 'primary_tool', primary: 'claude' } })
      await c.dispatch(inbound('chat-1', 'hi'))
      expect(acquire).toHaveBeenCalledTimes(1)
      expect(acquire.mock.calls[0]?.[0]?.providerId).toBe('claude')
      expect(dispatched).toHaveLength(1)
    })

    it('reverse — primary_tool with codex primary dispatches to codex', async () => {
      const { c, acquire } = setupPrimaryTool({ initialMode: { kind: 'primary_tool', primary: 'codex' } })
      await c.dispatch(inbound('chat-1', 'hi'))
      expect(acquire.mock.calls[0]?.[0]?.providerId).toBe('codex')
    })

    it('falls back to solo+default when persisted primary is no longer registered', async () => {
      const store = makeMockStore()
      store.set('chat-1', { kind: 'primary_tool', primary: 'gemini' })
      const registry = createProviderRegistry()
      registry.register('claude', dummyProvider, { displayName: 'Claude', canResume: () => true })
      registry.register('codex', dummyProvider, { displayName: 'Codex', canResume: () => true })
      const session = makeFakeSession({
        events: [
          { kind: 'tool_call', server: 'wechat', tool: 'reply' },
          { kind: 'result', sessionId: '_', numTurns: 1, durationMs: 0 },
        ],
      })
      const acquire = vi.fn(async (_req: AcquireRequest) =>
        makeHandle('claude', session)
      )
      const log = vi.fn()
      const c = createConversationCoordinator({
        resolveProject: () => ({ alias: 'a', path: '/p' }),
        manager: { acquire },
        conversationStore: store,
        registry,
        defaultProviderId: 'claude',
        format: () => 'x',
        permissionMode: 'strict',
        loadAccess: adminAccess,
        log,
      })
      await c.dispatch(inbound('chat-1', 'hi'))
      expect(acquire.mock.calls[0]?.[0]?.providerId).toBe('claude')
      expect(log).toHaveBeenCalledWith('COORDINATOR', expect.stringContaining("primary 'gemini' not registered"))
    })

    it('setMode rejects primary_tool when peer provider missing from registry', () => {
      const store = makeMockStore()
      const registry = createProviderRegistry()
      registry.register('claude', dummyProvider, { displayName: 'Claude', canResume: () => true })
      // codex missing
      const c = createConversationCoordinator({
        resolveProject: () => null,
        manager: { acquire: vi.fn() },
        conversationStore: store,
        registry,
        defaultProviderId: 'claude',
        format: () => 'x',
        permissionMode: 'strict',
        loadAccess: adminAccess,
        log: () => {},
      })
      expect(() => c.setMode('chat-1', { kind: 'primary_tool', primary: 'claude' }))
        .toThrow(/missing: codex/)
    })
  })

  // ─── parallel mode (RFC 03 P3) ───────────────────────────────────────

  describe('parallel mode (P3)', () => {
    function setupParallel(opts: {
      claudeEvents?: AgentEvent[]
      codexEvents?: AgentEvent[]
      claudeThrows?: Error
      codexThrows?: Error
      recordTurn?: (r: import('./conversation-coordinator').TurnRecord) => void
    } = {}) {
      const store = makeMockStore()
      store.set('chat-1', { kind: 'parallel' })
      const registry = createProviderRegistry()
      registry.register('claude', dummyProvider, { displayName: 'Claude', canResume: () => true })
      registry.register('codex', dummyProvider, { displayName: 'Codex', canResume: () => true })
      const sendAssistantText = vi.fn(async (_chatId: string, _text: string) => {})
      const dispatchCalls: Array<{ providerId: string; text: string }> = []

      const defaultResultEvent: AgentEvent = { kind: 'result', sessionId: '_', numTurns: 1, durationMs: 0 }
      const defaultReplyEvents: AgentEvent[] = [
        { kind: 'tool_call', server: 'wechat', tool: 'reply' },
        defaultResultEvent,
      ]

      const claudeEvents = opts.claudeEvents ?? defaultReplyEvents
      const codexEvents = opts.codexEvents ?? defaultReplyEvents

      const acquire = vi.fn(async (req: AcquireRequest) => {
        const { alias, path, providerId } = req
        if (providerId === 'claude' && opts.claudeThrows) {
          return {
            alias, path, providerId, lastUsedAt: 0,
            dispatch: (_text: string): AsyncIterable<AgentEvent> => {
              const err = opts.claudeThrows!
              return {
                async *[Symbol.asyncIterator]() { throw err },
              }
            },
            close: async () => {},
          }
        }
        if (providerId === 'codex' && opts.codexThrows) {
          return {
            alias, path, providerId, lastUsedAt: 0,
            dispatch: (_text: string): AsyncIterable<AgentEvent> => {
              const err = opts.codexThrows!
              return {
                async *[Symbol.asyncIterator]() { throw err },
              }
            },
            close: async () => {},
          }
        }
        const events = providerId === 'claude' ? claudeEvents : codexEvents
        const session = makeFakeSession({
          events,
          onDispatch: t => dispatchCalls.push({ providerId, text: t }),
        })
        return makeHandle(providerId, session)
      })
      const c = createConversationCoordinator({
        resolveProject: () => ({ alias: 'a', path: '/p' }),
        manager: { acquire },
        conversationStore: store,
        registry,
        defaultProviderId: 'claude',
        format: (m) => m.text,
        sendAssistantText,
        permissionMode: 'strict',
        loadAccess: adminAccess,
        log: () => {},
        ...(opts.recordTurn ? { recordTurn: opts.recordTurn } : {}),
      })
      return { c, acquire, sendAssistantText, dispatchCalls }
    }

    it('on auth_failed: releases ONLY the failing provider; other provider replies normally', async () => {
      // The solo path's release-on-auth-failed pattern must extend to /both
      // mode too — without it, a stale-credential provider stays cached in
      // the session pool for the full idle window (30 min) and every /both
      // dispatch silently produces no reply from that side.
      const store = makeMockStore()
      store.set('chat-p', { kind: 'parallel' })
      const registry = createProviderRegistry()
      registry.register('claude', dummyProvider, { displayName: 'Claude', canResume: () => true })
      registry.register('codex', dummyProvider, { displayName: 'Codex', canResume: () => true })
      const release = vi.fn(async () => {})
      const acquire = vi.fn(async (req: AcquireRequest) => {
        const { providerId } = req
        const events: AgentEvent[] = providerId === 'claude'
          ? [
              { kind: 'error', code: 'auth_failed', message: 'claude reports not logged in' },
              { kind: 'result', sessionId: '_', numTurns: 1, durationMs: 0 },
            ]
          : [
              { kind: 'text', text: 'codex reply' },
              { kind: 'result', sessionId: '_', numTurns: 1, durationMs: 0 },
            ]
        return makeHandle(providerId, makeFakeSession({ events }))
      })
      const sendAssistantText = vi.fn(async (_chatId: string, _text: string) => {})
      const c = createConversationCoordinator({
        resolveProject: () => ({ alias: 'a', path: '/p' }),
        manager: { acquire, release },
        conversationStore: store,
        registry,
        defaultProviderId: 'claude',
        format: (m) => m.text,
        sendAssistantText,
        permissionMode: 'strict',
        loadAccess: adminAccess,
        log: () => {},
      })
      await c.dispatch(inbound('chat-p', 'hi'))

      // Failing provider was released; healthy one was not.
      expect(release).toHaveBeenCalledWith({ alias: 'a', providerId: 'claude', chatId: 'chat-p' })
      expect(release).not.toHaveBeenCalledWith('a', 'codex')
      // Codex's normal reply made it through with the parallel-mode prefix.
      const sent = sendAssistantText.mock.calls.map(call => call[1] as string)
      expect(sent.some(t => t === '[Codex] codex reply')).toBe(true)
      // Exactly one neutral auth-fail notice, regardless of which provider failed.
      const notices = sent.filter(t => /登录已过期/.test(t))
      expect(notices).toHaveLength(1)
      expect(notices[0]).toMatch(/Claude 登录已过期/)
      expect(notices[0]).toContain('claude login')
      // The raw "Not logged in / Please run /login" string did NOT leak.
      expect(sent.some(t => /Please run \/login|Not logged in/.test(t))).toBe(false)
    })

    it('on turn timeout in parallel: releases ONLY the stalled provider; the other still replies', async () => {
      // Parity with the auth_failed parallel path: a silently-stalled
      // participant must not hang the whole /both turn (Promise.allSettled
      // would never settle). The watchdog bounds it, releases that side,
      // tells the user, and the healthy provider's reply still goes out.
      const store = makeMockStore()
      store.set('chat-p', { kind: 'parallel' })
      const registry = createProviderRegistry()
      registry.register('claude', dummyProvider, { displayName: 'Claude', canResume: () => true })
      registry.register('codex', dummyProvider, { displayName: 'Codex', canResume: () => true })
      const release = vi.fn(async () => {})
      const acquire = vi.fn(async (req: AcquireRequest) =>
        req.providerId === 'claude'
          ? makeHandle('claude', hangingSession([{ kind: 'text', text: 'partial…' }]))
          : makeHandle('codex', makeFakeSession({ events: [
              { kind: 'text', text: 'codex reply' },
              { kind: 'result', sessionId: '_', numTurns: 1, durationMs: 0 },
            ] }))
      )
      const sendAssistantText = vi.fn(async (_chatId: string, _text: string) => {})
      const c = createConversationCoordinator({
        resolveProject: () => ({ alias: 'a', path: '/p' }),
        manager: { acquire, release },
        conversationStore: store,
        registry,
        defaultProviderId: 'claude',
        format: (m) => m.text,
        sendAssistantText,
        permissionMode: 'strict',
        loadAccess: adminAccess,
        log: () => {},
        turnTimeoutMs: 30,
      })
      await c.dispatch(inbound('chat-p', 'hi'))
      // Stalled provider released; healthy one untouched.
      expect(release).toHaveBeenCalledWith({ alias: 'a', providerId: 'claude', chatId: 'chat-p' })
      const sent = sendAssistantText.mock.calls.map(call => call[1] as string)
      // Codex's reply still forwarded with the parallel-mode prefix.
      expect(sent.some(t => t === '[Codex] codex reply')).toBe(true)
      // One timeout notice for the stalled side.
      expect(sent.some(t => /超时|重发/.test(t))).toBe(true)
    }, 3000)

    it('on acquire failure in parallel: the other provider still replies (allSettled acquire)', async () => {
      // Regression: dispatchParallel used Promise.all for the ACQUIRE phase, so
      // a single acquire rejection (spawn failure / pool exhausted) threw the
      // whole batch — BOTH providers dropped with no reply and no TurnRecord,
      // contradicting the documented "if one throws the other's reply still
      // goes through" guarantee (which only held for the dispatch phase).
      const store = makeMockStore()
      store.set('chat-p', { kind: 'parallel' })
      const registry = createProviderRegistry()
      registry.register('claude', dummyProvider, { displayName: 'Claude', canResume: () => true })
      registry.register('codex', dummyProvider, { displayName: 'Codex', canResume: () => true })
      const acquire = vi.fn(async (req: AcquireRequest) => {
        if (req.providerId === 'claude') throw new Error('spawn failed: pool exhausted')
        return makeHandle('codex', makeFakeSession({ events: [
          { kind: 'text', text: 'codex reply' },
          { kind: 'result', sessionId: '_', numTurns: 1, durationMs: 0 },
        ] }))
      })
      const sendAssistantText = vi.fn(async (_chatId: string, _text: string) => {})
      const recordTurn = vi.fn()
      const c = createConversationCoordinator({
        resolveProject: () => ({ alias: 'a', path: '/p' }),
        manager: { acquire, release: vi.fn(async () => {}) },
        conversationStore: store,
        registry,
        defaultProviderId: 'claude',
        format: (m) => m.text,
        sendAssistantText,
        permissionMode: 'strict',
        loadAccess: adminAccess,
        log: () => {},
        recordTurn,
      })
      await c.dispatch(inbound('chat-p', 'hi'))
      const sent = sendAssistantText.mock.calls.map(call => call[1] as string)
      // Codex's reply still goes through despite claude's acquire failing.
      expect(sent.some(t => t === '[Codex] codex reply')).toBe(true)
      // A TurnRecord is emitted for BOTH providers — claude=error, codex=completed.
      const byProvider = Object.fromEntries(recordTurn.mock.calls.map(([r]) => [r.provider, r]))
      expect(byProvider['claude']).toMatchObject({ mode: 'parallel', outcome: 'error' })
      expect(byProvider['codex']).toMatchObject({ mode: 'parallel', outcome: 'completed' })
    })

    it('fans out the same inbound to both providers concurrently', async () => {
      const { c, acquire, dispatchCalls } = setupParallel()
      await c.dispatch(inbound('chat-1', 'hello both'))
      // acquire called twice — once per provider
      expect(acquire).toHaveBeenCalledTimes(2)
      expect(acquire.mock.calls.map(([req]) => req.providerId).sort()).toEqual(['claude', 'codex'])
      // dispatch called twice with same text
      expect(dispatchCalls).toHaveLength(2)
      expect(dispatchCalls[0]?.text).toBe('hello both')
      expect(dispatchCalls[1]?.text).toBe('hello both')
    })

    it('emits one TurnRecord per participant in parallel mode', async () => {
      // Observability parity with solo: /both must leave a structured record
      // for EACH provider's turn, tagged mode=parallel, so "why did this chat
      // stop replying" is answerable for /both too.
      const recordTurn = vi.fn()
      const { c } = setupParallel({
        claudeEvents: [
          { kind: 'text', text: 'hi' },
          { kind: 'tool_call', server: 'wechat', tool: 'reply' },
          { kind: 'result', sessionId: '_', numTurns: 1, durationMs: 0 },
        ],
        codexEvents: [
          { kind: 'text', text: 'yo' },
          { kind: 'result', sessionId: '_', numTurns: 1, durationMs: 0 },
        ],
        recordTurn,
      })
      await c.dispatch(inbound('chat-1', 'hi'))
      expect(recordTurn).toHaveBeenCalledTimes(2)
      const byProvider = Object.fromEntries(
        recordTurn.mock.calls.map(([r]) => [r.provider, r]),
      )
      expect(byProvider['claude']).toMatchObject({ mode: 'parallel', outcome: 'completed', replyToolCalled: true })
      expect(byProvider['codex']).toMatchObject({ mode: 'parallel', outcome: 'completed', replyToolCalled: false, textChunks: 1 })
    })

    it('emits a TurnRecord with outcome=timeout for a stalled participant in parallel mode', async () => {
      const recordTurn = vi.fn()
      const store = makeMockStore()
      store.set('chat-p', { kind: 'parallel' })
      const registry = createProviderRegistry()
      registry.register('claude', dummyProvider, { displayName: 'Claude', canResume: () => true })
      registry.register('codex', dummyProvider, { displayName: 'Codex', canResume: () => true })
      const acquire = vi.fn(async (req: AcquireRequest) =>
        req.providerId === 'claude'
          ? makeHandle('claude', hangingSession([{ kind: 'text', text: 'partial…' }]))
          : makeHandle('codex', makeFakeSession({ events: [
              { kind: 'text', text: 'codex reply' },
              { kind: 'result', sessionId: '_', numTurns: 1, durationMs: 0 },
            ] }))
      )
      const c = createConversationCoordinator({
        resolveProject: () => ({ alias: 'a', path: '/p' }),
        manager: { acquire, release: async () => {} },
        conversationStore: store,
        registry,
        defaultProviderId: 'claude',
        format: (m) => m.text,
        sendAssistantText: async () => {},
        permissionMode: 'strict',
        loadAccess: adminAccess,
        log: () => {},
        recordTurn,
        turnTimeoutMs: 30,
      })
      await c.dispatch(inbound('chat-p', 'hi'))
      const byProvider = Object.fromEntries(recordTurn.mock.calls.map(([r]) => [r.provider, r]))
      expect(byProvider['claude']).toMatchObject({ mode: 'parallel', outcome: 'timeout' })
      expect(byProvider['codex']).toMatchObject({ mode: 'parallel', outcome: 'completed' })
    }, 3000)

    it('skips fallback sendAssistantText when both providers called reply tool', async () => {
      const { c, sendAssistantText } = setupParallel({
        claudeEvents: [
          { kind: 'text', text: 'hi' },
          { kind: 'tool_call', server: 'wechat', tool: 'reply' },
          { kind: 'result', sessionId: '_', numTurns: 1, durationMs: 0 },
        ],
        codexEvents: [
          { kind: 'text', text: 'hi' },
          { kind: 'tool_call', server: 'wechat', tool: 'reply' },
          { kind: 'result', sessionId: '_', numTurns: 1, durationMs: 0 },
        ],
      })
      await c.dispatch(inbound('chat-1', 'hi'))
      expect(sendAssistantText).not.toHaveBeenCalled()
    })

    it('forwards prefixed assistant text via fallback per-provider when reply tool NOT called', async () => {
      const { c, sendAssistantText } = setupParallel({
        claudeEvents: [
          { kind: 'text', text: 'claude raw 1' },
          { kind: 'text', text: 'claude raw 2' },
          { kind: 'result', sessionId: '_', numTurns: 1, durationMs: 0 },
        ],
        codexEvents: [
          { kind: 'text', text: 'codex raw' },
          { kind: 'result', sessionId: '_', numTurns: 1, durationMs: 0 },
        ],
      })
      await c.dispatch(inbound('chat-1', 'hi'))
      const sent = sendAssistantText.mock.calls.map(([, t]) => t).sort()
      expect(sent).toEqual([
        '[Claude] claude raw 1',
        '[Claude] claude raw 2',
        '[Codex] codex raw',
      ])
    })

    it('one provider throwing does NOT block the other (allSettled semantics)', async () => {
      const { c, sendAssistantText } = setupParallel({
        claudeThrows: new Error('claude went poof'),
        codexEvents: [
          { kind: 'text', text: 'codex still here' },
          { kind: 'result', sessionId: '_', numTurns: 1, durationMs: 0 },
        ],
      })
      await c.dispatch(inbound('chat-1', 'hi'))
      // Codex's text still made it through
      expect(sendAssistantText).toHaveBeenCalledWith('chat-1', '[Codex] codex still here')
    })

    it('falls back to solo+default when parallel resolves to a single participant', async () => {
      // P3 N-way: when the registry has only 1 provider, resolveParticipants
      // returns a 1-element list and dispatch degrades to solo (using that
      // one provider directly — semantically equivalent to "no point fanning
      // out to a single member"). Replaces the pre-P3 "missing provider"
      // hard fallback path.
      const store = makeMockStore()
      store.set('chat-1', { kind: 'parallel' })
      // Only claude registered — codex missing
      const registry = createProviderRegistry()
      registry.register('claude', dummyProvider, { displayName: 'Claude', canResume: () => true })
      const session = makeFakeSession({
        events: [
          { kind: 'tool_call', server: 'wechat', tool: 'reply' },
          { kind: 'result', sessionId: '_', numTurns: 1, durationMs: 0 },
        ],
      })
      const acquire = vi.fn(async (_req: AcquireRequest) =>
        makeHandle('claude', session)
      )
      const log = vi.fn()
      const c = createConversationCoordinator({
        resolveProject: () => ({ alias: 'a', path: '/p' }),
        manager: { acquire },
        conversationStore: store,
        registry,
        defaultProviderId: 'claude',
        format: () => 'x',
        permissionMode: 'strict',
        loadAccess: adminAccess,
        log,
      })
      await c.dispatch(inbound('chat-1', 'hi'))
      // Acquired ONCE under solo, not twice
      expect(acquire).toHaveBeenCalledTimes(1)
      expect(acquire.mock.calls[0]?.[0]?.providerId).toBe('claude')
      expect(log).toHaveBeenCalledWith('COORDINATOR', expect.stringContaining('degrading to solo'))
    })

    it('setMode rejects parallel when explicit participants include an unregistered provider', () => {
      // P3 N-way: validateMode now only rejects when participants are
      // explicitly stated AND include an unknown id. Undefined participants
      // defers to dispatch-time resolution.
      const store = makeMockStore()
      const registry = createProviderRegistry()
      registry.register('claude', dummyProvider, { displayName: 'Claude', canResume: () => true })
      // codex not registered
      const c = createConversationCoordinator({
        resolveProject: () => null,
        manager: { acquire: vi.fn() },
        conversationStore: store,
        registry,
        defaultProviderId: 'claude',
        format: () => 'x',
        permissionMode: 'strict',
        loadAccess: adminAccess,
        log: () => {},
      })
      expect(() => c.setMode('chat-1', { kind: 'parallel', participants: ['claude', 'codex'] }))
        .toThrow(/unknown providers.*codex/)
    })

    it('honours custom parallelProviders list (e.g. for tests with non-default ids)', async () => {
      const store = makeMockStore()
      store.set('chat-1', { kind: 'parallel' })
      const registry = createProviderRegistry()
      registry.register('alice', dummyProvider, { displayName: 'Alice', canResume: () => true })
      registry.register('bob', dummyProvider, { displayName: 'Bob', canResume: () => true })
      const sendAssistantText = vi.fn(async (_chatId: string, _text: string) => {})
      const acquire = vi.fn(async ({ providerId }: AcquireRequest) => {
        const session = makeFakeSession({
          events: [
            { kind: 'text', text: `hi from ${providerId}` },
            { kind: 'result', sessionId: '_', numTurns: 1, durationMs: 0 },
          ],
        })
        return makeHandle(providerId, session)
      })
      const c = createConversationCoordinator({
        resolveProject: () => ({ alias: 'a', path: '/p' }),
        manager: { acquire },
        conversationStore: store,
        registry,
        defaultProviderId: 'alice',
        parallelProviders: ['alice', 'bob'],
        format: () => 'x',
        sendAssistantText,
        permissionMode: 'strict',
        loadAccess: adminAccess,
        log: () => {},
      })
      await c.dispatch(inbound('chat-1', 'hi'))
      const sent = sendAssistantText.mock.calls.map(([, t]) => t).sort()
      expect(sent).toEqual(['[Alice] hi from alice', '[Bob] hi from bob'])
    })
  })

  // ─── chatroom mode (RFC 03 P5) ───────────────────────────────────────

  describe('chatroom mode (P5, three-beat pipeline)', () => {
    /**
     * Minimal shared setup: both providers reply with their providerId text,
     * haikuEval returns a 🎯 verdict string by default. Overridable per-test.
     */
    function setupChatroom(opts: {
      claudeReply?: string | null   // null = throw; default = 'claude-reply'
      codexReply?: string | null    // null = throw; default = 'codex-reply'
      haikuResponse?: string | ((callNum: number, prompt: string) => string)
      recordTurn?: (r: import('./conversation-coordinator').TurnRecord) => void
      release?: () => Promise<void>
      turnTimeoutMs?: number
      verdictEval?: (prompt: string) => Promise<string>
      claudeRepliesViaTool?: boolean
    } = {}) {
      const store = makeMockStore()
      store.set('chat-1', { kind: 'chatroom' })
      const registry = createProviderRegistry()
      registry.register('claude', dummyProvider, { displayName: 'Claude', canResume: () => true })
      registry.register('codex', dummyProvider, { displayName: 'Codex', canResume: () => true })
      const sent: string[] = []
      const acquire = vi.fn(async ({ providerId }: AcquireRequest) => {
        const reply = providerId === 'claude'
          ? (opts.claudeReply !== undefined ? opts.claudeReply : 'claude-reply')
          : (opts.codexReply !== undefined ? opts.codexReply : 'codex-reply')
        if (reply === null) throw new Error(`${providerId} session failed`)
        const viaReplyTool = providerId === 'claude' && opts.claudeRepliesViaTool
        return {
          alias: 'a', path: '/p', providerId, lastUsedAt: 0,
          dispatch: (_text: string): AsyncIterable<AgentEvent> => ({
            async *[Symbol.asyncIterator]() {
              if (viaReplyTool) {
                // Simulate an agent that ignored the no-reply-tool rule: it
                // calls the reply tool (content escapes the beat) and emits
                // only meta-chatter as assistant text.
                yield { kind: 'tool_call', server: 'wechat', tool: 'reply' } as AgentEvent
                yield { kind: 'text', text: '（本轮结束）' } as AgentEvent
              } else {
                yield { kind: 'text', text: reply } as AgentEvent
              }
              yield { kind: 'result', sessionId: '_', numTurns: 1, durationMs: 0 } as AgentEvent
            },
          }),
          close: async () => {},
        }
      })
      const sendAssistantText = vi.fn(async (_chatId: string, text: string) => { sent.push(text) })
      let haikuCallNum = 0
      const haikuEval = vi.fn(async (prompt: string) => {
        const n = haikuCallNum++
        if (typeof opts.haikuResponse === 'function') return opts.haikuResponse(n, prompt)
        return opts.haikuResponse ?? '🎯 verdict'
      })
      const c = createConversationCoordinator({
        resolveProject: () => ({ alias: 'a', path: '/p' }),
        manager: { acquire, release: opts.release },
        conversationStore: store,
        registry,
        defaultProviderId: 'claude',
        format: (m) => m.text,
        sendAssistantText,
        permissionMode: 'strict',
        loadAccess: adminAccess,
        log: () => {},
        haikuEval,
        ...(opts.verdictEval ? { verdictEval: opts.verdictEval } : {}),
        ...(opts.recordTurn ? { recordTurn: opts.recordTurn } : {}),
        ...(opts.turnTimeoutMs !== undefined ? { turnTimeoutMs: opts.turnTimeoutMs } : {}),
      })
      return { c, acquire, sent, sendAssistantText, haikuEval }
    }

    // ── New three-beat tests (Task 3 Step 1) ─────────────────────────────

    it('/chat runs opening → cross-talk → verdict, ending with a 🎯 verdict', async () => {
      // Happy path: both agents reply in beat 1 and beat 2; haikuEval
      // returns a 🎯 verdict in beat 3. Expect ≥4 prefixed messages
      // (2 openings + 2 rebuttals) plus exactly one 🎯 message.
      const { c, sent } = setupChatroom()
      await c.dispatch(inbound('chat-1', '选 A 还是 B?'))
      // Opening (2) + cross-talk (2) = at least 4 prefixed messages.
      expect(sent.filter(s => s.startsWith('[')).length).toBeGreaterThanOrEqual(4)
      // Verdict always emitted.
      expect(sent.some(s => s.startsWith('🎯'))).toBe(true)
    })

    it('/chat verdict uses the STRONG verdictEval (not haikuEval) when provided', async () => {
      // verdictEval (default provider's strong model) handles beat ③; haikuEval
      // stays for the tiny convergence check only. The 🎯 message must be the
      // strong eval's output, and verdictEval must have been called.
      const verdictEval = vi.fn(async (_prompt: string) => '🎯 强模型裁决')
      const { c, sent, haikuEval } = setupChatroom({ verdictEval })
      await c.dispatch(inbound('chat-1', '选 A 还是 B?'))
      expect(verdictEval).toHaveBeenCalledTimes(1)
      expect(sent.some(s => s === '🎯 强模型裁决')).toBe(true)
      // The strong eval's verdict prompt is the verdict structure, not convergence JSON.
      expect(verdictEval.mock.calls[0]![0]).toMatch(/共识|分歧|结论/)
      // haikuEval never produced the 🎯 line (its default '🎯 verdict' must be absent).
      expect(sent.some(s => s === '🎯 verdict')).toBe(false)
      // haikuEval may still run for convergence, but never for the verdict.
      void haikuEval
    })

    it('/chat drops a beat turn that used the reply tool — no meta-leak, not in transcript', async () => {
      // claude calls the reply tool every beat (content escapes via the tool);
      // its only assistantText is meta "（本轮结束）". runBeat must drop it:
      // no "[Claude] …" message, and the verdict transcript must not contain it.
      let verdictPrompt = ''
      const verdictEval = vi.fn(async (p: string) => { verdictPrompt = p; return '🎯 verdict' })
      const { c, sent } = setupChatroom({ claudeRepliesViaTool: true, verdictEval })
      await c.dispatch(inbound('chat-1', '选 A 还是 B?'))
      // No claude-prefixed message leaked (it would carry the meta text).
      expect(sent.some(s => s.startsWith('[Claude]'))).toBe(false)
      expect(sent.some(s => s.includes('本轮结束'))).toBe(false)
      // codex still participates normally.
      expect(sent.some(s => s.startsWith('[Codex]'))).toBe(true)
      // The verdict transcript must not include claude's dropped meta text.
      expect(verdictPrompt).not.toContain('本轮结束')
      // Verdict still emitted.
      expect(sent.some(s => s.startsWith('🎯'))).toBe(true)
    })

    it('/chat verdict is still produced when one agent fails every beat (graceful degrade)', async () => {
      // codex throws on every acquire; only claude's opening makes it through.
      // Cross-talk is skipped (openings.length < 2), but verdict still runs
      // because haikuEval is defined.
      const { c, sent } = setupChatroom({ codexReply: null })
      await c.dispatch(inbound('chat-1', '问题'))
      expect(sent.some(s => s.startsWith('[Claude]'))).toBe(true)
      expect(sent.some(s => s.startsWith('[Codex]'))).toBe(false)
      expect(sent.some(s => s.startsWith('🎯'))).toBe(true)
    })

    it('/chat does NOT crash when the convergence check returns truncated JSON', async () => {
      // The first haikuEval call (convergence after beat 2) returns malformed
      // truncated JSON. parseConvergence must absorb it without throwing.
      // The verdict call (second haikuEval) then runs and emits normally.
      let callNum = 0
      const { c, sent } = setupChatroom({
        haikuResponse: (_n, _p) => {
          callNum++
          if (callNum === 1) return '{"converged": false, "disagreement": "...'  // truncated
          return '🎯 判决：A 更好。'
        },
      })
      await expect(c.dispatch(inbound('chat-1', 'q'))).resolves.toBeUndefined()
      expect(sent.some(s => s.startsWith('🎯'))).toBe(true)
    })

    // ── Auth/timeout resilience (adapted from old moderator tests) ────────

    it('on speaker auth_failed: releases speaker session, sends notice, verdict still runs', async () => {
      // claude emits auth_failed in the opening beat → runBeat releases
      // claude, sends the neutral notice, and returns only codex's opening.
      // Cross-talk is skipped (single opening). haikuEval is called once
      // for the verdict (beat 3 always runs when haikuEval is present).
      const store = makeMockStore()
      store.set('chat-r', { kind: 'chatroom' })
      const registry = createProviderRegistry()
      registry.register('claude', dummyProvider, { displayName: 'Claude', canResume: () => true })
      registry.register('codex', dummyProvider, { displayName: 'Codex', canResume: () => true })
      const release = vi.fn(async () => {})
      const acquire = vi.fn(async ({ providerId }: AcquireRequest) => {
        const events: AgentEvent[] = providerId === 'claude'
          ? [
              { kind: 'error', code: 'auth_failed', message: 'stale claude' },
              { kind: 'result', sessionId: '_', numTurns: 1, durationMs: 0 },
            ]
          : [
              { kind: 'text', text: 'codex reply' },
              { kind: 'result', sessionId: '_', numTurns: 1, durationMs: 0 },
            ]
        return makeHandle(providerId, makeFakeSession({ events }))
      })
      const sendAssistantText = vi.fn(async (_chatId: string, _text: string) => {})
      let haikuCalls = 0
      const haikuEval = vi.fn(async () => { haikuCalls++; return '🎯 verdict' })
      const c = createConversationCoordinator({
        resolveProject: () => ({ alias: 'a', path: '/p' }),
        manager: { acquire, release },
        conversationStore: store,
        registry,
        defaultProviderId: 'claude',
        format: (m) => m.text,
        sendAssistantText,
        permissionMode: 'strict',
        loadAccess: adminAccess,
        log: () => {},
        haikuEval,
      })
      await c.dispatch(inbound('chat-r', '开始讨论'))

      // claude's session released on auth_failed.
      expect(release).toHaveBeenCalledWith({ alias: 'a', providerId: 'claude', chatId: 'chat-r' })
      // haikuEval called once — verdict only (cross-talk skipped: one opening).
      expect(haikuCalls).toBe(1)
      // User got the neutral notice — NOT the raw "Please run /login" text.
      const sent = sendAssistantText.mock.calls.map(call => call[1] as string)
      expect(sent.some(t => /Claude 登录已过期/.test(t) && t.includes('claude login'))).toBe(true)
      expect(sent.some(t => /Please run \/login|Not logged in/.test(t))).toBe(false)
      // No [Claude] prefix (claude produced no text in the opening beat).
      expect(sent.some(t => /^\[Claude\]/.test(t))).toBe(false)
    })

    it('on speaker turn timeout: releases both sessions, sends retry notice, skips verdict', async () => {
      // Both speakers hang in the opening beat → openings.length === 0 →
      // coordinator sends the "two AIs couldn't respond" retry notice and
      // returns early. haikuEval is never called.
      const store = makeMockStore()
      store.set('chat-r', { kind: 'chatroom' })
      const registry = createProviderRegistry()
      registry.register('claude', dummyProvider, { displayName: 'Claude', canResume: () => true })
      registry.register('codex', dummyProvider, { displayName: 'Codex', canResume: () => true })
      const release = vi.fn(async () => {})
      const acquire = vi.fn(async ({ providerId }: AcquireRequest) =>
        makeHandle(providerId, hangingSession([{ kind: 'text', text: 'partial…' }]))
      )
      const sendAssistantText = vi.fn(async (_chatId: string, _text: string) => {})
      const haikuEval = vi.fn(async () => '🎯 verdict')
      const c = createConversationCoordinator({
        resolveProject: () => ({ alias: 'a', path: '/p' }),
        manager: { acquire, release },
        conversationStore: store,
        registry,
        defaultProviderId: 'claude',
        format: (m) => m.text,
        sendAssistantText,
        permissionMode: 'strict',
        loadAccess: adminAccess,
        log: () => {},
        haikuEval,
        turnTimeoutMs: 30,
      })
      await c.dispatch(inbound('chat-r', '开始讨论'))
      // Both sessions released on timeout.
      expect(release).toHaveBeenCalledWith({ alias: 'a', providerId: 'claude', chatId: 'chat-r' })
      expect(release).toHaveBeenCalledWith({ alias: 'a', providerId: 'codex', chatId: 'chat-r' })
      // User sees a retry notice — "重发" is in the per-provider timeout message.
      const sent = sendAssistantText.mock.calls.map(call => call[1] as string)
      expect(sent.some(t => /重发/.test(t))).toBe(true)
      // haikuEval not called (returned early on empty openings).
      expect(haikuEval).not.toHaveBeenCalled()
    }, 3000)

    it('emits a TurnRecord per participant per beat in chatroom mode', async () => {
      // Each runBeat call records one TurnRecord per participant. With both
      // agents responding in opening (beat 1) and cross-talk (beat 2),
      // expect at least 4 records (2 providers × 2 beats), all mode=chatroom.
      const recordTurn = vi.fn()
      const { c } = setupChatroom({ recordTurn })
      await c.dispatch(inbound('chat-1', 'q'))
      expect(recordTurn.mock.calls.length).toBeGreaterThanOrEqual(4)
      for (const [r] of recordTurn.mock.calls) {
        expect(r).toMatchObject({ mode: 'chatroom', outcome: 'completed', chatId: 'chat-1' })
      }
      const providers = recordTurn.mock.calls.map(([r]) => r.provider)
      expect(providers.filter((p: string) => p === 'claude').length).toBeGreaterThanOrEqual(2)
      expect(providers.filter((p: string) => p === 'codex').length).toBeGreaterThanOrEqual(2)
    })

    it('does not duplicate attachment markers when format(msg) already includes them', async () => {
      // In the new flow, format(msg) is called once to produce the question;
      // every opening-beat dispatch receives the same question string, so the
      // image marker appears exactly once per provider dispatch.
      const store = makeMockStore()
      store.set('chat-1', { kind: 'chatroom' })
      const registry = createProviderRegistry()
      registry.register('claude', dummyProvider, { displayName: 'Claude', canResume: () => true })
      registry.register('codex', dummyProvider, { displayName: 'Codex', canResume: () => true })

      const dispatchedTexts: Array<{ providerId: string; text: string }> = []
      const acquire = vi.fn(async ({ providerId }: AcquireRequest) => ({
        alias: 'a', path: '/p', providerId, lastUsedAt: 0,
        dispatch: (text: string): AsyncIterable<AgentEvent> => {
          dispatchedTexts.push({ providerId, text })
          return {
            async *[Symbol.asyncIterator]() {
              yield { kind: 'result', sessionId: '_', numTurns: 1, durationMs: 0 } as AgentEvent
            },
          }
        },
        close: async () => {},
      }))

      const haikuEval = vi.fn(async () => '🎯 verdict')
      const c = createConversationCoordinator({
        resolveProject: () => ({ alias: 'a', path: '/p' }),
        manager: { acquire },
        conversationStore: store,
        registry,
        defaultProviderId: 'claude',
        format: formatInbound,
        sendAssistantText: vi.fn(),
        permissionMode: 'strict',
        loadAccess: adminAccess,
        log: () => {},
        haikuEval,
      })

      await c.dispatch({
        chatId: 'chat-1', userId: 'u1', text: '这是什么',
        msgType: 'image', createTimeMs: 1, accountId: 'a',
        attachments: [{ kind: 'image', path: '/inbox/a/x.jpg' }],
      })

      // Image marker appears exactly once in each opening-beat dispatch.
      const occurrences = (dispatchedTexts[0]?.text.match(/\[image:\/inbox\/a\/x\.jpg\]/g) ?? []).length
      expect(occurrences).toBe(1)
    })

    // ── cancel / preemption ───────────────────────────────────────────────

    it('cancel(chatId) returns true while in-flight; subsequent dispatch preempts cleanly', async () => {
      // cancel() signals the aborter (returns true). The aborter is registered
      // synchronously before the first await. After the dispatch completes
      // (or aborts at a beat boundary) the aborter slot is cleared (returns false).
      const { c } = setupChatroom()
      expect(c.cancel('chat-1')).toBe(false)
      const p = c.dispatch(inbound('chat-1', 'first'))
      // aborter is set synchronously inside dispatchChatroom before its first await
      expect(c.cancel('chat-1')).toBe(true)
      await p
      expect(c.cancel('chat-1')).toBe(false)
    })

    it('cancel before beat ② causes subsequent beats to be skipped', async () => {
      // cancel() sets abort signal before beat ① completes. Once beat ① finishes,
      // the first beat-boundary abort check fires and returns early — beats ②,
      // ②b, and ③ must NOT run. haikuEval (used only in ②b and ③) must not be called.
      const { c, haikuEval } = setupChatroom()
      const p = c.dispatch(inbound('chat-1', 'debate'))
      // aborter is registered synchronously before the first await (beat ①)
      expect(c.cancel('chat-1')).toBe(true)
      await p
      // haikuEval is only invoked in beats ②b (convergence) and ③ (verdict).
      // If neither ran, abort-at-boundary is working correctly.
      expect(haikuEval).not.toHaveBeenCalled()
    })

    it('falls back to solo+default when chatroom resolves to a single participant', async () => {
      // P3 N-way: when the registry has only 1 provider, resolveParticipants
      // returns a 1-element list and dispatch degrades to solo (using that
      // one provider directly). Replaces the pre-P3 "missing provider" hard
      // fallback path.
      const store = makeMockStore()
      store.set('chat-1', { kind: 'chatroom' })
      // Only claude registered
      const registry = createProviderRegistry()
      registry.register('claude', dummyProvider, { displayName: 'Claude', canResume: () => true })
      const session = makeFakeSession({
        events: [
          { kind: 'tool_call', server: 'wechat', tool: 'reply' },
          { kind: 'result', sessionId: '_', numTurns: 1, durationMs: 0 },
        ],
      })
      const acquire = vi.fn(async (_req: AcquireRequest) =>
        makeHandle('claude', session)
      )
      const log = vi.fn()
      const c = createConversationCoordinator({
        resolveProject: () => ({ alias: 'a', path: '/p' }),
        manager: { acquire },
        conversationStore: store,
        registry,
        defaultProviderId: 'claude',
        format: () => 'x',
        permissionMode: 'strict',
        loadAccess: adminAccess,
        log,
      })
      await c.dispatch(inbound('chat-1', 'hi'))
      // Solo dispatch — single acquire, claude.
      expect(acquire).toHaveBeenCalledTimes(1)
      expect(acquire.mock.calls[0]?.[0]?.providerId).toBe('claude')
      expect(log).toHaveBeenCalledWith('COORDINATOR', expect.stringContaining('degrading to solo'))
    })

    it('all speakers failing sends retry notice (opening beat returns empty)', async () => {
      // When every acquire() throws in beat 1, openings.length === 0 and
      // the coordinator sends "⚠️ 这轮没有 AI 成功回应，请稍后重发一次。"
      // instead of silently returning. haikuEval is not called.
      const store = makeMockStore()
      store.set('chat-1', { kind: 'chatroom' })
      const registry = createProviderRegistry()
      registry.register('claude', dummyProvider, { displayName: 'Claude', canResume: () => true })
      registry.register('codex', dummyProvider, { displayName: 'Codex', canResume: () => true })
      const acquire = vi.fn(async () => { throw new Error('session crashed') })
      const sendAssistantText = vi.fn(async (_chatId: string, _text: string) => {})
      const haikuEval = vi.fn(async () => '🎯 verdict')
      const c = createConversationCoordinator({
        resolveProject: () => ({ alias: 'a', path: '/p' }),
        manager: { acquire },
        conversationStore: store,
        registry,
        defaultProviderId: 'claude',
        format: () => 'x',
        sendAssistantText,
        permissionMode: 'strict',
        loadAccess: adminAccess,
        log: () => {},
        haikuEval,
      })
      await c.dispatch(inbound('chat-1', 'hi'))
      expect(sendAssistantText).toHaveBeenCalledWith('chat-1', expect.stringContaining('这轮没有 AI 成功回应'))
      expect(haikuEval).not.toHaveBeenCalled()
    })

    // ── Preemption / rapid-dispatch tests (adapted for three-beat flow) ───

    it('rapid follow-up message preempts prior dispatch and both resolve cleanly', async () => {
      // Gate A on its first haikuEval call (the convergence check after
      // beat 2). B arrives while A is gated, preempts A (logs "preempting
      // prior in-flight dispatch"), and awaits A's promise. On gate release
      // A finishes, then B runs its own three-beat loop. Both resolve.
      const store = makeMockStore()
      store.set('chat-1', { kind: 'chatroom' })
      const registry = createProviderRegistry()
      registry.register('claude', dummyProvider, { displayName: 'Claude', canResume: () => true })
      registry.register('codex', dummyProvider, { displayName: 'Codex', canResume: () => true })

      const acquire = vi.fn(async ({ providerId }: AcquireRequest) => ({
        alias: 'a', path: '/p', providerId, lastUsedAt: 0,
        dispatch: (_text: string): AsyncIterable<AgentEvent> => ({
          async *[Symbol.asyncIterator]() {
            yield { kind: 'text', text: `${providerId}-reply` } as AgentEvent
            yield { kind: 'result', sessionId: '_', numTurns: 1, durationMs: 0 } as AgentEvent
          },
        }),
        close: async () => {},
      }))

      let resolveGate: () => void = () => {}
      const gate = new Promise<void>(res => { resolveGate = res })
      let haikuCallCount = 0
      const haikuEval = vi.fn(async () => {
        if (++haikuCallCount === 1) await gate  // pause A at first convergence call
        return '🎯 verdict'
      })

      const logs: string[] = []
      const c = createConversationCoordinator({
        resolveProject: () => ({ alias: 'a', path: '/p' }),
        manager: { acquire },
        conversationStore: store,
        registry,
        defaultProviderId: 'claude',
        format: (m) => m.text,
        sendAssistantText: async () => {},
        permissionMode: 'strict',
        loadAccess: adminAccess,
        log: (_tag, line) => { if (typeof line === 'string') logs.push(line) },
        haikuEval,
      })

      const pA = c.dispatch(inbound('chat-1', 'Q-from-A'))
      await new Promise(r => setImmediate(r))  // let A reach the haikuEval gate

      const pB = c.dispatch(inbound('chat-1', 'Q-from-B'))  // B preempts A
      resolveGate()   // release A so it can finish; B then runs
      await Promise.all([pA, pB])

      // B preempted A (logged it).
      const preemptLogs = logs.filter(l => l.includes('preempting prior in-flight dispatch'))
      expect(preemptLogs.length).toBeGreaterThanOrEqual(1)
      // Both A and B ran haikuEval (A's convergence+verdict, B's convergence+verdict).
      expect(haikuCallCount).toBeGreaterThanOrEqual(2)
    })

    it('three-or-more rapid dispatches resolve cleanly, preempt chain fires ≥2 times', async () => {
      // Safety invariant: A, B, C all arrive rapidly → B preempts A,
      // C preempts A initially (B hasn't set its aborter yet), then C
      // preempts B after B claims the slot. The while-loop re-read ensures
      // the chain doesn't lose a wave. All three resolve without deadlock.
      const store = makeMockStore()
      store.set('chat-1', { kind: 'chatroom' })
      const registry = createProviderRegistry()
      registry.register('claude', dummyProvider, { displayName: 'Claude', canResume: () => true })
      registry.register('codex', dummyProvider, { displayName: 'Codex', canResume: () => true })

      const acquire = vi.fn(async ({ providerId }: AcquireRequest) => ({
        alias: 'a', path: '/p', providerId, lastUsedAt: 0,
        dispatch: (_text: string): AsyncIterable<AgentEvent> => ({
          async *[Symbol.asyncIterator]() {
            yield { kind: 'text', text: `${providerId}-reply` } as AgentEvent
            yield { kind: 'result', sessionId: '_', numTurns: 1, durationMs: 0 } as AgentEvent
          },
        }),
        close: async () => {},
      }))

      let resolveGate: () => void = () => {}
      const gate = new Promise<void>(res => { resolveGate = res })
      let haikuCallCount = 0
      const haikuEval = vi.fn(async () => {
        if (++haikuCallCount === 1) await gate  // pause A's convergence check
        return '🎯 verdict'
      })

      const logs: string[] = []
      const c = createConversationCoordinator({
        resolveProject: () => ({ alias: 'a', path: '/p' }),
        manager: { acquire },
        conversationStore: store,
        registry,
        defaultProviderId: 'claude',
        format: (m) => m.text,
        sendAssistantText: async () => {},
        permissionMode: 'strict',
        loadAccess: adminAccess,
        log: (_tag, line) => { if (typeof line === 'string') logs.push(line) },
        haikuEval,
      })

      // Three rapid dispatches; A paused at gate while B and C arrive.
      const pA = c.dispatch(inbound('chat-1', 'Q-A'))
      await new Promise(r => setImmediate(r))  // let A reach the gate
      const pB = c.dispatch(inbound('chat-1', 'Q-B'))  // B preempts A synchronously
      const pC = c.dispatch(inbound('chat-1', 'Q-C'))  // C also preempts A synchronously

      resolveGate()  // A finishes → B claims slot → C preempts B → C runs
      await Promise.all([pA, pB, pC])

      // The preempt chain fired at least twice (B preempts A, C preempts B).
      const preemptLogs = logs.filter(l => l.includes('preempting prior in-flight dispatch'))
      expect(preemptLogs.length).toBeGreaterThanOrEqual(2)
    })

    it('verdict/convergence prompts for dispatch 2 do not contain a prior failed question', async () => {
      // When dispatch 1 has one acquire throw (only one provider responds),
      // dispatch 2 (a clean follow-up) must see only its own question in
      // convergence/verdict prompts — the prompts are built from the current
      // runBeat outputs and question only, never from persisted cross-dispatch history.
      const store = makeMockStore()
      store.set('chat-1', { kind: 'chatroom' })
      const registry = createProviderRegistry()
      registry.register('claude', dummyProvider, { displayName: 'Claude', canResume: () => true })
      registry.register('codex', dummyProvider, { displayName: 'Codex', canResume: () => true })

      let failOnce = true
      const acquire = vi.fn(async ({ providerId }: AcquireRequest) => {
        if (failOnce) {
          failOnce = false
          throw new Error('simulated speaker session crash')
        }
        return {
          alias: 'a', path: '/p', providerId, lastUsedAt: 0,
          dispatch: (_text: string): AsyncIterable<AgentEvent> => ({
            async *[Symbol.asyncIterator]() {
              yield { kind: 'text', text: `${providerId}-reply` } as AgentEvent
              yield { kind: 'result', sessionId: '_', numTurns: 1, durationMs: 0 } as AgentEvent
            },
          }),
          close: async () => {},
        }
      })

      const promptsSeen: string[] = []
      const haikuEval = vi.fn(async (prompt: string) => {
        promptsSeen.push(prompt)
        return '🎯 verdict'
      })

      const c = createConversationCoordinator({
        resolveProject: () => ({ alias: 'a', path: '/p' }),
        manager: { acquire },
        conversationStore: store,
        registry,
        defaultProviderId: 'claude',
        format: (m) => m.text,
        sendAssistantText: async () => {},
        permissionMode: 'strict',
        loadAccess: adminAccess,
        log: () => {},
        haikuEval,
      })

      // Dispatch 1 — one acquire throws, only one provider responds.
      await c.dispatch(inbound('chat-1', 'Q-failed'))

      // Dispatch 2 — clean follow-up. The verdict/convergence prompts must
      // contain 'Q-followup' and NOT the failed prior question.
      promptsSeen.length = 0
      await c.dispatch(inbound('chat-1', 'Q-followup'))

      expect(promptsSeen[0]).toBeDefined()
      expect(promptsSeen[0]!).toContain('Q-followup')
      expect(promptsSeen[0]!).not.toContain('Q-failed')
    })

    it('cancel(chatId) returns false when no in-flight loop', async () => {
      const { c } = setupChatroom()
      expect(c.cancel('chat-1')).toBe(false)
      await c.dispatch(inbound('chat-1', 'hi'))
      expect(c.cancel('chat-1')).toBe(false)
    })

    it('setMode rejects chatroom when explicit participants include an unregistered provider', () => {
      // P3 N-way: validateMode only rejects when participants are explicitly
      // stated AND include an unknown id. Undefined participants defers to
      // dispatch-time resolution.
      const store = makeMockStore()
      const registry = createProviderRegistry()
      registry.register('claude', dummyProvider, { displayName: 'Claude', canResume: () => true })
      const c = createConversationCoordinator({
        resolveProject: () => null,
        manager: { acquire: vi.fn() },
        conversationStore: store,
        registry,
        defaultProviderId: 'claude',
        format: () => 'x',
        permissionMode: 'strict',
        loadAccess: adminAccess,
        log: () => {},
      })
      expect(() => c.setMode('chat-1', { kind: 'chatroom', participants: ['claude', 'codex'] }))
        .toThrow(/unknown providers.*codex/)
    })
  })

  describe('N-way participants (P3)', () => {
    /** Reusable per-test setup for N-way parallel dispatch tracking. */
    function setupNway(registered: ProviderId[]) {
      const store = makeMockStore()
      const registry = createProviderRegistry()
      for (const id of registered) {
        registry.register(id, dummyProvider, { displayName: id, canResume: () => true })
      }
      const acquiredProviders: ProviderId[] = []
      const acquire = vi.fn(async (req: AcquireRequest) => {
        acquiredProviders.push(req.providerId)
        const session = makeFakeSession({
          events: [
            { kind: 'tool_call', server: 'wechat', tool: 'reply' },
            { kind: 'result', sessionId: '_', numTurns: 1, durationMs: 0 },
          ],
        })
        return makeHandle(req.providerId, session)
      })
      const log = vi.fn()
      const c = createConversationCoordinator({
        resolveProject: () => ({ alias: 'a', path: '/p' }),
        manager: { acquire },
        conversationStore: store,
        registry,
        defaultProviderId: 'claude',
        format: (m) => m.text,
        sendAssistantText: vi.fn(async () => {}),
        permissionMode: 'strict',
        loadAccess: adminAccess,
        log,
      })
      return { c, store, acquire, acquiredProviders, log }
    }

    it('explicit participants on parallel mode are passed verbatim (skips unlisted providers)', async () => {
      const { c, store, acquiredProviders } = setupNway(['claude', 'codex', 'cursor'])
      store.set('chat-1', { kind: 'parallel', participants: ['claude', 'cursor'] })
      await c.dispatch(inbound('chat-1', 'hi'))
      expect(acquiredProviders.sort()).toEqual(['claude', 'cursor'])
    })

    it('parallel mode with explicit full-registry participants fans out to all 3', async () => {
      // Verifies that with 3+ registered providers and explicit
      // participants matching the full registry, all 3 are acquired.
      // (Per the legacy-backfill test below, undefined participants on a
      // persisted parallel row backfills to first-2 — so the only way to
      // exercise N=3 dispatch is via explicit participants.)
      const { c, store, acquiredProviders } = setupNway(['claude', 'codex', 'cursor'])
      store.set('chat-1', { kind: 'parallel', participants: ['claude', 'codex', 'cursor'] })
      await c.dispatch(inbound('chat-1', 'hi'))
      expect(acquiredProviders.sort()).toEqual(['claude', 'codex', 'cursor'])
    })

    it('legacy parallel row (participants undefined) backfills to first-two-registered and persists', async () => {
      const { c, store, acquiredProviders } = setupNway(['claude', 'codex', 'cursor'])
      // Simulate a pre-v11 row: parallel mode with no participants property.
      store.set('chat-1', { kind: 'parallel' })
      // First dispatch: backfills to first 2 (claude+codex).
      await c.dispatch(inbound('chat-1', 'hi'))
      expect(acquiredProviders.sort()).toEqual(['claude', 'codex'])
      expect(store.setParticipants).toHaveBeenCalledWith('chat-1', ['claude', 'codex'])
      // Second dispatch: now persisted with explicit participants. setParticipants NOT called again.
      const callsAfterFirst = (store.setParticipants as ReturnType<typeof vi.fn>).mock.calls.length
      acquiredProviders.length = 0
      await c.dispatch(inbound('chat-1', 'hi again'))
      expect(acquiredProviders.sort()).toEqual(['claude', 'codex'])
      expect((store.setParticipants as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsAfterFirst)
    })

    it('>3 participants is capped at 3 with a log line', async () => {
      const { c, store, acquiredProviders, log } = setupNway(['claude', 'codex', 'cursor', 'extra'])
      store.set('chat-1', { kind: 'parallel', participants: ['claude', 'codex', 'cursor', 'extra'] })
      await c.dispatch(inbound('chat-1', 'hi'))
      // First 3 only.
      expect(acquiredProviders.sort()).toEqual(['claude', 'codex', 'cursor'])
      const sawCap = log.mock.calls.some(([, line]) => typeof line === 'string' && line.includes('capping'))
      expect(sawCap).toBe(true)
    })

    it('participants filter silently drops unregistered providers with a log line', async () => {
      const { c, store, acquiredProviders, log } = setupNway(['claude', 'codex'])
      store.set('chat-1', { kind: 'parallel', participants: ['claude', 'codex', 'cursor'] })
      await c.dispatch(inbound('chat-1', 'hi'))
      expect(acquiredProviders.sort()).toEqual(['claude', 'codex'])
      const sawFilter = log.mock.calls.some(([, line]) => typeof line === 'string' && line.includes('filtered'))
      expect(sawFilter).toBe(true)
    })

    it('participants resolving to 0 degrades to solo+default', async () => {
      const { c, store, acquiredProviders } = setupNway(['claude'])
      store.set('chat-1', { kind: 'parallel', participants: ['codex', 'cursor'] })
      // validateMode would reject this — bypass by writing directly via store.
      // (Operator scenario: registry shrank after persist.)
      await c.dispatch(inbound('chat-1', 'hi'))
      // Degrades to solo+default (claude).
      expect(acquiredProviders).toEqual(['claude'])
    })

    it('participants resolving to 1 degrades to solo with that 1', async () => {
      const { c, store, acquiredProviders } = setupNway(['claude', 'codex', 'cursor'])
      store.set('chat-1', { kind: 'parallel', participants: ['cursor'] })
      await c.dispatch(inbound('chat-1', 'hi'))
      expect(acquiredProviders).toEqual(['cursor'])
    })

    it('chatroom: 3 explicit participants dispatched without 2-tuple throw', async () => {
      const store = makeMockStore()
      const registry = createProviderRegistry()
      for (const id of ['claude', 'codex', 'cursor']) {
        registry.register(id, dummyProvider, { displayName: id, canResume: () => true })
      }
      store.set('chat-1', { kind: 'chatroom', participants: ['claude', 'codex', 'cursor'] })
      const acquired: ProviderId[] = []
      const acquire = vi.fn(async (req: AcquireRequest) => {
        acquired.push(req.providerId)
        return makeHandle(req.providerId, makeFakeSession({
          events: [
            { kind: 'text', text: `I am ${req.providerId}` },
            { kind: 'result', sessionId: '_', numTurns: 1, durationMs: 0 },
          ],
        }))
      })
      // Scripted moderator: round 1 → cursor, round 2 → end.
      let round = 0
      const haikuEval = vi.fn(async () => {
        round++
        if (round === 1) return JSON.stringify({ action: 'continue', speaker: 'cursor', prompt: 'go', reasoning: 'r1' })
        return JSON.stringify({ action: 'end', reasoning: 'done' })
      })
      const c = createConversationCoordinator({
        resolveProject: () => ({ alias: 'a', path: '/p' }),
        manager: { acquire },
        conversationStore: store,
        registry,
        defaultProviderId: 'claude',
        format: (m) => m.text,
        sendAssistantText: vi.fn(async () => {}),
        permissionMode: 'strict',
        loadAccess: adminAccess,
        haikuEval,
        log: () => {},
      })
      // Should not throw despite 3 participants (pre-P3 would throw 2-tuple).
      await expect(c.dispatch(inbound('chat-1', 'hi'))).resolves.toBeUndefined()
      // Cursor was the picked speaker.
      expect(acquired).toContain('cursor')
    })

    it('chatroom: legacy row (no participants) backfills to first-two and persists', async () => {
      const store = makeMockStore()
      const registry = createProviderRegistry()
      for (const id of ['claude', 'codex']) {
        registry.register(id, dummyProvider, { displayName: id, canResume: () => true })
      }
      store.set('chat-1', { kind: 'chatroom' })
      const acquire = vi.fn(async (req: AcquireRequest) =>
        makeHandle(req.providerId, makeFakeSession({
          events: [{ kind: 'text', text: 'x' }, { kind: 'result', sessionId: '_', numTurns: 1, durationMs: 0 }],
        })))
      const haikuEval = vi.fn(async () => JSON.stringify({ action: 'end', reasoning: 'short' }))
      const c = createConversationCoordinator({
        resolveProject: () => ({ alias: 'a', path: '/p' }),
        manager: { acquire },
        conversationStore: store,
        registry,
        defaultProviderId: 'claude',
        format: (m) => m.text,
        sendAssistantText: vi.fn(async () => {}),
        permissionMode: 'strict',
        loadAccess: adminAccess,
        haikuEval,
        log: () => {},
      })
      await c.dispatch(inbound('chat-1', 'hi'))
      expect(store.setParticipants).toHaveBeenCalledWith('chat-1', ['claude', 'codex'])
    })
  })

  describe('validateMode — N-way participants', () => {
    function setupValidate(registered: ProviderId[]) {
      const store = makeMockStore()
      const registry = createProviderRegistry()
      for (const id of registered) {
        registry.register(id, dummyProvider, { displayName: id, canResume: () => true })
      }
      const c = createConversationCoordinator({
        resolveProject: () => null,
        manager: { acquire: vi.fn() },
        conversationStore: store,
        registry,
        defaultProviderId: 'claude',
        format: () => 'x',
        permissionMode: 'strict',
        loadAccess: adminAccess,
        log: () => {},
      })
      return c
    }

    it('setMode(parallel) with explicit unknown provider throws naming the bad provider', () => {
      const c = setupValidate(['claude', 'codex'])
      expect(() => c.setMode('chat-1', { kind: 'parallel', participants: ['claude', 'unknown'] }))
        .toThrow(/unknown.*unknown/i)
    })

    it('setMode(parallel) with all participants registered succeeds', () => {
      const c = setupValidate(['claude', 'codex', 'cursor'])
      expect(() => c.setMode('chat-1', { kind: 'parallel', participants: ['claude', 'cursor'] })).not.toThrow()
    })

    it('setMode(parallel) with undefined participants succeeds (deferred to dispatch)', () => {
      const c = setupValidate(['claude', 'codex', 'cursor'])
      expect(() => c.setMode('chat-1', { kind: 'parallel' })).not.toThrow()
    })

    it('setMode(chatroom) with participants.length < 2 throws', () => {
      const c = setupValidate(['claude', 'codex', 'cursor'])
      expect(() => c.setMode('chat-1', { kind: 'chatroom', participants: ['claude'] }))
        .toThrow(/≥2|at least 2/)
    })
  })

  describe('integration — 3-way chatroom over 4 rounds', () => {
    it('moderator picks all 3 participants across the rounds; sendAssistantText prefixes each speaker', async () => {
      const store = makeMockStore()
      const registry = createProviderRegistry()
      for (const id of ['claude', 'codex', 'cursor']) {
        registry.register(id, dummyProvider, { displayName: id[0]!.toUpperCase() + id.slice(1), canResume: () => true })
      }
      store.set('chat-1', { kind: 'chatroom', participants: ['claude', 'codex', 'cursor'] })
      const acquired: ProviderId[] = []
      const acquire = vi.fn(async (req: AcquireRequest) => {
        acquired.push(req.providerId)
        return makeHandle(req.providerId, makeFakeSession({
          events: [
            { kind: 'text', text: `${req.providerId} weighs in` },
            { kind: 'result', sessionId: '_', numTurns: 1, durationMs: 0 },
          ],
        }))
      })
      // Scripted moderator: round 1=claude, 2=codex, 3=cursor, 4=end.
      const pickOrder: ProviderId[] = ['claude', 'codex', 'cursor']
      let i = 0
      const haikuEval = vi.fn(async () => {
        if (i < pickOrder.length) {
          const speaker = pickOrder[i]!
          i++
          return JSON.stringify({ action: 'continue', speaker, prompt: `as ${speaker}`, reasoning: `r${i}` })
        }
        return JSON.stringify({ action: 'end', reasoning: 'done' })
      })
      const sendAssistantText = vi.fn(async (_chatId: string, _text: string) => {})
      const c = createConversationCoordinator({
        resolveProject: () => ({ alias: 'a', path: '/p' }),
        manager: { acquire },
        conversationStore: store,
        registry,
        defaultProviderId: 'claude',
        format: (m) => m.text,
        sendAssistantText,
        permissionMode: 'strict',
        loadAccess: adminAccess,
        haikuEval,
        log: () => {},
      })
      await c.dispatch(inbound('chat-1', 'what do you all think?'))
      // All 3 speakers were acquired at least once.
      expect(new Set(acquired)).toEqual(new Set(['claude', 'codex', 'cursor']))
      // sendAssistantText carried the prefixed text from each speaker.
      const sentTexts = sendAssistantText.mock.calls.map((c) => c[1])
      expect(sentTexts.some((t) => t.includes('[Claude]'))).toBe(true)
      expect(sentTexts.some((t) => t.includes('[Codex]'))).toBe(true)
      expect(sentTexts.some((t) => t.includes('[Cursor]'))).toBe(true)
    })
  })
})
