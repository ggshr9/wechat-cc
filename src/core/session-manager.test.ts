import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SessionManager } from './session-manager'
import { createClaudeAgentProvider } from './claude-agent-provider'
import { createProviderRegistry, type ProviderRegistry } from './provider-registry'
import { makeFakeSession } from './test-helpers'
import type { AgentProvider } from './agent-provider'
import { TIER_PROFILES } from './user-tier'
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
  it('mints the session token ONCE per spawn (not per dispatch) and forwards it; invalidates on release + LRU evict', async () => {
    const minted: Array<{ tier: string; key: string }> = []
    const invalidated: string[] = []
    const seenTokens: Array<string | undefined> = []
    const spawn = vi.fn(async (_p: unknown, ctx: { mcpEnv?: Record<string, string> }) => {
      seenTokens.push(ctx.mcpEnv?.WECHAT_SESSION_TOKEN)
      return makeFakeSession({ events: [{ kind: 'result', sessionId: '_', numTurns: 1, durationMs: 0 }] })
    })
    const mgr = new SessionManager({
      maxConcurrent: 1,
      idleEvictMs: 30 * 60_000,
      registry: registryWithProvider({ spawn } as unknown as AgentProvider),
      mintSessionToken: (tier, key) => { minted.push({ tier, key }); return `tok-${minted.length}` },
      invalidateSessionToken: (k) => invalidated.push(k),
    })
    // two acquires of the SAME session (cache hit on the 2nd) → mint ONCE
    const h1 = await mgr.acquire({ alias: 'a', path: '/p', providerId: 'claude', chatId: 'chat-1', tierProfile: TIER_PROFILES.admin, permissionMode: 'strict' })
    const h2 = await mgr.acquire({ alias: 'a', path: '/p', providerId: 'claude', chatId: 'chat-1', tierProfile: TIER_PROFILES.admin, permissionMode: 'strict' })
    expect(h2).toBe(h1) // cache hit
    expect(minted).toEqual([{ tier: 'admin', key: 'claude/a/chat-1' }]) // minted ONCE, not twice
    expect(seenTokens).toEqual(['tok-1']) // spawn ran once with the token
    // explicit release invalidates
    await mgr.release({ alias: 'a', providerId: 'claude', chatId: 'chat-1' })
    expect(invalidated).toContain('claude/a/chat-1')
    // LRU eviction (maxConcurrent=1) also invalidates
    await mgr.acquire({ alias: 'a', path: '/p', providerId: 'claude', chatId: 'chat-2', tierProfile: TIER_PROFILES.admin, permissionMode: 'strict' })
    await mgr.acquire({ alias: 'a', path: '/p', providerId: 'claude', chatId: 'chat-3', tierProfile: TIER_PROFILES.admin, permissionMode: 'strict' })
    expect(invalidated).toContain('claude/a/chat-2')
  })

  it('revokes the minted token when provider.spawn throws (no registry leak on the error path)', async () => {
    const minted: string[] = []
    const invalidated: string[] = []
    const spawn = vi.fn(async () => { throw new Error('spawn boom') })
    const mgr = new SessionManager({
      maxConcurrent: 4,
      idleEvictMs: 30 * 60_000,
      registry: registryWithProvider({ spawn } as unknown as AgentProvider),
      mintSessionToken: (_t, key) => { minted.push(key); return 'tok' },
      invalidateSessionToken: (key) => invalidated.push(key),
    })
    await expect(mgr.acquire({ alias: 'a', path: '/p', providerId: 'claude', chatId: 'chat-1', tierProfile: TIER_PROFILES.admin, permissionMode: 'strict' }))
      .rejects.toThrow('spawn boom')
    expect(minted).toEqual(['claude/a/chat-1'])      // it was minted
    expect(invalidated).toEqual(['claude/a/chat-1']) // ...and revoked on failure
  })

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

    const h = await mgr.acquire({ alias: 'codex-proj', path: '/repo', providerId: 'claude', chatId: '_legacy', tierProfile: TIER_PROFILES.admin, permissionMode: 'strict' })
    // drain the iterable to trigger onDispatch spy
    for await (const _ of h.dispatch('hello codex')) { /* consume */ }

    expect(spawn).toHaveBeenCalledWith(
      { alias: 'codex-proj', path: '/repo' },
      // Caller passes admin tier + chatId — provider gets both verbatim, plus
      // the daemon-computed mcpEnv overlay (always carries WECHAT_SESSION_TIER;
      // no WECHAT_SESSION_TOKEN here since no mintSessionToken is wired).
      { tierProfile: TIER_PROFILES.admin, permissionMode: 'strict', chatId: '_legacy', mcpEnv: { WECHAT_SESSION_TIER: 'admin' } },
    )
    expect(dispatched).toEqual(['hello codex'])
    await mgr.shutdown()
    expect(close).toHaveBeenCalledOnce()
  })

  it('forwards the buildInstructions thunk output as spawnOpts.appendInstructions (per provider + tier)', async () => {
    let seen: string | undefined
    const spawn = vi.fn(async (_p: unknown, ctx: { appendInstructions?: string }) => {
      seen = ctx.appendInstructions
      return makeFakeSession({ events: [{ kind: 'result', sessionId: '_', numTurns: 1, durationMs: 0 }] })
    })
    const calls: Array<{ providerId: string; tier: unknown }> = []
    const mgr = new SessionManager({
      maxConcurrent: 4,
      idleEvictMs: 60_000,
      registry: registryWithProvider({ spawn } as unknown as AgentProvider),
      // The daemon owns prompt assembly; session-manager just calls the thunk
      // once per spawn (mirroring mcpEnv) and forwards the result.
      buildInstructions: (providerId, tier) => { calls.push({ providerId, tier }); return `PROMPT[${providerId}]` },
    })
    await mgr.acquire({ alias: 'a', path: '/p', providerId: 'claude', chatId: 'c', tierProfile: TIER_PROFILES.admin, permissionMode: 'strict' })
    expect(seen).toBe('PROMPT[claude]')
    expect(calls).toEqual([{ providerId: 'claude', tier: TIER_PROFILES.admin }])
    await mgr.shutdown()
  })

  it('forwards currentModelFor(providerId) as spawnOpts.model (per-spawn model hot-reload)', async () => {
    let seen: string | undefined
    const spawn = vi.fn(async (_p: unknown, ctx: { model?: string }) => {
      seen = ctx.model
      return makeFakeSession({ events: [{ kind: 'result', sessionId: '_', numTurns: 1, durationMs: 0 }] })
    })
    const mgr = new SessionManager({
      maxConcurrent: 4,
      idleEvictMs: 60_000,
      registry: registryWithProvider({ spawn } as unknown as AgentProvider),
      // Daemon owns the pinned-model rule; session-manager reads it per spawn.
      currentModelFor: (providerId) => providerId === 'claude' ? 'claude-opus-4-8' : undefined,
    })
    await mgr.acquire({ alias: 'a', path: '/p', providerId: 'claude', chatId: 'c', tierProfile: TIER_PROFILES.admin, permissionMode: 'strict' })
    expect(seen).toBe('claude-opus-4-8')
    await mgr.shutdown()
  })

  it('omits model when currentModelFor returns undefined', async () => {
    let hadKey = true
    const spawn = vi.fn(async (_p: unknown, ctx: object) => {
      hadKey = 'model' in ctx
      return makeFakeSession({ events: [{ kind: 'result', sessionId: '_', numTurns: 1, durationMs: 0 }] })
    })
    const mgr = new SessionManager({
      maxConcurrent: 4,
      idleEvictMs: 60_000,
      registry: registryWithProvider({ spawn } as unknown as AgentProvider),
      currentModelFor: () => undefined,
    })
    await mgr.acquire({ alias: 'a', path: '/p', providerId: 'claude', chatId: 'c', tierProfile: TIER_PROFILES.admin, permissionMode: 'strict' })
    expect(hadKey).toBe(false)
    await mgr.shutdown()
  })

  it('omits appendInstructions entirely when no buildInstructions thunk is wired', async () => {
    let hadKey = true
    const spawn = vi.fn(async (_p: unknown, ctx: object) => {
      hadKey = 'appendInstructions' in ctx
      return makeFakeSession({ events: [{ kind: 'result', sessionId: '_', numTurns: 1, durationMs: 0 }] })
    })
    const mgr = new SessionManager({
      maxConcurrent: 4,
      idleEvictMs: 60_000,
      registry: registryWithProvider({ spawn } as unknown as AgentProvider),
    })
    await mgr.acquire({ alias: 'a', path: '/p', providerId: 'claude', chatId: 'c', tierProfile: TIER_PROFILES.admin, permissionMode: 'strict' })
    expect(hadKey).toBe(false)
    await mgr.shutdown()
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
    const a = await mgr.acquire({ alias: 'proj-a', path: '/home/nate/proj-a', providerId: 'claude', chatId: '_legacy', tierProfile: TIER_PROFILES.admin, permissionMode: 'strict' })
    expect(fakeQuery).toHaveBeenCalledTimes(1)
    const a2 = await mgr.acquire({ alias: 'proj-a', path: '/home/nate/proj-a', providerId: 'claude', chatId: '_legacy', tierProfile: TIER_PROFILES.admin, permissionMode: 'strict' })
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
      mgr.acquire({ alias: 'shared', path: '/p', providerId: 'claude', chatId: '_legacy', tierProfile: TIER_PROFILES.admin, permissionMode: 'strict' }),
      mgr.acquire({ alias: 'shared', path: '/p', providerId: 'claude', chatId: '_legacy', tierProfile: TIER_PROFILES.admin, permissionMode: 'strict' }),
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
    const h = await mgr.acquire({ alias: 'a', path: '/tmp/x', providerId: 'claude', chatId: '_legacy', tierProfile: TIER_PROFILES.admin, permissionMode: 'strict' })
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
    await mgr.acquire({ alias: 'a', path: '/a', providerId: 'claude', chatId: '_legacy', tierProfile: TIER_PROFILES.admin, permissionMode: 'strict' })
    await mgr.acquire({ alias: 'b', path: '/b', providerId: 'claude', chatId: '_legacy', tierProfile: TIER_PROFILES.admin, permissionMode: 'strict' })
    await new Promise(r => setTimeout(r, 2))
    const handleA = await mgr.acquire({ alias: 'a', path: '/a', providerId: 'claude', chatId: '_legacy', tierProfile: TIER_PROFILES.admin, permissionMode: 'strict' })
    expect(handleA.alias).toBe('a')
    await mgr.acquire({ alias: 'c', path: '/c', providerId: 'claude', chatId: '_legacy', tierProfile: TIER_PROFILES.admin, permissionMode: 'strict' })
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
    await mgr.acquire({ alias: 'a', path: '/a', providerId: 'claude', chatId: '_legacy', tierProfile: TIER_PROFILES.admin, permissionMode: 'strict' })
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
    expect(mgr.isInFlight({ alias: 'a', providerId: 'claude', chatId: '_legacy' })).toBe(false)
    const h = await mgr.acquire({ alias: 'a', path: '/p', providerId: 'claude', chatId: '_legacy', tierProfile: TIER_PROFILES.admin, permissionMode: 'strict' })
    // Session acquired, no dispatch in flight → still false.
    expect(mgr.isInFlight({ alias: 'a', providerId: 'claude', chatId: '_legacy' })).toBe(false)

    // Begin a dispatch and consume one event so the iterator's finally
    // block hasn't fired yet.
    const iter = h.dispatch('hi')[Symbol.asyncIterator]()
    const firstPromise = iter.next()
    push({ kind: 'init', sessionId: 's1' })
    await firstPromise
    expect(mgr.isInFlight({ alias: 'a', providerId: 'claude', chatId: '_legacy' })).toBe(true)

    // Finish the turn → counter decrements via the wrapper's finally.
    const pendingNext = iter.next()
    push({ kind: 'result', sessionId: 's1', numTurns: 1, durationMs: 0 })
    await pendingNext
    end()
    while (true) {
      const r = await iter.next()
      if (r.done) break
    }
    expect(mgr.isInFlight({ alias: 'a', providerId: 'claude', chatId: '_legacy' })).toBe(false)

    // Different (alias, provider, chatId) is unaffected.
    expect(mgr.isInFlight({ alias: 'a', providerId: 'codex', chatId: '_legacy' })).toBe(false)
    expect(mgr.isInFlight({ alias: 'b', providerId: 'claude', chatId: '_legacy' })).toBe(false)

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
    const h = await mgr.acquire({ alias: 'a', path: '/p', providerId: 'claude', chatId: '_legacy', tierProfile: TIER_PROFILES.admin, permissionMode: 'strict' })

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
    const h = await mgr.acquire({ alias: 'a', path: '/p', providerId: 'claude', chatId: '_legacy', tierProfile: TIER_PROFILES.admin, permissionMode: 'strict' })
    const iter = h.dispatch('hi')[Symbol.asyncIterator]()
    const firstPromise = iter.next()
    push({ kind: 'init', sessionId: 's1' })
    await firstPromise
    // Wrapper now awaiting next event — dispatch is in flight.
    const pendingNext = iter.next()

    await mgr.release({ alias: 'a', providerId: 'claude', chatId: '_legacy' })
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
    const h2 = await mgr.acquire({ alias: 'a', path: '/p', providerId: 'claude', chatId: '_legacy', tierProfile: TIER_PROFILES.admin, permissionMode: 'strict' })
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

    const a = await mgr.acquire({ alias: 'compass', path: '/p', providerId: 'claude', chatId: '_legacy', tierProfile: TIER_PROFILES.admin, permissionMode: 'strict' })
    const b = await mgr.acquire({ alias: 'compass', path: '/p', providerId: 'codex', chatId: '_legacy', tierProfile: TIER_PROFILES.admin, permissionMode: 'strict' })
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
    await expect(mgr.acquire({ alias: 'a', path: '/p', providerId: 'gemini', chatId: '_legacy', tierProfile: TIER_PROFILES.admin, permissionMode: 'strict' })).rejects.toThrow(/unknown provider: gemini/)
    await mgr.shutdown()
  })

  describe('session resume', () => {
    type MockRec = { alias: string; session_id: string; last_used_at: string; provider: string; chat_id: string }
    // Test helper: existing single-chat tests pass chatId='_legacy' as
    // the placeholder until Tasks 10/11 thread real chatIds through the
    // coordinator + tick-bodies. The mock mirrors that — seeds default
    // to provider='claude' and chatId='_legacy' so existing tests stay
    // terse.
    function makeMockStore(initial: Record<string, { session_id: string; last_used_at: string; provider?: string; chatId?: string }> = {}) {
      const data = new Map<string, MockRec>()
      const k = (alias: string, provider: string, chatId: string) => `${alias}|${provider}|${chatId}`
      for (const [alias, v] of Object.entries(initial)) {
        const provider = v.provider ?? 'claude'
        const chatId = v.chatId ?? '_legacy'
        data.set(k(alias, provider, chatId), {
          alias, session_id: v.session_id, last_used_at: v.last_used_at, provider, chat_id: chatId,
        })
      }
      return {
        get: vi.fn(({ alias, provider, chatId }: { alias: string; provider: string; chatId: string }): MockRec | null => {
          return data.get(k(alias, provider, chatId)) ?? null
        }),
        set: vi.fn(({ alias, provider, chatId, sessionId }: { alias: string; provider: string; chatId: string; sessionId: string }) => {
          data.set(k(alias, provider, chatId), {
            alias, session_id: sessionId, last_used_at: new Date().toISOString(), provider, chat_id: chatId,
          })
        }),
        setSummary: vi.fn(),
        delete: vi.fn(({ alias, chatId }: { alias: string; chatId: string }) => {
          for (const [mapKey, rec] of data) {
            if (rec.alias === alias && rec.chat_id === chatId) data.delete(mapKey)
          }
        }),
        deleteOne: vi.fn(({ alias, provider, chatId }: { alias: string; provider: string; chatId: string }) => {
          data.delete(k(alias, provider, chatId))
        }),
        all: () => Object.fromEntries(data),
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
      await mgr.acquire({ alias: 'compass', path: '/p', providerId: 'claude', chatId: '_legacy', tierProfile: TIER_PROFILES.admin, permissionMode: 'strict' })
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
      await mgr.acquire({ alias: 'compass', path: '/p', providerId: 'claude', chatId: '_legacy', tierProfile: TIER_PROFILES.admin, permissionMode: 'strict' })
      const args = firstQueryArgs()
      expect(args.options.resume).toBeUndefined()
      // Stale-cleanup must target only the active provider's row, not
      // sibling rows (e.g. a still-valid codex row for the same alias).
      expect(store.deleteOne).toHaveBeenCalledWith({ alias: 'compass', provider: 'claude', chatId: '_legacy' })
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
      await mgr.acquire({ alias: 'compass', path: '/p', providerId: 'claude', chatId: '_legacy', tierProfile: TIER_PROFILES.admin, permissionMode: 'strict' })
      const args = firstQueryArgs()
      expect(args.options.resume).toBeUndefined()
      expect(store.deleteOne).toHaveBeenCalledWith({ alias: 'compass', provider: 'claude', chatId: '_legacy' })
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
      await mgr.acquire({ alias: 'compass', path: '/p', providerId: 'claude', chatId: '_legacy', tierProfile: TIER_PROFILES.admin, permissionMode: 'strict' })
      expect(store.deleteOne).not.toHaveBeenCalled()
      expect(store.delete).not.toHaveBeenCalled()
      // Sibling row still intact.
      expect(store.get({ alias: 'compass', provider: 'codex', chatId: '_legacy' })?.session_id).toBe('sid-old-codex')
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
      const h = await mgr.acquire({ alias: 'compass', path: '/p', providerId: 'claude', chatId: '_legacy', tierProfile: TIER_PROFILES.admin, permissionMode: 'strict' })
      // Dispatch and drain so the result event is processed and session_id persisted.
      for await (const _ of h.dispatch('test')) { /* consume result */ }
      expect(store.set).toHaveBeenCalledWith({ alias: 'compass', provider: 'claude', chatId: '_legacy', sessionId: 'sid-new' })
      await mgr.shutdown()
    })

    it('works without sessionStore (feature opt-in)', async () => {
      const mgr = new SessionManager({
        maxConcurrent: 4,
        idleEvictMs: 60_000,
        registry: singleClaudeRegistry((_alias, path) => ({ cwd: path } as Options)),
        // sessionStore omitted
      })
      await mgr.acquire({ alias: 'proj', path: '/p', providerId: 'claude', chatId: '_legacy', tierProfile: TIER_PROFILES.admin, permissionMode: 'strict' })
      const args = firstQueryArgs()
      expect(args.options.resume).toBeUndefined()
      await mgr.shutdown()
    })
  })
})

