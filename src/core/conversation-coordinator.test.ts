import { describe, expect, it, vi } from 'vitest'
import { createConversationCoordinator } from './conversation-coordinator'
import { createProviderRegistry } from './provider-registry'
import * as capabilityMatrix from './capability-matrix'
import type { AgentProvider } from './agent-provider'
import type { Mode } from './conversation'
import type { InboundMsg } from './prompt-format'

const dummyProvider: AgentProvider = {
  spawn: async () => ({
    dispatch: async () => ({ assistantText: [], replyToolCalled: false }),
    close: async () => {},
    onAssistantText: () => () => {},
    onResult: () => () => {},
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
    const dispatchMock = vi.fn(async () => ({ assistantText: [], replyToolCalled: false }))
    const acquire = vi.fn(async (_alias: string, _path: string, _provider: string) => ({
      alias: 'a', path: '/p', providerId: 'codex', lastUsedAt: 0,
      dispatch: dispatchMock,
      close: async () => {},
      onAssistantText: () => () => {},
      onResult: () => () => {},
    }))
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
    expect(dispatchMock).toHaveBeenCalledWith('[fmt]hi codex')
  })

  it('dispatch falls back to default provider when persisted mode references unknown provider', async () => {
    const store = makeMockStore()
    store.set('chat-1', { kind: 'solo', provider: 'gemini' })  // not registered
    const acquire = vi.fn(async (_alias: string, _path: string, _providerId: string) => ({
      alias: 'a', path: '/p', providerId: 'claude', lastUsedAt: 0,
      dispatch: async () => ({ assistantText: [], replyToolCalled: false }),
      close: async () => {},
      onAssistantText: () => () => {},
      onResult: () => () => {},
    }))
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
    const acquire = vi.fn(async (_alias: string, _path: string, _providerId: string) => ({
      alias: 'a', path: '/p', providerId: 'claude', lastUsedAt: 0,
      dispatch: async () => ({ assistantText: ['hi from agent'], replyToolCalled: true }),
      close: async () => {},
      onAssistantText: () => () => {},
      onResult: () => () => {},
    }))
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
    const acquire = vi.fn(async (_alias: string, _path: string, _providerId: string) => ({
      alias: 'a', path: '/p', providerId: 'claude', lastUsedAt: 0,
      dispatch: async () => ({ assistantText: ['raw text 1', 'raw text 2'], replyToolCalled: false }),
      close: async () => {},
      onAssistantText: () => () => {},
      onResult: () => () => {},
    }))
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

  // chatroom is now implemented in P5 — see "chatroom mode (P5)" describe block below.

  it('dispatch calls assertSupported for the effective provider before acquiring session', async () => {
    // Spy on assertSupported — verify it's called with correct (mode, provider, permissionMode)
    const spy = vi.spyOn(capabilityMatrix, 'assertSupported')
    const acquire = vi.fn(async (_alias: string, _path: string, _providerId: string) => ({
      alias: 'a', path: '/p', providerId: 'claude', lastUsedAt: 0,
      dispatch: async () => ({ assistantText: [], replyToolCalled: false }),
      close: async () => {},
      onAssistantText: () => () => {},
      onResult: () => () => {},
    }))
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
      const dispatchMock = vi.fn(async () => ({ assistantText: ['hi from primary'], replyToolCalled: true }))
      const acquire = vi.fn(async (_alias: string, _path: string, providerId: string) => ({
        alias: 'a', path: '/p', providerId, lastUsedAt: 0,
        dispatch: dispatchMock,
        close: async () => {},
        onAssistantText: () => () => {},
        onResult: () => () => {},
      }))
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
      return { c, acquire, dispatchMock, log, store }
    }

    it('dispatches solo to the primary provider (peer reachable via delegate-mcp tool, not parallel session)', async () => {
      const { c, acquire, dispatchMock } = setupPrimaryTool({ initialMode: { kind: 'primary_tool', primary: 'claude' } })
      await c.dispatch(inbound('chat-1', 'hi'))
      expect(acquire).toHaveBeenCalledTimes(1)
      expect(acquire.mock.calls[0]?.[2]).toBe('claude')
      expect(dispatchMock).toHaveBeenCalledTimes(1)
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
      const acquire = vi.fn(async (_alias: string, _path: string, _providerId: string) => ({
        alias: 'a', path: '/p', providerId: 'claude', lastUsedAt: 0,
        dispatch: async () => ({ assistantText: [], replyToolCalled: true }),
        close: async () => {},
        onAssistantText: () => () => {},
        onResult: () => () => {},
      }))
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
      claudeResult?: { assistantText: string[]; replyToolCalled: boolean }
      codexResult?: { assistantText: string[]; replyToolCalled: boolean }
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
      const acquire = vi.fn(async (alias: string, path: string, providerId: string) => ({
        alias, path, providerId, lastUsedAt: 0,
        dispatch: async (text: string) => {
          dispatchCalls.push({ providerId, text })
          if (providerId === 'claude') {
            if (opts.claudeThrows) throw opts.claudeThrows
            return opts.claudeResult ?? { assistantText: [], replyToolCalled: true }
          }
          if (opts.codexThrows) throw opts.codexThrows
          return opts.codexResult ?? { assistantText: [], replyToolCalled: true }
        },
        close: async () => {},
        onAssistantText: () => () => {},
        onResult: () => () => {},
      }))
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
        claudeResult: { assistantText: ['hi'], replyToolCalled: true },
        codexResult: { assistantText: ['hi'], replyToolCalled: true },
      })
      await c.dispatch(inbound('chat-1', 'hi'))
      expect(sendAssistantText).not.toHaveBeenCalled()
    })

    it('forwards prefixed assistant text via fallback per-provider when reply tool NOT called', async () => {
      const { c, sendAssistantText } = setupParallel({
        claudeResult: { assistantText: ['claude raw 1', 'claude raw 2'], replyToolCalled: false },
        codexResult: { assistantText: ['codex raw'], replyToolCalled: false },
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
        codexResult: { assistantText: ['codex still here'], replyToolCalled: false },
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
      const acquire = vi.fn(async (_alias: string, _path: string, _providerId: string) => ({
        alias: 'a', path: '/p', providerId: 'claude', lastUsedAt: 0,
        dispatch: async () => ({ assistantText: [], replyToolCalled: true }),
        close: async () => {},
        onAssistantText: () => () => {},
        onResult: () => () => {},
      }))
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
      const acquire = vi.fn(async (alias: string, path: string, providerId: string) => ({
        alias, path, providerId, lastUsedAt: 0,
        dispatch: async () => ({ assistantText: [`hi from ${providerId}`], replyToolCalled: false }),
        close: async () => {},
        onAssistantText: () => () => {},
        onResult: () => () => {},
      }))
      const sendAssistantText = vi.fn(async (_chatId: string, _text: string) => {})
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

  describe('chatroom mode (P5)', () => {
    function setupChatroom(opts: {
      // Map<providerId, list of dispatch results to return in order>
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
      const acquire = vi.fn(async (_alias: string, _path: string, providerId: string) => ({
        alias: 'a', path: '/p', providerId, lastUsedAt: 0,
        dispatch: async (text: string) => {
          dispatchedTexts.push({ providerId, text })
          const list = opts.replies[providerId] ?? []
          const i = counters[providerId] ?? 0
          counters[providerId] = i + 1
          const r = list[i] ?? { assistantText: [], replyToolCalled: false }
          return { assistantText: r.assistantText, replyToolCalled: r.replyToolCalled ?? false }
        },
        close: async () => {},
        onAssistantText: () => () => {},
        onResult: () => () => {},
      }))
      const sendAssistantText = vi.fn(async (_chatId: string, _text: string) => {})
      const log = vi.fn()
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
        ...(opts.maxRounds !== undefined ? { chatroomMaxRounds: opts.maxRounds } : {}),
      })
      return { c, acquire, dispatchedTexts, sendAssistantText, log }
    }

    it('terminates after one turn when speaker addresses @user (no relay)', async () => {
      const { c, sendAssistantText, dispatchedTexts } = setupChatroom({
        replies: { claude: [{ assistantText: ['@user 我直接回答了'] }] },
      })
      await c.dispatch(inbound('chat-1', 'hello'))
      // One turn — claude only.
      expect(dispatchedTexts).toHaveLength(1)
      expect(dispatchedTexts[0]?.providerId).toBe('claude')
      // User receives prefixed reply.
      expect(sendAssistantText).toHaveBeenCalledWith('chat-1', '[Claude] 我直接回答了')
    })

    it('runs a 2-round inter-agent exchange (claude @codex → codex @user)', async () => {
      const { c, dispatchedTexts, sendAssistantText } = setupChatroom({
        replies: {
          claude: [{ assistantText: ['@codex 你看看 src/foo.ts 的边界'] }],
          codex: [{ assistantText: ['@user 边界看起来没问题，但建议加个测试'] }],
        },
      })
      await c.dispatch(inbound('chat-1', '帮我审计 foo.ts'))
      // Two turns — claude then codex.
      expect(dispatchedTexts).toHaveLength(2)
      expect(dispatchedTexts.map(d => d.providerId)).toEqual(['claude', 'codex'])
      // Codex's relay envelope contains claude's @codex message verbatim.
      expect(dispatchedTexts[1]?.text).toContain('@codex 你看看 src/foo.ts 的边界')
      expect(dispatchedTexts[1]?.text).toContain('sender="claude"')
      // User sees only codex's @user reply (claude's @codex went to peer).
      expect(sendAssistantText).toHaveBeenCalledTimes(1)
      expect(sendAssistantText).toHaveBeenCalledWith('chat-1', '[Codex] 边界看起来没问题，但建议加个测试')
    })

    it('routes mixed-segment outputs (some @user some @peer)', async () => {
      const { c, sendAssistantText, dispatchedTexts } = setupChatroom({
        replies: {
          claude: [{
            assistantText: ['@user 我先看了一遍\n@codex 你那边怎么看 line 42 的边界？'],
          }],
          codex: [{ assistantText: ['@user 同意，line 42 是 off-by-one'] }],
        },
      })
      await c.dispatch(inbound('chat-1', '审计'))
      // claude's @user goes to user; @codex relays to codex; codex's @user goes to user
      expect(sendAssistantText.mock.calls.map(([, t]) => t)).toEqual([
        '[Claude] 我先看了一遍',
        '[Codex] 同意，line 42 是 off-by-one',
      ])
      expect(dispatchedTexts).toHaveLength(2)
    })

    it('treats null-addressee (no @-tag) as user-facing', async () => {
      const { c, sendAssistantText } = setupChatroom({
        replies: { claude: [{ assistantText: ['just a plain reply, no tag'] }] },
      })
      await c.dispatch(inbound('chat-1', 'hi'))
      expect(sendAssistantText).toHaveBeenCalledWith('chat-1', '[Claude] just a plain reply, no tag')
    })

    it('treats unknown @<id> as user-facing (graceful fallback)', async () => {
      const { c, sendAssistantText } = setupChatroom({
        replies: { claude: [{ assistantText: ['@gemini hello there'] }] },
      })
      await c.dispatch(inbound('chat-1', 'hi'))
      // Not codex → routed to user with full body (preserves @gemini in text).
      expect(sendAssistantText).toHaveBeenCalledWith('chat-1', '[Claude] hello there')
    })

    it('hits MAX_ROUNDS=2 and forces termination, drops queued relays', async () => {
      // Both agents always relay to peer — would loop forever without the cap.
      const { c, dispatchedTexts, sendAssistantText, log } = setupChatroom({
        maxRounds: 2,
        replies: {
          claude: [
            { assistantText: ['@codex round 1 from claude'] },
            { assistantText: ['@codex round 3 from claude'] },  // shouldn't happen
          ],
          codex: [
            { assistantText: ['@claude round 2 from codex'] },
          ],
        },
      })
      await c.dispatch(inbound('chat-1', 'kick off'))
      // Exactly 2 turns dispatched (claude r1, codex r2). After r2 the
      // relay to claude is dropped because we've hit max_rounds.
      expect(dispatchedTexts).toHaveLength(2)
      // The would-be relay surfaces to user with max-rounds suffix.
      const userReplies = sendAssistantText.mock.calls.map(([, t]) => t)
      expect(userReplies).toHaveLength(1)
      expect(userReplies[0]).toContain('[Codex] @claude round 2 from codex')
      expect(userReplies[0]).toContain('max_rounds')
      // Log mentions the drop.
      expect(log).toHaveBeenCalledWith('COORDINATOR_CHATROOM', expect.stringContaining('max_rounds reached'))
    })

    it('drops queued relays AND surfaces ALL would-be peer messages with suffix on max-rounds turn', async () => {
      // On the cap turn, the speaker generates one @peer + one @user.
      // The @peer one becomes user-facing (with suffix), the @user goes
      // through normally.
      const { c, sendAssistantText } = setupChatroom({
        maxRounds: 1,  // cap on the very first turn
        replies: {
          claude: [{
            assistantText: ['@codex would-be-relayed-but-cap\n@user final answer'],
          }],
        },
      })
      await c.dispatch(inbound('chat-1', 'kick off'))
      const userReplies = sendAssistantText.mock.calls.map(([, t]) => t)
      // Both segments reach user; the first carries the max-rounds suffix.
      expect(userReplies).toHaveLength(2)
      expect(userReplies[0]).toContain('[Claude] @codex would-be-relayed-but-cap')
      expect(userReplies[0]).toContain('max_rounds')
      expect(userReplies[1]).toBe('[Claude] final answer')
    })

    it('initial speaker is providerA (claude) by default', async () => {
      const { c, dispatchedTexts } = setupChatroom({
        replies: { claude: [{ assistantText: ['@user done'] }] },
      })
      await c.dispatch(inbound('chat-1', 'hi'))
      expect(dispatchedTexts[0]?.providerId).toBe('claude')
    })

    it('subsequent chatroom session for the same chat uses last-spoke as initial speaker', async () => {
      const { c, dispatchedTexts } = setupChatroom({
        replies: {
          claude: [
            { assistantText: ['@codex round 1'] },
            // No second claude round needed — second session below.
          ],
          codex: [
            { assistantText: ['@user end'] },
            { assistantText: ['@user end again'] },
          ],
        },
      })
      // First chat session: claude → codex → terminate. lastSpoke=codex.
      await c.dispatch(inbound('chat-1', 'first'))
      // Second chat session for same chat — should start with codex.
      await c.dispatch(inbound('chat-1', 'second'))
      const speakers = dispatchedTexts.map(d => d.providerId)
      expect(speakers).toEqual(['claude', 'codex', 'codex'])
    })

    it('falls back to solo+default when one of the chatroom providers is unregistered', async () => {
      const store = makeMockStore()
      store.set('chat-1', { kind: 'chatroom' })
      // Only claude registered
      const registry = createProviderRegistry()
      registry.register('claude', dummyProvider, { displayName: 'Claude', canResume: () => true })
      const acquire = vi.fn(async (_a: string, _p: string, _provider: string) => ({
        alias: 'a', path: '/p', providerId: 'claude', lastUsedAt: 0,
        dispatch: async () => ({ assistantText: [], replyToolCalled: true }),
        close: async () => {},
        onAssistantText: () => () => {},
        onResult: () => () => {},
      }))
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

    it('skips assistantText routing when replyToolCalled is true (RFC 03 P5 review #1: avoid double-send)', async () => {
      // Agent ignored the "don't use reply in chatroom" hint and called
      // reply anyway. Without the guard, the SAME text would go out
      // twice — once via reply (with [Display] prefix from internal-api
      // maybePrefix), once via the coordinator's fallback path here.
      const { c, sendAssistantText } = setupChatroom({
        replies: { claude: [{
          assistantText: ['this should NOT be re-sent', '@codex would have queued but skipped'],
          replyToolCalled: true,  // ← agent used reply MCP tool
        }] },
      })
      await c.dispatch(inbound('chat-1', 'hi'))
      // The coordinator must not call sendAssistantText: reply route
      // already sent the text. Even @codex segments are skipped — the
      // routing channel is "all or nothing" per turn.
      expect(sendAssistantText).not.toHaveBeenCalled()
    })

    it('with replyToolCalled=true and pending non-empty: still rotates speaker for next turn', async () => {
      // Edge case: claude calls reply (skip route), but a previous
      // round had queued something for codex. Next turn should still
      // dispatch to codex with that pending item.
      const { c, dispatchedTexts } = setupChatroom({
        replies: {
          claude: [
            { assistantText: ['@codex first relay'], replyToolCalled: false },  // round 1: queue for codex
          ],
          codex: [
            // round 2: codex disobeys "no reply", calls reply tool — guard fires
            { assistantText: ['leaked text'], replyToolCalled: true },
          ],
        },
      })
      await c.dispatch(inbound('chat-1', 'hi'))
      // Both rounds dispatched (claude → codex), no extra round.
      expect(dispatchedTexts.map(d => d.providerId)).toEqual(['claude', 'codex'])
    })

    it('cancel(chatId) returns false when no in-flight loop', async () => {
      const { c } = setupChatroom({ replies: { claude: [{ assistantText: ['@user done'] }] } })
      // Before any dispatch: nothing in flight.
      expect(c.cancel('chat-1')).toBe(false)
      // After a sync-completing dispatch: still nothing in flight.
      await c.dispatch(inbound('chat-1', 'hi'))
      expect(c.cancel('chat-1')).toBe(false)
    })

    it('cancel(chatId) preempts an in-flight loop at the next turn boundary (RFC 03 review #11)', async () => {
      // Slow-dispatching speakers that yield control between turns so
      // the test can call cancel between rounds.
      let claudeTurn = 0
      const claudeStarted = { round1: false, round2: false }
      const dispatchOrder: string[] = []
      const store = (() => {
        const data = new Map<string, { mode: Mode }>()
        data.set('chat-1', { mode: { kind: 'chatroom' } })
        return {
          get: (chatId: string) => data.get(chatId) ?? null,
          set: vi.fn((chatId: string, mode: Mode) => { data.set(chatId, { mode }) }),
        }
      })()
      const registry = createProviderRegistry()
      registry.register('claude', dummyProvider, { displayName: 'Claude', canResume: () => true })
      registry.register('codex', dummyProvider, { displayName: 'Codex', canResume: () => true })
      let coordinatorRef: ReturnType<typeof createConversationCoordinator> | null = null
      const acquire = vi.fn(async (_alias: string, _path: string, providerId: string) => ({
        alias: 'a', path: '/p', providerId, lastUsedAt: 0,
        dispatch: async () => {
          dispatchOrder.push(providerId)
          if (providerId === 'claude') {
            claudeTurn++
            if (claudeTurn === 1) {
              claudeStarted.round1 = true
              return { assistantText: ['@codex round 1'], replyToolCalled: false }
            }
            claudeStarted.round2 = true
            return { assistantText: ['@user fallback after cancel'], replyToolCalled: false }
          }
          // codex: fire cancel BEFORE returning so the next turn (back to
          // claude round 2) sees the abort.
          coordinatorRef!.cancel('chat-1')
          return { assistantText: ['@claude relay 2'], replyToolCalled: false }
        },
        close: async () => {},
        onAssistantText: () => () => {},
        onResult: () => () => {},
      }))
      const sendAssistantText = vi.fn(async (_c: string, _t: string) => {})
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
      coordinatorRef = c
      await c.dispatch(inbound('chat-1', 'hi'))
      // Sequence: claude r1 (queued for codex) → codex r2 (calls cancel,
      // queued for claude) → claude r3 SHOULD NOT happen due to cancel.
      expect(dispatchOrder).toEqual(['claude', 'codex'])
      expect(claudeStarted.round2).toBe(false)
      // User receives the abort notice
      expect(sendAssistantText.mock.calls.some(([, t]) => t.includes('收到 /stop'))).toBe(true)
    })

    it('setMode chatroom→solo clears lastChatroomSpeaker (RFC 03 review #3 partial)', async () => {
      const { c, dispatchedTexts, sendAssistantText: _ } = setupChatroom({
        replies: {
          claude: [{ assistantText: ['@codex relay'] }],
          codex: [{ assistantText: ['@user done'] }],
        },
      })
      // Run a chatroom session — leaves lastChatroomSpeaker=codex.
      await c.dispatch(inbound('chat-1', 'first'))
      // Confirm codex was the last speaker.
      expect(dispatchedTexts.at(-1)?.providerId).toBe('codex')

      // Flip to solo+claude and back to chatroom — the cleared
      // lastChatroomSpeaker means we restart with default (claude),
      // not stale codex.
      c.setMode('chat-1', { kind: 'solo', provider: 'claude' })
      c.setMode('chat-1', { kind: 'chatroom' })
      // Run another chatroom session.
      await c.dispatch(inbound('chat-1', 'second'))
      // The third dispatch (first turn of second chatroom session) is
      // claude not codex — proves lastChatroomSpeaker was cleared.
      expect(dispatchedTexts[2]?.providerId).toBe('claude')
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
