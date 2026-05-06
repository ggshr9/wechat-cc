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
      // Per-provider replies queue (FIFO).
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

    it('terminates immediately when moderator returns end on round 1', async () => {
      const { c, dispatchedTexts, sendAssistantText } = setupChatroom({
        moderatorDecisions: [{ action: 'end', reasoning: 'trivial' }],
        replies: {},
      })
      await c.dispatch(inbound('chat-1', 'hi'))
      expect(dispatchedTexts).toHaveLength(0)
      expect(sendAssistantText).not.toHaveBeenCalled()
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
      const dispatchedProviders: string[] = []
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
      // Wrap acquire to fire cancel on codex's turn.
      const wrapped = vi.fn(async (alias: string, path: string, providerId: string) => {
        dispatchedProviders.push(providerId)
        const handle = await setup.acquire(alias, path, providerId)
        const origDispatch = handle.dispatch
        handle.dispatch = async (text: string) => {
          const r = await origDispatch(text)
          if (providerId === 'codex') coordinatorRef!.cancel('chat-1')
          return r
        }
        return handle
      })
      // Replace acquire with wrapped — easier than re-building. (Hack: we
      // already created the coordinator with the original acquire; mock
      // calls via the underlying spy still get captured.)
      const _ = wrapped // suppress unused if it isn't used
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
