import { describe, expect, it, vi } from 'vitest'
import { createConversationCoordinator } from './conversation-coordinator'
import { createProviderRegistry } from './provider-registry'
import * as capabilityMatrix from './capability-matrix'
import { makeFakeSession } from './test-helpers'
import type { AgentEvent, AgentProvider } from './agent-provider'
import type { Mode } from './conversation'
import { formatInbound, type InboundMsg } from './prompt-format'

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
    _peek: () => data,
  }
}

function inbound(chatId: string, text: string): InboundMsg {
  return {
    chatId, userId: chatId, text, msgType: 'text',
    createTimeMs: Date.now(), accountId: 'acct-1',
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
    const acquire = vi.fn(async (_alias: string, _path: string, _provider: string) =>
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
      log: () => {},
    })
    await c.dispatch(inbound('chat-1', 'hi codex'))
    expect(acquire).toHaveBeenCalledWith('a', '/p', 'codex')
    expect(dispatched).toContain('[fmt]hi codex')
  })

  it('dispatch falls back to default provider when persisted mode references unknown provider', async () => {
    const store = makeMockStore()
    store.set('chat-1', { kind: 'solo', provider: 'gemini' })  // not registered
    const session = makeFakeSession({
      events: [{ kind: 'result', sessionId: '_', numTurns: 1, durationMs: 0 }],
    })
    const acquire = vi.fn(async (_alias: string, _path: string, _providerId: string) =>
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
      log,
    })
    await c.dispatch(inbound('chat-1', 'hi'))
    expect(acquire).toHaveBeenCalledWith('a', '/p', 'claude')
    expect(log).toHaveBeenCalledWith('COORDINATOR', expect.stringContaining("provider 'gemini' not registered"))
  })

  it('skips fallback sendAssistantText when reply tool was called', async () => {
    const session = makeFakeSession({
      events: [
        { kind: 'tool_call', server: 'wechat', tool: 'reply' },
        { kind: 'result', sessionId: '_', numTurns: 1, durationMs: 0 },
      ],
    })
    const acquire = vi.fn(async (_alias: string, _path: string, _providerId: string) =>
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
    const acquire = vi.fn(async (_alias: string, _path: string, _providerId: string) =>
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
    const acquire = vi.fn(async (_alias: string, _path: string, _providerId: string) =>
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
    const acquire = vi.fn(async (_alias: string, _path: string, providerId: string) =>
      makeHandle(providerId, session)
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
      log: () => {},
    })
    await c.dispatch(inbound('chat-1', 'hi'))
    expect(release).toHaveBeenCalledTimes(1)
    expect(release).toHaveBeenCalledWith('a', 'claude')
  })

  it('on auth_failed: throttles repeated notices for the same chat', async () => {
    const session = makeFakeSession({
      events: [
        { kind: 'error', code: 'auth_failed', message: 'x' },
        { kind: 'result', sessionId: '_', numTurns: 1, durationMs: 0 },
      ],
    })
    const acquire = vi.fn(async (_alias: string, _path: string, _providerId: string) =>
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
    const acquire = vi.fn(async (_alias: string, _path: string, _providerId: string) =>
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
      const acquire = vi.fn(async (_alias: string, _path: string, providerId: string) =>
        makeHandle(providerId, session)
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
        log,
      })
      return { c, acquire, dispatched, log, store }
    }

    it('dispatches solo to the primary provider (peer reachable via delegate-mcp tool, not parallel session)', async () => {
      const { c, acquire, dispatched } = setupPrimaryTool({ initialMode: { kind: 'primary_tool', primary: 'claude' } })
      await c.dispatch(inbound('chat-1', 'hi'))
      expect(acquire).toHaveBeenCalledTimes(1)
      expect(acquire.mock.calls[0]?.[2]).toBe('claude')
      expect(dispatched).toHaveLength(1)
    })

    it('reverse — primary_tool with codex primary dispatches to codex', async () => {
      const { c, acquire } = setupPrimaryTool({ initialMode: { kind: 'primary_tool', primary: 'codex' } })
      await c.dispatch(inbound('chat-1', 'hi'))
      expect(acquire.mock.calls[0]?.[2]).toBe('codex')
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
      const acquire = vi.fn(async (_alias: string, _path: string, _providerId: string) =>
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
        log,
      })
      await c.dispatch(inbound('chat-1', 'hi'))
      expect(acquire.mock.calls[0]?.[2]).toBe('claude')
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

      const acquire = vi.fn(async (alias: string, path: string, providerId: string) => {
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
        log: () => {},
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
      const acquire = vi.fn(async (_alias: string, _path: string, providerId: string) => {
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
        log: () => {},
      })
      await c.dispatch(inbound('chat-p', 'hi'))

      // Failing provider was released; healthy one was not.
      expect(release).toHaveBeenCalledWith('a', 'claude')
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

    it('fans out the same inbound to both providers concurrently', async () => {
      const { c, acquire, dispatchCalls } = setupParallel()
      await c.dispatch(inbound('chat-1', 'hello both'))
      // acquire called twice — once per provider
      expect(acquire).toHaveBeenCalledTimes(2)
      expect(acquire.mock.calls.map(([, , p]) => p).sort()).toEqual(['claude', 'codex'])
      // dispatch called twice with same text
      expect(dispatchCalls).toHaveLength(2)
      expect(dispatchCalls[0]?.text).toBe('hello both')
      expect(dispatchCalls[1]?.text).toBe('hello both')
    })

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

    it('falls back to solo+default when one of the parallel providers is not registered', async () => {
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
      const acquire = vi.fn(async (_alias: string, _path: string, _providerId: string) =>
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
        log,
      })
      await c.dispatch(inbound('chat-1', 'hi'))
      // Acquired ONCE under solo+default, not twice
      expect(acquire).toHaveBeenCalledTimes(1)
      expect(acquire.mock.calls[0]?.[2]).toBe('claude')
      expect(log).toHaveBeenCalledWith('COORDINATOR', expect.stringContaining('parallel mode missing providers'))
    })

    it('setMode rejects parallel when a parallel provider is missing from registry', () => {
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
        log: () => {},
      })
      expect(() => c.setMode('chat-1', { kind: 'parallel' }))
        .toThrow(/missing: codex/)
    })

    it('honours custom parallelProviders list (e.g. for tests with non-default ids)', async () => {
      const store = makeMockStore()
      store.set('chat-1', { kind: 'parallel' })
      const registry = createProviderRegistry()
      registry.register('alice', dummyProvider, { displayName: 'Alice', canResume: () => true })
      registry.register('bob', dummyProvider, { displayName: 'Bob', canResume: () => true })
      const sendAssistantText = vi.fn(async (_chatId: string, _text: string) => {})
      const acquire = vi.fn(async (alias: string, path: string, providerId: string) => {
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
        log: () => {},
      })
      await c.dispatch(inbound('chat-1', 'hi'))
      const sent = sendAssistantText.mock.calls.map(([, t]) => t).sort()
      expect(sent).toEqual(['[Alice] hi from alice', '[Bob] hi from bob'])
    })
  })

  // ─── chatroom mode (RFC 03 P5) ───────────────────────────────────────

  describe('chatroom mode (P5, v0.5.8 moderator-driven)', () => {
    // Moderator decisions are scripted per round. setupChatroom takes a
    // sequence of decisions to return on consecutive haikuEval calls.
    function setupChatroom(opts: {
      moderatorDecisions: Array<{
        action: 'continue' | 'end'
        speaker?: 'claude' | 'codex'
        prompt?: string
        reasoning?: string
      }>
      // Per-provider replies queue (FIFO) — each entry maps to AgentEvents.
      replies: Record<string, Array<{ assistantText: string[]; replyToolCalled?: boolean }>>
      maxRounds?: number
    }) {
      const store = makeMockStore()
      store.set('chat-1', { kind: 'chatroom' })
      const registry = createProviderRegistry()
      registry.register('claude', dummyProvider, { displayName: 'Claude', canResume: () => true })
      registry.register('codex', dummyProvider, { displayName: 'Codex', canResume: () => true })
      const dispatchedTexts: Array<{ providerId: string; text: string }> = []
      const counters: Record<string, number> = {}
      const acquire = vi.fn(async (_alias: string, _path: string, providerId: string) => {
        const list = opts.replies[providerId] ?? []
        return {
          alias: 'a', path: '/p', providerId, lastUsedAt: 0,
          dispatch: (text: string): AsyncIterable<AgentEvent> => {
            dispatchedTexts.push({ providerId, text })
            const i = counters[providerId] ?? 0
            counters[providerId] = i + 1
            const r = list[i] ?? { assistantText: [], replyToolCalled: false }
            const events: AgentEvent[] = []
            for (const t of r.assistantText) events.push({ kind: 'text', text: t })
            if (r.replyToolCalled) events.push({ kind: 'tool_call', server: 'wechat', tool: 'reply' })
            events.push({ kind: 'result', sessionId: '_', numTurns: 1, durationMs: 0 })
            return {
              async *[Symbol.asyncIterator]() { for (const ev of events) yield ev },
            }
          },
          close: async () => {},
        }
      })
      const sendAssistantText = vi.fn(async (_chatId: string, _text: string) => {})
      const log = vi.fn()
      let modCallCount = 0
      const haikuEval = vi.fn(async (_prompt: string) => {
        const decision = opts.moderatorDecisions[modCallCount++] ?? { action: 'end', reasoning: 'test exhausted' }
        return JSON.stringify(decision)
      })
      const c = createConversationCoordinator({
        resolveProject: () => ({ alias: 'a', path: '/p' }),
        manager: { acquire },
        conversationStore: store,
        registry,
        defaultProviderId: 'claude',
        format: (m) => `<wechat>${m.text}</wechat>`,
        sendAssistantText,
        permissionMode: 'strict',
        log,
        haikuEval,
        ...(opts.maxRounds !== undefined ? { chatroomMaxRounds: opts.maxRounds } : {}),
      })
      return { c, acquire, dispatchedTexts, sendAssistantText, log, haikuEval }
    }

    it('round 1 dispatches the moderator-picked speaker with the moderator-supplied prompt', async () => {
      const { c, dispatchedTexts, sendAssistantText } = setupChatroom({
        moderatorDecisions: [
          { action: 'continue', speaker: 'claude', prompt: '先给初步看法 + 指出 codex 应反驳的点', reasoning: '开场' },
          { action: 'end', reasoning: 'done' },
        ],
        replies: { claude: [{ assistantText: ['claude 的回答'] }] },
      })
      await c.dispatch(inbound('chat-1', 'AI 会毁灭人类吗'))
      expect(dispatchedTexts).toHaveLength(1)
      expect(dispatchedTexts[0]?.providerId).toBe('claude')
      // Moderator's prompt is what claude sees — not the raw user msg.
      // Coordinator appends a "no reply tool" coda when moderator forgets.
      expect(dispatchedTexts[0]?.text).toContain('先给初步看法 + 指出 codex 应反驳的点')
      expect(dispatchedTexts[0]?.text).toContain('不要调 reply 工具')
      // claude's output goes to user with [Display] prefix.
      expect(sendAssistantText).toHaveBeenCalledWith('chat-1', '[Claude] claude 的回答')
    })

    it('on speaker auth_failed: releases speaker session, sends notice, ends the chatroom cleanly', async () => {
      // /chat mode parity with /solo and /both: when a speaker's session
      // returns the structured auth_failed event, the coordinator must
      // release the session and end the loop with the neutral notice. The
      // previous code path silently broke (assistantText empty → "produced
      // no assistant text — ending") and the user got NOTHING.
      const store = makeMockStore()
      store.set('chat-r', { kind: 'chatroom' })
      const registry = createProviderRegistry()
      registry.register('claude', dummyProvider, { displayName: 'Claude', canResume: () => true })
      registry.register('codex', dummyProvider, { displayName: 'Codex', canResume: () => true })
      const release = vi.fn(async () => {})
      const acquire = vi.fn(async (_alias: string, _path: string, providerId: string) => {
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
      // Moderator decisions: pick claude first, then claude again. We expect
      // the loop to exit after the FIRST round because claude returned
      // auth_failed — the second decision should never be consumed.
      let modCalls = 0
      const haikuEval = vi.fn(async () => {
        modCalls++
        return JSON.stringify({ action: 'continue', speaker: 'claude', prompt: '开场', reasoning: '' })
      })
      const c = createConversationCoordinator({
        resolveProject: () => ({ alias: 'a', path: '/p' }),
        manager: { acquire, release },
        conversationStore: store,
        registry,
        defaultProviderId: 'claude',
        format: (m) => m.text,
        sendAssistantText,
        permissionMode: 'strict',
        log: () => {},
        haikuEval,
        chatroomMaxRounds: 4,
      })
      await c.dispatch(inbound('chat-r', '开始讨论'))

      // claude's session was released so the next inbound starts clean.
      expect(release).toHaveBeenCalledWith('a', 'claude')
      // Loop exited after the first speaker turn (moderator called once).
      expect(modCalls).toBe(1)
      // User got the neutral notice — NOT the raw sentinel or a "[Claude]" prefix.
      const sent = sendAssistantText.mock.calls.map(call => call[1] as string)
      expect(sent.some(t => /Claude 登录已过期/.test(t) && t.includes('claude login'))).toBe(true)
      expect(sent.some(t => /Please run \/login|Not logged in/.test(t))).toBe(false)
      expect(sent.some(t => /^\[Claude\]/.test(t))).toBe(false)
    })

    it('runs a 2-round exchange when moderator continues then ends', async () => {
      const { c, dispatchedTexts, sendAssistantText } = setupChatroom({
        moderatorDecisions: [
          { action: 'continue', speaker: 'claude', prompt: '先答' },
          { action: 'continue', speaker: 'codex', prompt: '看 claude 说了 X，你怎么看' },
          { action: 'end', reasoning: 'converged' },
        ],
        replies: {
          claude: [{ assistantText: ['claude 答 X'] }],
          codex: [{ assistantText: ['codex 同意 X 但补充 Y'] }],
        },
      })
      await c.dispatch(inbound('chat-1', 'q'))
      expect(dispatchedTexts.map(d => d.providerId)).toEqual(['claude', 'codex'])
      const userReplies = sendAssistantText.mock.calls.map(([, t]) => t)
      expect(userReplies).toEqual(['[Claude] claude 答 X', '[Codex] codex 同意 X 但补充 Y'])
    })

    it('round 1 end is coerced to continue (user must hear at least one AI per msg)', async () => {
      // v0.5.10 — moderator returning 'end' on round 1 used to mean "0
      // replies" which made user feel ignored. Now coerced to a single
      // continue with the generic prompt; subsequent rounds may still end.
      const { c, dispatchedTexts, sendAssistantText } = setupChatroom({
        moderatorDecisions: [
          { action: 'end', reasoning: 'trivial' },     // would-be skip
          { action: 'end', reasoning: 'now done' },    // round 2 actually ends
        ],
        replies: {
          claude: [{ assistantText: ['某个回应'] }],
        },
      })
      await c.dispatch(inbound('chat-1', 'hi'))
      // One dispatch happened — the coerced round-1 continue.
      expect(dispatchedTexts).toHaveLength(1)
      expect(sendAssistantText).toHaveBeenCalledTimes(1)
      expect(sendAssistantText.mock.calls[0]?.[1]).toContain('[Claude]')
    })

    it('forces end at chatroomMaxRounds even if moderator says continue', async () => {
      const { c, dispatchedTexts } = setupChatroom({
        maxRounds: 2,
        moderatorDecisions: [
          { action: 'continue', speaker: 'claude', prompt: '1' },
          { action: 'continue', speaker: 'codex', prompt: '2' },
          // Round 3 is forced end inside evaluateRound, never asks haiku.
        ],
        replies: {
          claude: [{ assistantText: ['c1'] }],
          codex: [{ assistantText: ['c2'] }],
        },
      })
      await c.dispatch(inbound('chat-1', 'q'))
      expect(dispatchedTexts).toHaveLength(2)
    })

    it('preserves [image:/path] marker in dispatched prompt when moderator paraphrases (chatroom image inbound)', async () => {
      // Bug 2026-05-08: chatroom users sending an image saw the speaker
      // reply as if no image was attached. Root cause: the moderator
      // (haiku-4-5) sees [image:/abs/path] in history but generates a
      // NEW prompt that paraphrases the user msg ("用户发了张图")
      // and drops the structural marker. The speaker session then has
      // no path to load via Read/Bash. solo / parallel are unaffected
      // because they dispatch format(msg) directly with no moderator.
      // Fix: coordinator re-injects msg.attachments markers into the
      // dispatched prompt unconditionally (deduped if moderator did
      // happen to preserve them).
      const store = makeMockStore()
      store.set('chat-1', { kind: 'chatroom' })
      const registry = createProviderRegistry()
      registry.register('claude', dummyProvider, { displayName: 'Claude', canResume: () => true })
      registry.register('codex', dummyProvider, { displayName: 'Codex', canResume: () => true })

      const dispatchedTexts: Array<{ providerId: string; text: string }> = []
      const acquire = vi.fn(async (_a: string, _p: string, providerId: string) => ({
        alias: 'a', path: '/p', providerId, lastUsedAt: 0,
        dispatch: (text: string): AsyncIterable<AgentEvent> => {
          dispatchedTexts.push({ providerId, text })
          return {
            async *[Symbol.asyncIterator]() {
              yield { kind: 'text', text: 'ok' } as AgentEvent
              yield { kind: 'result', sessionId: '_', numTurns: 1, durationMs: 0 } as AgentEvent
            },
          }
        },
        close: async () => {},
      }))

      // Simulate the bug: moderator omits [image:...] in its generated prompt.
      let modCall = 0
      const decisions = [
        { action: 'continue', speaker: 'claude', prompt: '描述一下用户发的图', reasoning: 'paraphrased' },
        { action: 'end', reasoning: 'done' },
      ]
      const haikuEval = vi.fn(async () => JSON.stringify(decisions[modCall++]))

      const c = createConversationCoordinator({
        resolveProject: () => ({ alias: 'a', path: '/p' }),
        manager: { acquire },
        conversationStore: store,
        registry,
        defaultProviderId: 'claude',
        format: formatInbound,  // real formatter — emits [image:/path]
        sendAssistantText: vi.fn(),
        permissionMode: 'strict',
        log: () => {},
        haikuEval,
      })

      await c.dispatch({
        chatId: 'chat-1',
        userId: 'u1',
        text: '这是什么',
        msgType: 'image',
        createTimeMs: 1,
        accountId: 'a',
        attachments: [{ kind: 'image', path: '/inbox/a/test.jpg' }],
      })

      expect(dispatchedTexts).toHaveLength(1)
      // Marker must be visible to speaker even though moderator dropped it.
      expect(dispatchedTexts[0]?.text).toContain('[image:/inbox/a/test.jpg]')
    })

    it('injects [chat_id:xxx] so speaker can route memory_* / set_user_name correctly (chatroom 2026-05-08 audit)', async () => {
      // Bug A from the post-incident audit: solo/parallel dispatch the
      // verbatim <wechat chat_id="..."> envelope so memory_read('xxx/profile.md')
      // and set_user_name(chat_id, ...) work. Chatroom funnels through the
      // moderator which paraphrases the user msg and drops the chat_id.
      // Without an injected [chat_id:...] header the speaker can't pick the
      // right memory subdirectory or call chat-keyed tools at all.
      const store = makeMockStore()
      store.set('chat-abc', { kind: 'chatroom' })
      const registry = createProviderRegistry()
      registry.register('claude', dummyProvider, { displayName: 'Claude', canResume: () => true })
      registry.register('codex', dummyProvider, { displayName: 'Codex', canResume: () => true })

      const dispatchedTexts: Array<{ providerId: string; text: string }> = []
      const acquire = vi.fn(async (_a: string, _p: string, providerId: string) => ({
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

      let modCall = 0
      const decisions = [
        // Moderator's prompt mentions the question but not the chat_id —
        // the bug surface. Nothing in the haiku output forwards the
        // structural identifier the speaker needs.
        { action: 'continue', speaker: 'claude', prompt: '初步看法 + 抛球', reasoning: 'open' },
        { action: 'end' },
      ]
      const haikuEval = vi.fn(async () => JSON.stringify(decisions[modCall++]))

      const c = createConversationCoordinator({
        resolveProject: () => ({ alias: 'a', path: '/p' }),
        manager: { acquire },
        conversationStore: store,
        registry,
        defaultProviderId: 'claude',
        format: formatInbound,
        sendAssistantText: vi.fn(),
        permissionMode: 'strict',
        log: () => {},
        haikuEval,
      })

      await c.dispatch({
        chatId: 'chat-abc',
        userId: 'u1',
        text: '记一下我的偏好',
        msgType: 'text',
        createTimeMs: 1,
        accountId: 'acct-x',
      })

      expect(dispatchedTexts).toHaveLength(1)
      expect(dispatchedTexts[0]?.text).toContain('[chat_id:chat-abc]')
    })

    it('does not duplicate attachment markers when moderator already includes them', async () => {
      // Defense against future reverse-bugs: if the moderator does
      // preserve the marker, we shouldn't append it twice.
      const store = makeMockStore()
      store.set('chat-1', { kind: 'chatroom' })
      const registry = createProviderRegistry()
      registry.register('claude', dummyProvider, { displayName: 'Claude', canResume: () => true })
      registry.register('codex', dummyProvider, { displayName: 'Codex', canResume: () => true })

      const dispatchedTexts: Array<{ providerId: string; text: string }> = []
      const acquire = vi.fn(async (_a: string, _p: string, providerId: string) => ({
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

      let modCall = 0
      const decisions = [
        { action: 'continue', speaker: 'claude', prompt: '看图：[image:/inbox/a/x.jpg]，描述', reasoning: 'preserved' },
        { action: 'end' },
      ]
      const haikuEval = vi.fn(async () => JSON.stringify(decisions[modCall++]))

      const c = createConversationCoordinator({
        resolveProject: () => ({ alias: 'a', path: '/p' }),
        manager: { acquire },
        conversationStore: store,
        registry,
        defaultProviderId: 'claude',
        format: formatInbound,
        sendAssistantText: vi.fn(),
        permissionMode: 'strict',
        log: () => {},
        haikuEval,
      })

      await c.dispatch({
        chatId: 'chat-1', userId: 'u1', text: '这是什么',
        msgType: 'image', createTimeMs: 1, accountId: 'a',
        attachments: [{ kind: 'image', path: '/inbox/a/x.jpg' }],
      })

      const occurrences = (dispatchedTexts[0]?.text.match(/\[image:\/inbox\/a\/x\.jpg\]/g) ?? []).length
      expect(occurrences).toBe(1)
    })

    it('skips assistantText forwarding when speaker calls reply tool but still records history', async () => {
      const { c, sendAssistantText, dispatchedTexts } = setupChatroom({
        moderatorDecisions: [
          { action: 'continue', speaker: 'claude', prompt: 'go' },
          { action: 'continue', speaker: 'codex', prompt: 'now you' },
          { action: 'end' },
        ],
        replies: {
          claude: [{ assistantText: ['leaked'], replyToolCalled: true }],
          codex: [{ assistantText: ['codex normal'] }],
        },
      })
      await c.dispatch(inbound('chat-1', 'q'))
      // claude's text NOT forwarded by coordinator (reply tool already sent it),
      // but codex still ran on round 2.
      expect(dispatchedTexts.map(d => d.providerId)).toEqual(['claude', 'codex'])
      expect(sendAssistantText.mock.calls.map(([, t]) => t)).toEqual(['[Codex] codex normal'])
    })

    it('aborts mid-loop on cancel(chatId) (RFC 03 review #11)', async () => {
      let coordinatorRef: ReturnType<typeof createConversationCoordinator> | null = null
      const setup = setupChatroom({
        moderatorDecisions: [
          { action: 'continue', speaker: 'claude', prompt: '1' },
          { action: 'continue', speaker: 'codex', prompt: '2' },
          { action: 'continue', speaker: 'claude', prompt: '3' },
        ],
        replies: {
          claude: [{ assistantText: ['c1'] }, { assistantText: ['c3'] }],
          codex: [{ assistantText: ['c2'] }],
        },
      })
      coordinatorRef = setup.c
      // Note: simpler — just dispatch and rely on the SAME acquire spy
      // path; cancel is invoked via the stored ref before round 3.
      // Effectively: round 1 (claude), round 2 (codex + cancel), round 3 aborts.
      // We call cancel manually after the codex turn returns — patch via
      // moderator delay isn't available here. Simulate by issuing cancel
      // before dispatch:
      const dispatchPromise = setup.c.dispatch(inbound('chat-1', 'q'))
      // Yield once so claude (round 1) starts
      await Promise.resolve()
      // Dispatch will progress through claude + codex, then on round 3
      // the loop body checks aborter.signal — we cancel here:
      setup.c.cancel('chat-1')
      await dispatchPromise
      // Cancel may fire mid-flight; accept that round 3 (claude r2) is
      // not dispatched OR dispatched but abort message follows.
      expect(setup.dispatchedTexts.length).toBeLessThanOrEqual(3)
      expect(setup.sendAssistantText.mock.calls.some(([, t]) => t.includes('收到 /stop'))).toBe(true)
    })

    it('falls back to solo+default when one of the chatroom providers is unregistered', async () => {
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
      const acquire = vi.fn(async (_a: string, _p: string, _provider: string) =>
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
        log,
      })
      await c.dispatch(inbound('chat-1', 'hi'))
      // Solo dispatch — single acquire, claude.
      expect(acquire).toHaveBeenCalledTimes(1)
      expect(acquire.mock.calls[0]?.[2]).toBe('claude')
      expect(log).toHaveBeenCalledWith('COORDINATOR', expect.stringContaining('chatroom mode missing providers'))
    })

    it('one speaker throwing surfaces an error message to user and ends the loop', async () => {
      const store = makeMockStore()
      store.set('chat-1', { kind: 'chatroom' })
      const registry = createProviderRegistry()
      registry.register('claude', dummyProvider, { displayName: 'Claude', canResume: () => true })
      registry.register('codex', dummyProvider, { displayName: 'Codex', canResume: () => true })
      const acquire = vi.fn(async () => {
        throw new Error('claude session crashed')
      })
      const sendAssistantText = vi.fn(async (_chatId: string, _text: string) => {})
      const c = createConversationCoordinator({
        resolveProject: () => ({ alias: 'a', path: '/p' }),
        manager: { acquire },
        conversationStore: store,
        registry,
        defaultProviderId: 'claude',
        format: () => 'x',
        sendAssistantText,
        permissionMode: 'strict',
        log: () => {},
      })
      await c.dispatch(inbound('chat-1', 'hi'))
      expect(sendAssistantText).toHaveBeenCalledWith('chat-1', expect.stringContaining('chatroom error'))
    })

    it('rapid follow-up message in same chat preempts prior dispatch and serialises cleanly', async () => {
      // PR C2 stress test — two chatroom messages arrive in the same chat
      // before the first finishes. Expected behaviour: the second dispatch
      // aborts the first (latest-user-msg-wins), waits for the first to
      // unwind cleanly, then runs its own loop. Both messages contribute
      // entries to the persisted history (no lost-write race).
      //
      // Pre-C2 bugs this guards against:
      //   * concurrent loops racing on chatroomHistories.set (last writer
      //     wins, prior user msgs silently dropped)
      //   * dispatch B reading a stale snapshot that doesn't include A's
      //     partial progress
      const store = makeMockStore()
      store.set('chat-1', { kind: 'chatroom' })
      const registry = createProviderRegistry()
      registry.register('claude', dummyProvider, { displayName: 'Claude', canResume: () => true })
      registry.register('codex', dummyProvider, { displayName: 'Codex', canResume: () => true })

      const acquire = vi.fn(async (_a: string, _p: string, providerId: string) => ({
        alias: 'a', path: '/p', providerId, lastUsedAt: 0,
        dispatch: (_text: string): AsyncIterable<AgentEvent> => ({
          async *[Symbol.asyncIterator]() {
            yield { kind: 'text', text: `${providerId}-reply` }
            yield { kind: 'result', sessionId: '_', numTurns: 1, durationMs: 0 }
          },
        }),
        close: async () => {},
      }))

      // haikuEval is gated per-call so we can pause A mid-flight and let
      // B preempt.
      const promptsSeen: string[] = []
      const releases: Array<{ resolve: () => void; promise: Promise<void> }> = []
      for (let i = 0; i < 10; i++) {
        let resolveFn: () => void = () => {}
        const p = new Promise<void>((res) => { resolveFn = res })
        releases.push({ resolve: resolveFn, promise: p })
      }
      // Scripted decisions per haikuEval call:
      //   0  A round 1 — continue, claude (speaker runs; abort observed
      //                  at round-2 entry → break)
      //   1  B round 1 — continue, claude
      //   2  B round 2 — end
      const decisions = [
        { action: 'continue', speaker: 'claude', prompt: 'A-r1' },
        { action: 'continue', speaker: 'claude', prompt: 'B-r1' },
        { action: 'end', reasoning: 'B-done' },
      ]
      let modCallCount = 0
      const haikuEval = vi.fn(async (prompt: string) => {
        const idx = modCallCount++
        promptsSeen.push(prompt)
        await releases[idx]!.promise
        return JSON.stringify(decisions[idx] ?? { action: 'end' })
      })

      const c = createConversationCoordinator({
        resolveProject: () => ({ alias: 'a', path: '/p' }),
        manager: { acquire },
        conversationStore: store,
        registry,
        defaultProviderId: 'claude',
        format: (m) => m.text,
        permissionMode: 'strict',
        log: () => {},
        haikuEval,
      })

      // Start A — paused at call 0 (its round-1 haikuEval).
      const pA = c.dispatch(inbound('chat-1', 'Q-from-A'))
      await new Promise(r => setImmediate(r))

      // Start B — coordinator preempts A (priorAborter.abort()) then
      // awaits A's dispatch promise. Releasing all gates lets both
      // dispatches unwind in order.
      const pB = c.dispatch(inbound('chat-1', 'Q-from-B'))

      // Release every gate so both dispatches can finish.
      for (const r of releases) r.resolve()
      await Promise.all([pA, pB])

      // A ran round 1 (call 0 = 'A-r1') and pushed a speaker turn before
      // observing abort at round 2 entry. B then ran its own loop —
      // round 1 (call 1 = 'B-r1') saw A's persisted contribution in
      // history, plus its own user msg.
      expect(promptsSeen[0]!).toContain('Q-from-A')
      const bRound1Prompt = promptsSeen[1]
      expect(bRound1Prompt).toBeDefined()
      expect(bRound1Prompt!).toContain('Q-from-A')   // A's persisted user msg
      expect(bRound1Prompt!).toContain('Q-from-B')   // B's own user msg
      // B's round-2 (the synthesis turn) also sees both contributions.
      const bRound2Prompt = promptsSeen[2]
      expect(bRound2Prompt).toBeDefined()
      expect(bRound2Prompt!).toContain('Q-from-A')
      expect(bRound2Prompt!).toContain('Q-from-B')
    })

    it('pops the trailing user entry when no speaker turn was produced (acquire throws on round 1)', async () => {
      // Bug: when a dispatch broke out of the loop before any speaker turn
      // pushed to history (early abort, acquire/auth_failed/speaker-error
      // at round 1, ...), the saved history kept the orphan user entry and
      // the next dispatch's moderator saw a malformed sequence ending in
      // two consecutive `{role:user}` entries. Fix: on dispatch exit, pop
      // the trailing user if it wasn't followed by a speaker turn.
      const store = makeMockStore()
      store.set('chat-1', { kind: 'chatroom' })
      const registry = createProviderRegistry()
      registry.register('claude', dummyProvider, { displayName: 'Claude', canResume: () => true })
      registry.register('codex', dummyProvider, { displayName: 'Codex', canResume: () => true })

      let failOnce = true
      const acquire = vi.fn(async (_a: string, _p: string, providerId: string) => {
        if (failOnce) {
          failOnce = false
          throw new Error('simulated speaker session crash')
        }
        return {
          alias: 'a', path: '/p', providerId, lastUsedAt: 0,
          dispatch: (_text: string): AsyncIterable<AgentEvent> => ({
            async *[Symbol.asyncIterator]() {
              yield { kind: 'text', text: `${providerId}-reply` }
              yield { kind: 'result', sessionId: '_', numTurns: 1, durationMs: 0 }
            },
          }),
          close: async () => {},
        }
      })

      const promptsSeen: string[] = []
      const haikuEval = vi.fn(async (prompt: string) => {
        promptsSeen.push(prompt)
        return JSON.stringify({ action: 'continue', speaker: 'claude', prompt: 'r1' })
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
        log: () => {},
        haikuEval,
      })

      // Dispatch 1 — speaker session throws on acquire, loop breaks before
      // any speaker turn pushes to history.
      await c.dispatch(inbound('chat-1', 'Q-failed'))

      // Dispatch 2 — clean follow-up. The moderator's round-1 prompt
      // embeds the stored history; the orphan user from dispatch 1 must
      // not be in it.
      promptsSeen.length = 0
      await c.dispatch(inbound('chat-1', 'Q-followup'))

      expect(promptsSeen[0]).toBeDefined()
      expect(promptsSeen[0]!).toContain('Q-followup')
      expect(promptsSeen[0]!).not.toContain('Q-failed')
    })

    it('cancel(chatId) returns false when no in-flight loop', async () => {
      const { c } = setupChatroom({
        moderatorDecisions: [{ action: 'end' }],
        replies: {},
      })
      expect(c.cancel('chat-1')).toBe(false)
      await c.dispatch(inbound('chat-1', 'hi'))
      expect(c.cancel('chat-1')).toBe(false)
    })

    it('setMode rejects chatroom when one provider is missing', () => {
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
        log: () => {},
      })
      expect(() => c.setMode('chat-1', { kind: 'chatroom' }))
        .toThrow(/chatroom.*missing.*codex/)
    })
  })
})
