import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SessionManager } from './session-manager'
import { createClaudeAgentProvider } from './claude-agent-provider'
import { createProviderRegistry, type ProviderRegistry } from './provider-registry'
import type { AgentProvider } from './agent-provider'
import type { Options, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'

// Module-level spy injected via vi.mock so SessionManager uses our fake query()
const fakeQuery = vi.fn()
vi.mock('@anthropic-ai/claude-agent-sdk', async () => {
  return {
    query: (params: unknown) => fakeQuery(params),
  }
})

function makeFakeQuery(): Query {
  async function* gen(): AsyncGenerator<SDKMessage, void> {
    // never yields on its own — caller pushes messages, test asserts receipt
    await new Promise(() => {})
  }
  const q = gen() as unknown as Query
  ;(q as any).interrupt = vi.fn()
  ;(q as any).close = vi.fn()
  return q
}

beforeEach(() => {
  fakeQuery.mockReset()
  fakeQuery.mockImplementation(() => makeFakeQuery())
})

/**
 * Build a registry with a single `claude` provider. Most tests use this
 * shorthand because they pre-date P2's multi-provider model and only
 * need to assert single-provider behaviour. The newer per-acquire
 * providerId argument is exercised explicitly in the dedicated test.
 */
function singleClaudeRegistry(
  sdkOptionsForProject: (alias: string, path: string) => Options,
  canResume: (cwd: string, sessionId: string) => boolean = () => true,
): ProviderRegistry {
  const r = createProviderRegistry()
  r.register('claude', createClaudeAgentProvider({ sdkOptionsForProject }), {
    displayName: 'Claude',
    canResume,
  })
  return r
}

function registryWithProvider(provider: AgentProvider, canResume: (cwd: string, sessionId: string) => boolean = () => true): ProviderRegistry {
  const r = createProviderRegistry()
  r.register('claude', provider, { displayName: 'Claude', canResume })
  return r
}

function firstQueryArgs(): any {
  return fakeQuery.mock.calls[0]![0] as any
}

describe('SessionManager', () => {
  it('uses an injected agent provider to spawn and dispatch project sessions', async () => {
    const dispatched: string[] = []
    const close = vi.fn()
    const spawn = vi.fn(async () => ({
      dispatch: async (text: string) => { dispatched.push(text); return { assistantText: [], replyToolCalled: false } },
      close,
      onAssistantText: () => () => {},
      onResult: () => () => {},
    }))

    const mgr = new SessionManager({
      maxConcurrent: 4,
      idleEvictMs: 60_000,
      registry: registryWithProvider({ spawn } as unknown as AgentProvider),
    })

    const h = await mgr.acquire('codex-proj', '/repo', 'claude')
    await h.dispatch('hello codex')

    expect(spawn).toHaveBeenCalledWith({ alias: 'codex-proj', path: '/repo' })
    expect(dispatched).toEqual(['hello codex'])
    await mgr.shutdown()
    expect(close).toHaveBeenCalledOnce()
  })

  it('does not spawn until acquire() is called', async () => {
    const mgr = new SessionManager({
      maxConcurrent: 4,
      idleEvictMs: 60_000,
      registry: singleClaudeRegistry(() => ({ cwd: '/tmp/x' } as Options)),
    })
    expect(fakeQuery).not.toHaveBeenCalled()
    expect(mgr.list()).toEqual([])
    await mgr.shutdown()
  })

  it('lazy-spawns on first acquire, reuses on second', async () => {
    const mgr = new SessionManager({
      maxConcurrent: 4,
      idleEvictMs: 60_000,
      registry: singleClaudeRegistry((_alias, path) => ({ cwd: path } as Options)),
    })
    const a = await mgr.acquire('proj-a', '/home/nate/proj-a', 'claude')
    expect(fakeQuery).toHaveBeenCalledTimes(1)
    const a2 = await mgr.acquire('proj-a', '/home/nate/proj-a', 'claude')
    expect(a).toBe(a2)
    expect(fakeQuery).toHaveBeenCalledTimes(1)
    await mgr.shutdown()
  })

  it('dedupes concurrent acquires on same (provider, alias) (no double-spawn)', async () => {
    let spawnCount = 0
    const provider = {
      async spawn(_proj: any) {
        spawnCount++
        await new Promise(r => setTimeout(r, 30))
        return {
          dispatch: async () => ({ assistantText: [], replyToolCalled: false }),
          close: async () => {},
          onAssistantText: () => () => {},
          onResult: () => () => {},
        }
      },
    } as unknown as AgentProvider
    const mgr = new SessionManager({
      maxConcurrent: 4,
      idleEvictMs: 60_000,
      registry: registryWithProvider(provider),
    })
    const [h1, h2] = await Promise.all([
      mgr.acquire('shared', '/p', 'claude'),
      mgr.acquire('shared', '/p', 'claude'),
    ])
    expect(spawnCount).toBe(1)
    expect(h1).toBe(h2)
    await mgr.shutdown()
  })

  it('dispatch pushes messages in order into the prompt iterable', async () => {
    const seen: string[] = []
    fakeQuery.mockImplementation((params: any) => {
      const iter = params.prompt as AsyncIterable<SDKUserMessage>
      ;(async () => {
        for await (const m of iter) {
          const content: any = m.message?.content
          const text = Array.isArray(content) ? content.map((b: any) => b.text ?? '').join('') : content
          seen.push(text)
        }
      })().catch(() => {})
      return makeFakeQuery()
    })

    const mgr = new SessionManager({
      maxConcurrent: 4,
      idleEvictMs: 60_000,
      registry: singleClaudeRegistry(() => ({ cwd: '/tmp/x' } as Options)),
    })
    const h = await mgr.acquire('a', '/tmp/x', 'claude')
    const p1 = h.dispatch('first').catch(() => undefined)
    const p2 = h.dispatch('second').catch(() => undefined)
    await new Promise(r => setTimeout(r, 10))
    expect(seen).toEqual(['first', 'second'])
    await mgr.shutdown()
    await Promise.all([p1, p2])
  })

  it('evicts least-recently-used when capacity exceeded', async () => {
    const mgr = new SessionManager({
      maxConcurrent: 2,
      idleEvictMs: 60_000,
      registry: singleClaudeRegistry(() => ({ cwd: '/tmp/x' } as Options)),
    })
    await mgr.acquire('a', '/a', 'claude')
    await mgr.acquire('b', '/b', 'claude')
    await new Promise(r => setTimeout(r, 2))
    const handleA = await mgr.acquire('a', '/a', 'claude')
    expect(handleA.alias).toBe('a')
    await mgr.acquire('c', '/c', 'claude')
    const aliases = mgr.list().map(s => s.alias).sort()
    expect(aliases).toEqual(['a', 'c'])
    await mgr.shutdown()
  })

  it('evicts idle sessions past idleEvictMs', async () => {
    vi.useFakeTimers()
    const mgr = new SessionManager({
      maxConcurrent: 10,
      idleEvictMs: 1000,
      registry: singleClaudeRegistry(() => ({ cwd: '/tmp/x' } as Options)),
    })
    await mgr.acquire('a', '/a', 'claude')
    vi.advanceTimersByTime(2000)
    await mgr.sweepIdle()
    expect(mgr.list()).toEqual([])
    vi.useRealTimers()
    await mgr.shutdown()
  })

  it('keeps independent sessions for the same alias under different providers (P2 multi-provider)', async () => {
    let claudeSpawn = 0
    let codexSpawn = 0
    const claude = { async spawn() { claudeSpawn++; return mockSession() } } as unknown as AgentProvider
    const codex = { async spawn() { codexSpawn++; return mockSession() } } as unknown as AgentProvider
    const r = createProviderRegistry()
    r.register('claude', claude, { displayName: 'Claude', canResume: () => true })
    r.register('codex', codex, { displayName: 'Codex', canResume: () => true })
    const mgr = new SessionManager({ maxConcurrent: 4, idleEvictMs: 60_000, registry: r })

    const a = await mgr.acquire('compass', '/p', 'claude')
    const b = await mgr.acquire('compass', '/p', 'codex')
    expect(a).not.toBe(b)
    expect(a.providerId).toBe('claude')
    expect(b.providerId).toBe('codex')
    expect(claudeSpawn).toBe(1)
    expect(codexSpawn).toBe(1)
    expect(mgr.list()).toHaveLength(2)
    await mgr.shutdown()
  })

  it('throws on acquire with unknown providerId', async () => {
    const mgr = new SessionManager({
      maxConcurrent: 4, idleEvictMs: 60_000,
      registry: singleClaudeRegistry(() => ({ cwd: '/' } as Options)),
    })
    await expect(mgr.acquire('a', '/p', 'gemini')).rejects.toThrow(/unknown provider: gemini/)
    await mgr.shutdown()
  })

  describe('session resume', () => {
    type MockRec = { session_id: string; last_used_at: string; provider: string }
    // Test helper: SessionStore.provider is required as of PR7.8 — accept
    // partial seeds without provider here and default to 'claude' so the
    // existing tests stay terse. Real callers always pass provider.
    function makeMockStore(initial: Record<string, { session_id: string; last_used_at: string; provider?: string }> = {}) {
      const data: Record<string, MockRec> = {}
      for (const [k, v] of Object.entries(initial)) {
        data[k] = { ...v, provider: v.provider ?? 'claude' }
      }
      return {
        get: (alias: string, expectedProvider?: string): MockRec | null => {
          const rec = data[alias]
          if (!rec) return null
          if (expectedProvider && rec.provider !== expectedProvider) return null
          return rec
        },
        set: vi.fn((alias: string, sid: string, provider: string) => {
          data[alias] = { session_id: sid, last_used_at: new Date().toISOString(), provider }
        }),
        setSummary: vi.fn(),
        delete: vi.fn((alias: string) => { delete data[alias] }),
        all: () => ({ ...data }),
        flush: async () => {},
      }
    }

    it('passes resume when store has recent record and canResume passes', async () => {
      const store = makeMockStore({
        compass: { session_id: 'sid-abc', last_used_at: new Date().toISOString() },
      })
      const canResume = vi.fn().mockReturnValue(true)
      const mgr = new SessionManager({
        maxConcurrent: 4,
        idleEvictMs: 60_000,
        registry: singleClaudeRegistry((_alias, path) => ({ cwd: path } as Options), canResume),
        sessionStore: store,
      })
      await mgr.acquire('compass', '/p', 'claude')
      expect(fakeQuery).toHaveBeenCalledOnce()
      const args = firstQueryArgs()
      expect(args.options.resume).toBe('sid-abc')
      expect(canResume).toHaveBeenCalledWith('/p', 'sid-abc')
      await mgr.shutdown()
    })

    it('skips resume + deletes stale record past TTL', async () => {
      const ancient = new Date(Date.now() - 8 * 24 * 60 * 60_000).toISOString()
      const store = makeMockStore({
        compass: { session_id: 'sid-old', last_used_at: ancient },
      })
      const mgr = new SessionManager({
        maxConcurrent: 4,
        idleEvictMs: 60_000,
        registry: singleClaudeRegistry((_alias, path) => ({ cwd: path } as Options)),
        sessionStore: store,
        resumeTTLMs: 7 * 24 * 60 * 60_000,
      })
      await mgr.acquire('compass', '/p', 'claude')
      const args = firstQueryArgs()
      expect(args.options.resume).toBeUndefined()
      expect(store.delete).toHaveBeenCalledWith('compass')
      await mgr.shutdown()
    })

    it('skips resume when canResume returns false (jsonl missing)', async () => {
      const store = makeMockStore({
        compass: { session_id: 'sid-gone', last_used_at: new Date().toISOString() },
      })
      const canResume = vi.fn().mockReturnValue(false)
      const mgr = new SessionManager({
        maxConcurrent: 4,
        idleEvictMs: 60_000,
        registry: singleClaudeRegistry((_alias, path) => ({ cwd: path } as Options), canResume),
        sessionStore: store,
      })
      await mgr.acquire('compass', '/p', 'claude')
      const args = firstQueryArgs()
      expect(args.options.resume).toBeUndefined()
      expect(store.delete).toHaveBeenCalledWith('compass')
      await mgr.shutdown()
    })

    it('persists session_id on result message', async () => {
      const store = makeMockStore()
      // Fake query that yields a result event
      fakeQuery.mockImplementation(() => {
        async function* gen(): AsyncGenerator<SDKMessage, void> {
          yield { type: 'result', subtype: 'success', session_id: 'sid-new', num_turns: 1, duration_ms: 100 } as unknown as SDKMessage
          await new Promise(() => {})
        }
        const q = gen() as unknown as Query
        ;(q as any).interrupt = vi.fn()
        ;(q as any).close = vi.fn()
        return q
      })
      const mgr = new SessionManager({
        maxConcurrent: 4,
        idleEvictMs: 60_000,
        registry: singleClaudeRegistry(() => ({ cwd: '/p' } as Options)),
        sessionStore: store,
      })
      await mgr.acquire('compass', '/p', 'claude')
      await new Promise(r => setTimeout(r, 10))
      expect(store.set).toHaveBeenCalledWith('compass', 'sid-new', 'claude')
      await mgr.shutdown()
    })

    it('works without sessionStore (feature opt-in)', async () => {
      const mgr = new SessionManager({
        maxConcurrent: 4,
        idleEvictMs: 60_000,
        registry: singleClaudeRegistry((_alias, path) => ({ cwd: path } as Options)),
        // sessionStore omitted
      })
      await mgr.acquire('proj', '/p', 'claude')
      const args = firstQueryArgs()
      expect(args.options.resume).toBeUndefined()
      await mgr.shutdown()
    })
  })
})

function mockSession() {
  return {
    dispatch: async () => ({ assistantText: [], replyToolCalled: false }),
    close: async () => {},
    onAssistantText: () => () => {},
    onResult: () => () => {},
  }
}
