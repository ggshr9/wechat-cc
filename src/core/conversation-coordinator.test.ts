import { describe, expect, it, vi } from 'vitest'
import { createConversationCoordinator, ModeNotImplementedError } from './conversation-coordinator'
import { createProviderRegistry } from './provider-registry'
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
      log: () => {},
    })
    await c.dispatch(inbound('chat-1', 'hi codex'))
    expect(acquire).toHaveBeenCalledWith('a', '/p', 'codex')
    expect(dispatchMock).toHaveBeenCalledWith('[fmt]hi codex')
  })

  it('dispatch falls back to default provider when persisted mode references unknown provider', async () => {
    const store = makeMockStore()
    store.set('chat-1', { kind: 'solo', provider: 'gemini' })  // not registered
    const acquire = vi.fn(async () => ({
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
      log,
    })
    await c.dispatch(inbound('chat-1', 'hi'))
    expect(acquire).toHaveBeenCalledWith('a', '/p', 'claude')
    expect(log).toHaveBeenCalledWith('COORDINATOR', expect.stringContaining("provider 'gemini' not registered"))
  })

  it('skips fallback sendAssistantText when reply tool was called', async () => {
    const acquire = vi.fn(async () => ({
      alias: 'a', path: '/p', providerId: 'claude', lastUsedAt: 0,
      dispatch: async () => ({ assistantText: ['hi from agent'], replyToolCalled: true }),
      close: async () => {},
      onAssistantText: () => () => {},
      onResult: () => () => {},
    }))
    const sendAssistantText = vi.fn(async () => {})
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
      log: () => {},
    })
    await c.dispatch(inbound('chat-1', 'hi'))
    expect(sendAssistantText).not.toHaveBeenCalled()
  })

  it('forwards assistantText via fallback when reply tool was NOT called', async () => {
    const acquire = vi.fn(async () => ({
      alias: 'a', path: '/p', providerId: 'claude', lastUsedAt: 0,
      dispatch: async () => ({ assistantText: ['raw text 1', 'raw text 2'], replyToolCalled: false }),
      close: async () => {},
      onAssistantText: () => () => {},
      onResult: () => () => {},
    }))
    const sendAssistantText = vi.fn(async () => {})
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
      log: () => {},
    })
    await c.dispatch(inbound('chat-1', 'hi'))
    expect(sendAssistantText).toHaveBeenCalledTimes(2)
    expect(sendAssistantText).toHaveBeenCalledWith('chat-1', 'raw text 1')
    expect(sendAssistantText).toHaveBeenCalledWith('chat-1', 'raw text 2')
  })

  it('throws ModeNotImplementedError for primary_tool/chatroom (P4-P5 still pending)', async () => {
    const store = makeMockStore()
    const registry = createProviderRegistry()
    registry.register('claude', dummyProvider, { displayName: 'Claude', canResume: () => true })
    const c = createConversationCoordinator({
      resolveProject: () => ({ alias: 'a', path: '/p' }),
      manager: { acquire: vi.fn() },
      conversationStore: store,
      registry,
      defaultProviderId: 'claude',
      format: () => 'x',
      log: () => {},
    })
    for (const m of [
      { kind: 'primary_tool' as const, primary: 'claude' },
      { kind: 'chatroom' as const },
    ]) {
      store.set('chat-x', m)
      await expect(c.dispatch(inbound('chat-x', 'hi'))).rejects.toBeInstanceOf(ModeNotImplementedError)
    }
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
      const sendAssistantText = vi.fn(async () => {})
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
      const acquire = vi.fn(async () => ({
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
      const sendAssistantText = vi.fn(async () => {})
      const c = createConversationCoordinator({
        resolveProject: () => ({ alias: 'a', path: '/p' }),
        manager: { acquire },
        conversationStore: store,
        registry,
        defaultProviderId: 'alice',
        parallelProviders: ['alice', 'bob'],
        format: () => 'x',
        sendAssistantText,
        log: () => {},
      })
      await c.dispatch(inbound('chat-1', 'hi'))
      const sent = sendAssistantText.mock.calls.map(([, t]) => t).sort()
      expect(sent).toEqual(['[Alice] hi from alice', '[Bob] hi from bob'])
    })
  })
})
