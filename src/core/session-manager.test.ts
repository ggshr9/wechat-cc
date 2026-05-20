import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SessionManager } from './session-manager'
import { createClaudeAgentProvider } from './claude-agent-provider'
import { createProviderRegistry, type ProviderRegistry } from './provider-registry'
import { makeFakeSession } from './test-helpers'
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
    const spawn = vi.fn(async () => {
      const session = makeFakeSession({
        events: [{ kind: 'result', sessionId: '_', numTurns: 1, durationMs: 0 }],
        onDispatch: text => dispatched.push(text),
      })
      const origClose = session.close.bind(session)
      session.close = async () => { close(); await origClose() }
      return session
    })

    const mgr = new SessionManager({
      maxConcurrent: 4,
      idleEvictMs: 60_000,
      registry: registryWithProvider({ spawn } as unknown as AgentProvider),
    })

    const h = await mgr.acquire('codex-proj', '/repo', 'claude')
    // drain the iterable to trigger onDispatch spy
    for await (const _ of h.dispatch('hello codex')) { /* consume */ }

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
        return makeFakeSession({
          events: [{ kind: 'result', sessionId: '_', numTurns: 1, durationMs: 0 }],
        })
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
    // fakeQuery yields a result event per message so each dispatch can complete.
    fakeQuery.mockImplementation((params: any) => {
      const iter = params.prompt as AsyncIterable<SDKUserMessage>
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        let turn = 0
        for await (const m of iter) {
          const content: any = m.message?.content
          const text = Array.isArray(content) ? content.map((b: any) => b.text ?? '').join('') : content
          seen.push(text)
          // Yield a result event so each dispatch() call completes and the
          // next dispatch() can be issued without hitting the "in-flight" guard.
          yield { type: 'result', subtype: 'success', session_id: `sid-${++turn}`, num_turns: turn, duration_ms: 1 } as unknown as SDKMessage
        }
      }
      const q = gen() as unknown as Query
      ;(q as any).interrupt = vi.fn()
      ;(q as any).close = vi.fn()
      return q
    })

    const mgr = new SessionManager({
      maxConcurrent: 4,
      idleEvictMs: 60_000,
      registry: singleClaudeRegistry(() => ({ cwd: '/tmp/x' } as Options)),
    })
    const h = await mgr.acquire('a', '/tmp/x', 'claude')
    // Dispatch sequentially — each must complete before the next can start
    // (claude provider throws if a previous dispatch is still in flight).
    for await (const _ of h.dispatch('first')) { /* consume */ }
    for await (const _ of h.dispatch('second')) { /* consume */ }
    expect(seen).toEqual(['first', 'second'])
    await mgr.shutdown()
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

  it('isInFlight reflects active dispatch iterator state', async () => {
    // Companion ticks consult isInFlight before running so they don't
    // contend with a user-initiated dispatch on the same session. The
    // counter is maintained by the SessionManager's dispatch wrapper.
    type ResolveNext = (v: IteratorResult<unknown>) => void
    const pending: ResolveNext[] = []
    const buffered: unknown[] = []
    let ended = false
    function push(ev: unknown) {
      const r = pending.shift()
      if (r) r({ value: ev, done: false })
      else buffered.push(ev)
    }
    function end() {
      ended = true
      while (pending.length > 0) {
        const r = pending.shift()!
        r({ value: undefined, done: true })
      }
    }
    const session = {
      dispatch() {
        return {
          [Symbol.asyncIterator]() {
            return {
              next() {
                if (buffered.length > 0) return Promise.resolve({ value: buffered.shift(), done: false }) as Promise<IteratorResult<unknown>>
                if (ended) return Promise.resolve({ value: undefined, done: true }) as Promise<IteratorResult<unknown>>
                return new Promise<IteratorResult<unknown>>(r => pending.push(r))
              },
            }
          },
        }
      },
      async close() {},
    }
    const spawn = vi.fn(async () => session as never)
    const mgr = new SessionManager({
      maxConcurrent: 10,
      idleEvictMs: 60_000,
      registry: registryWithProvider({ spawn } as unknown as AgentProvider),
    })

    // No session yet → false.
    expect(mgr.isInFlight('a', 'claude')).toBe(false)
    const h = await mgr.acquire('a', '/p', 'claude')
    // Session acquired, no dispatch in flight → still false.
    expect(mgr.isInFlight('a', 'claude')).toBe(false)

    // Begin a dispatch and consume one event so the iterator's finally
    // block hasn't fired yet.
    const iter = h.dispatch('hi')[Symbol.asyncIterator]()
    const firstPromise = iter.next()
    push({ kind: 'init', sessionId: 's1' })
    await firstPromise
    expect(mgr.isInFlight('a', 'claude')).toBe(true)

    // Finish the turn → counter decrements via the wrapper's finally.
    const pendingNext = iter.next()
    push({ kind: 'result', sessionId: 's1', numTurns: 1, durationMs: 0 })
    await pendingNext
    end()
    while (true) {
      const r = await iter.next()
      if (r.done) break
    }
    expect(mgr.isInFlight('a', 'claude')).toBe(false)

    // Different (alias, provider) is unaffected.
    expect(mgr.isInFlight('a', 'codex')).toBe(false)
    expect(mgr.isInFlight('b', 'claude')).toBe(false)

    await mgr.shutdown()
  })

  it('sweepIdle leaves a session alone while a dispatch is still in flight', async () => {
    // Without this guard, a long-running turn (e.g. claude doing heavy tool
    // work for 30+ min) gets killed mid-stream when lastUsedAt looks idle.
    // The dispatch's collectTurn never sees a `result` event and the user
    // ends up with a truncated reply.
    vi.useFakeTimers()
    let closeCount = 0
    type ResolveNext = (v: IteratorResult<unknown>) => void
    const pending: ResolveNext[] = []
    const buffered: unknown[] = []
    let ended = false
    function push(ev: unknown) {
      const r = pending.shift()
      if (r) r({ value: ev, done: false })
      else buffered.push(ev)
    }
    function end() {
      ended = true
      while (pending.length > 0) {
        const r = pending.shift()!
        r({ value: undefined, done: true })
      }
    }
    const stallableSession = {
      dispatch() {
        return {
          [Symbol.asyncIterator]() {
            return {
              next() {
                if (buffered.length > 0) return Promise.resolve({ value: buffered.shift(), done: false }) as Promise<IteratorResult<unknown>>
                if (ended) return Promise.resolve({ value: undefined, done: true }) as Promise<IteratorResult<unknown>>
                return new Promise<IteratorResult<unknown>>(r => pending.push(r))
              },
            }
          },
        }
      },
      async close() { closeCount++ },
    }
    const spawn = vi.fn(async () => stallableSession as never)
    const mgr = new SessionManager({
      maxConcurrent: 10,
      idleEvictMs: 1000,
      registry: registryWithProvider({ spawn } as unknown as AgentProvider),
    })
    const h = await mgr.acquire('a', '/p', 'claude')

    // Begin draining — consume one event then PAUSE before the result.
    const drained: unknown[] = []
    const iter = h.dispatch('hi')[Symbol.asyncIterator]()
    const firstPromise = iter.next()
    push({ kind: 'init', sessionId: 's1' })
    drained.push((await firstPromise).value)
    // Iterator now awaiting next event — dispatch is in flight.
    const pendingNext = iter.next()

    // Advance well past the idle threshold and try to sweep.
    vi.advanceTimersByTime(60_000)
    await mgr.sweepIdle()
    expect(closeCount).toBe(0)
    expect(mgr.list()).toHaveLength(1)

    // Finish the turn — sweep should now release.
    push({ kind: 'result', sessionId: 's1', numTurns: 1, durationMs: 0 })
    await pendingNext
    end()
    // Drain remainder (the wrapper's `for await` may still need to finalize).
    while (true) {
      const r = await iter.next()
      drained.push(r.value)
      if (r.done) break
    }

    vi.advanceTimersByTime(60_000)
    await mgr.sweepIdle()
    expect(closeCount).toBe(1)
    expect(mgr.list()).toEqual([])
    vi.useRealTimers()
  })

  it('release() during an in-flight dispatch propagates close to the wrapper iterator (counter does not strand)', async () => {
    // Contract: providers MUST propagate their session.close() to the
    // dispatch iterator (so an awaited inner.next() resolves with done).
    // Without that, the SessionManager wrapper's `finally` never runs and
    // the in-flight counter is stranded at 1, defeating sweepIdle forever
    // for that key. claude/codex providers both satisfy this today (claude
    // via activeEventQueue.end(), codex via aborter.abort()); this test
    // pins the contract so a future provider rewrite that violates it gets
    // caught here instead of in production via a hung daemon.
    let closeCount = 0
    type ResolveNext = (v: IteratorResult<unknown>) => void
    const pending: ResolveNext[] = []
    const buffered: unknown[] = []
    let ended = false
    function push(ev: unknown) {
      const r = pending.shift()
      if (r) r({ value: ev, done: false })
      else buffered.push(ev)
    }
    function end() {
      ended = true
      while (pending.length > 0) {
        const r = pending.shift()!
        r({ value: undefined, done: true })
      }
    }
    const session = {
      dispatch() {
        return {
          [Symbol.asyncIterator]() {
            return {
              next() {
                if (buffered.length > 0) return Promise.resolve({ value: buffered.shift(), done: false }) as Promise<IteratorResult<unknown>>
                if (ended) return Promise.resolve({ value: undefined, done: true }) as Promise<IteratorResult<unknown>>
                return new Promise<IteratorResult<unknown>>(r => pending.push(r))
              },
            }
          },
        }
      },
      async close() {
        closeCount++
        // The contract: close() unblocks any in-flight dispatch iterator.
        end()
      },
    }
    const mgr = new SessionManager({
      maxConcurrent: 10,
      idleEvictMs: 1000,
      registry: registryWithProvider({ async spawn() { return session as never } } as unknown as AgentProvider),
    })
    const h = await mgr.acquire('a', '/p', 'claude')
    const iter = h.dispatch('hi')[Symbol.asyncIterator]()
    const firstPromise = iter.next()
    push({ kind: 'init', sessionId: 's1' })
    await firstPromise
    // Wrapper now awaiting next event — dispatch is in flight.
    const pendingNext = iter.next()

    await mgr.release('a', 'claude')
    // close() above triggered end(), so the wrapper's `for await` resolves
    // its inner.next() with done=true and finally fires.
    const result = await pendingNext
    expect(result.done).toBe(true)
    expect(closeCount).toBe(1)

    // The crucial assertion: the counter is now clean. Re-acquire (which
    // spawns a fresh session under the same key) followed by a quick sweep
    // proves the slot isn't stranded — if the previous wrapper's finally
    // hadn't run, the counter would still be 1 and the new session would
    // be untouchable by sweepIdle even when it's idle.
    vi.useFakeTimers()
    const h2 = await mgr.acquire('a', '/p', 'claude')
    // h2 has had a dispatch wrapper applied lazily; never called .dispatch
    // so its counter is 0 from inception. Advance time past idleEvictMs.
    vi.advanceTimersByTime(60_000)
    await mgr.sweepIdle()
    expect(mgr.list()).toEqual([])
    expect(h2).toBeDefined()
    vi.useRealTimers()
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
        deleteOne: vi.fn((alias: string, provider: string) => {
          if (data[alias]?.provider === provider) delete data[alias]
        }),
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
      // Stale-cleanup must target only the active provider's row, not
      // sibling rows (e.g. a still-valid codex row for the same alias).
      expect(store.deleteOne).toHaveBeenCalledWith('compass', 'claude')
      expect(store.delete).not.toHaveBeenCalled()
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
      expect(store.deleteOne).toHaveBeenCalledWith('compass', 'claude')
      expect(store.delete).not.toHaveBeenCalled()
      await mgr.shutdown()
    })

    it('stale resume on one provider does not wipe sibling provider row', async () => {
      const ancient = new Date(Date.now() - 8 * 24 * 60 * 60_000).toISOString()
      const store = makeMockStore({
        compass: { session_id: 'sid-old-codex', last_used_at: ancient, provider: 'codex' },
      })
      // The codex row is stale. Acquire on the SAME alias under claude
      // — must NOT touch the codex row (different provider, miss on get,
      // no delete invoked).
      const mgr = new SessionManager({
        maxConcurrent: 4,
        idleEvictMs: 60_000,
        registry: singleClaudeRegistry((_alias, path) => ({ cwd: path } as Options)),
        sessionStore: store,
        resumeTTLMs: 7 * 24 * 60 * 60_000,
      })
      await mgr.acquire('compass', '/p', 'claude')
      expect(store.deleteOne).not.toHaveBeenCalled()
      expect(store.delete).not.toHaveBeenCalled()
      // Sibling row still intact.
      expect(store.get('compass', 'codex')?.session_id).toBe('sid-old-codex')
      await mgr.shutdown()
    })

    it('persists session_id on result message', async () => {
      const store = makeMockStore()
      // Fake query that waits for a prompt message then yields a result event.
      fakeQuery.mockImplementation((params: any) => {
        const iter = params.prompt as AsyncIterable<SDKUserMessage>
        async function* gen(): AsyncGenerator<SDKMessage, void> {
          // Consume one prompt message, then yield a result
          for await (const _ of iter) {
            yield { type: 'result', subtype: 'success', session_id: 'sid-new', num_turns: 1, duration_ms: 100 } as unknown as SDKMessage
            return
          }
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
      const h = await mgr.acquire('compass', '/p', 'claude')
      // Dispatch and drain so the result event is processed and session_id persisted.
      for await (const _ of h.dispatch('test')) { /* consume result */ }
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
  return makeFakeSession({
    events: [{ kind: 'result', sessionId: '_', numTurns: 1, durationMs: 0 }],
  })
}