describe('SessionManager — per-chat isolation', () => {
  // Two chats sharing the same (alias, provider) MUST hold independent
  // sessions. Without this, chat A's tier policy bleeds into chat B's
  // turn (admin sees a relay prompt the SDK already authorised for chat
  // B's admin caller), and the two chats also share a jsonl transcript
  // — admin gets to read guest history wholesale. Per-chat isolation
  // forces both axes apart at the SessionManager layer.
  it('acquire on same alias+provider but different chatId returns DIFFERENT handles', async () => {
    let spawnCount = 0
    const provider = {
      async spawn() {
        spawnCount++
        return mockSession()
      },
    } as unknown as AgentProvider
    const mgr = new SessionManager({
      maxConcurrent: 4,
      idleEvictMs: 60_000,
      registry: registryWithProvider(provider),
    })
    const h1 = await mgr.acquire({ alias: '_default', path: '/tmp/x', providerId: 'claude', chatId: 'chatA', tierProfile: TIER_PROFILES.admin, permissionMode: 'strict' })
    const h2 = await mgr.acquire({ alias: '_default', path: '/tmp/x', providerId: 'claude', chatId: 'chatB', tierProfile: TIER_PROFILES.admin, permissionMode: 'strict' })
    expect(h1).not.toBe(h2)
    expect(spawnCount).toBe(2)
    expect(mgr.list()).toHaveLength(2)
    await mgr.shutdown()
  })

  it('acquire on same triple returns CACHED handle', async () => {
    let spawnCount = 0
    const provider = {
      async spawn() {
        spawnCount++
        return mockSession()
      },
    } as unknown as AgentProvider
    const mgr = new SessionManager({
      maxConcurrent: 4,
      idleEvictMs: 60_000,
      registry: registryWithProvider(provider),
    })
    const h1 = await mgr.acquire({ alias: '_default', path: '/tmp/x', providerId: 'claude', chatId: 'chatA', tierProfile: TIER_PROFILES.admin, permissionMode: 'strict' })
    const h2 = await mgr.acquire({ alias: '_default', path: '/tmp/x', providerId: 'claude', chatId: 'chatA', tierProfile: TIER_PROFILES.admin, permissionMode: 'strict' })
    expect(h1).toBe(h2)
    expect(spawnCount).toBe(1)
    await mgr.shutdown()
  })

  it('isInFlight is keyed by triple', async () => {
    // A dispatch in flight for chatA does NOT mask the slot for chatB —
    // the pushTick gate in tick-bodies relies on this so a companion
    // push to default chat doesn't get suppressed by an unrelated chat's
    // ongoing turn.
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
    const mgr = new SessionManager({
      maxConcurrent: 4,
      idleEvictMs: 60_000,
      registry: registryWithProvider({ async spawn() { return session as never } } as unknown as AgentProvider),
    })
    const h = await mgr.acquire({ alias: '_default', path: '/tmp/x', providerId: 'claude', chatId: 'chatA', tierProfile: TIER_PROFILES.admin, permissionMode: 'strict' })
    const it = h.dispatch('hi')[Symbol.asyncIterator]()
    // Kick the iterator forward one event so the wrapper's `try` block
    // is active and the in-flight counter is incremented.
    const firstPromise = it.next()
    push({ kind: 'init', sessionId: 's1' })
    await firstPromise
    expect(mgr.isInFlight({ alias: '_default', providerId: 'claude', chatId: 'chatA' })).toBe(true)
    expect(mgr.isInFlight({ alias: '_default', providerId: 'claude', chatId: 'chatB' })).toBe(false)
    // Drain so the wrapper's finally fires and the test doesn't leak.
    end()
    while (true) {
      const r = await it.next()
      if (r.done) break
    }
    await mgr.shutdown()
  })
})

function mockSession() {
  return makeFakeSession({
    events: [{ kind: 'result', sessionId: '_', numTurns: 1, durationMs: 0 }],
  })
}
