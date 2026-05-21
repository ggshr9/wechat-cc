import { describe, expect, it, vi } from 'vitest'
import type { Codex, Thread, ThreadEvent, ThreadOptions } from '@openai/codex-sdk'
import { createCodexAgentProvider, type CodexFactory } from './codex-agent-provider'
import type { AgentEvent } from './agent-provider'

/**
 * Tests for codex-agent-provider (yield-event shape). Uses an injected
 * `codexFactory` to swap the real Codex SDK (which would spawn the codex CLI)
 * for a fake. The fake exposes the same surface — startThread / resumeThread /
 * Thread.runStreamed / Thread.id — so we can assert:
 *
 *   1. spawn() routes resumeSessionId to resumeThread, fresh to startThread
 *   2. dispatch() yields AgentEvents in the correct sequence
 *   3. mcp_tool_call items yield tool_call events with server + tool
 *   4. turn.failed yields an error event
 *   5. stream-level error events yield an error event
 *   6. close() aborts any in-flight turn
 *   7. appendInstructions is prepended only on first dispatch
 *   8. ThreadOptions defaults match RFC 03 §10
 */

// Helper: drain an async iterable into an array for assertion.
async function drain(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = []
  for await (const ev of events) out.push(ev)
  return out
}

interface FakeRunRecord {
  input: string
  signal: AbortSignal | undefined
  events: ThreadEvent[]
}

interface FakeThread {
  id: string | null
  runStreamedCalls: FakeRunRecord[]
  runCalls: { input: string }[]
  pushTurn(events: ThreadEvent[]): void
  pushRunResult(items: unknown[]): void
}

interface FakeCodex {
  startThreadCalls: ThreadOptions[]
  resumeThreadCalls: { id: string; opts: ThreadOptions }[]
  thread: FakeThread
}

function makeFakeCodex(initialThreadId: string | null = null): { codex: Codex; fake: FakeCodex } {
  const queuedTurns: ThreadEvent[][] = []
  const queuedRunItems: unknown[][] = []
  const runStreamedCalls: FakeRunRecord[] = []
  const runCalls: { input: string }[] = []
  let threadId: string | null = initialThreadId

  const fakeThread: Thread = {
    get id(): string | null { return threadId },
    async run(input: unknown) {
      const inputStr = typeof input === 'string' ? input : JSON.stringify(input)
      runCalls.push({ input: inputStr })
      const items = queuedRunItems.shift() ?? []
      return { items } as unknown as ReturnType<Thread['run']>
    },
    async runStreamed(input: unknown, turnOptions?: { signal?: AbortSignal }) {
      const inputStr = typeof input === 'string' ? input : JSON.stringify(input)
      const events = queuedTurns.shift() ?? []
      runStreamedCalls.push({
        input: inputStr,
        signal: turnOptions?.signal,
        events,
      })
      // Capture thread.started's thread_id to mirror real SDK behaviour.
      for (const ev of events) if (ev.type === 'thread.started') threadId = ev.thread_id
      async function* gen(): AsyncGenerator<ThreadEvent> {
        for (const ev of events) yield ev
      }
      return { events: gen() }
    },
  } as unknown as Thread

  const fake: FakeCodex = {
    startThreadCalls: [],
    resumeThreadCalls: [],
    thread: {
      get id() { return threadId },
      runStreamedCalls,
      runCalls,
      pushTurn(events) { queuedTurns.push(events) },
      pushRunResult(items) { queuedRunItems.push(items) },
    },
  }

  const codex: Codex = {
    startThread(o?: ThreadOptions): Thread {
      fake.startThreadCalls.push(o ?? {})
      return fakeThread
    },
    resumeThread(id: string, o?: ThreadOptions): Thread {
      fake.resumeThreadCalls.push({ id, opts: o ?? {} })
      threadId = id
      return fakeThread
    },
  } as unknown as Codex

  return { codex, fake }
}

function provider(opts: Parameters<typeof createCodexAgentProvider>[0] = {}, fakeCodex?: { codex: Codex; fake: FakeCodex }) {
  const f = fakeCodex ?? makeFakeCodex()
  const factory: CodexFactory = () => f.codex
  return { provider: createCodexAgentProvider({ ...opts, codexFactory: factory }), fake: f.fake }
}

describe('Codex agent provider', () => {
  it('spawns a fresh thread by default with RFC-03 daemon-safe defaults', async () => {
    const { provider: p, fake } = provider()
    await p.spawn({ alias: 'compass', path: '/repo' })
    expect(fake.startThreadCalls).toHaveLength(1)
    const o = fake.startThreadCalls[0]!
    expect(o.workingDirectory).toBe('/repo')
    expect(o.skipGitRepoCheck).toBe(true)
    expect(o.sandboxMode).toBe('workspace-write')
    expect(o.approvalPolicy).toBe('never')
  })

  it('respects model / sandboxMode / approvalPolicy overrides', async () => {
    const { provider: p, fake } = provider({
      model: 'gpt-5-codex',
      sandboxMode: 'read-only',
      approvalPolicy: 'on-request',
    })
    await p.spawn({ alias: 'a', path: '/p' })
    const o = fake.startThreadCalls[0]!
    expect(o.model).toBe('gpt-5-codex')
    expect(o.sandboxMode).toBe('read-only')
    expect(o.approvalPolicy).toBe('on-request')
  })

  it('routes resumeSessionId to resumeThread, NOT startThread', async () => {
    const { provider: p, fake } = provider()
    await p.spawn({ alias: 'compass', path: '/repo' }, { resumeSessionId: 'thread-xyz' })
    expect(fake.startThreadCalls).toHaveLength(0)
    expect(fake.resumeThreadCalls).toHaveLength(1)
    expect(fake.resumeThreadCalls[0]).toMatchObject({ id: 'thread-xyz' })
  })

  it('yields init then text then result for a simple turn', async () => {
    const fakeCodex = makeFakeCodex()
    fakeCodex.fake.thread.pushTurn([
      { type: 'thread.started', thread_id: 't1' },
      { type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'hello from codex' } },
      { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 0 } },
    ])
    const { provider: p } = provider({}, fakeCodex)
    const session = await p.spawn({ alias: 'a', path: '/p' })

    const events = await drain(session.dispatch('hi'))

    expect(events[0]).toEqual({ kind: 'init', sessionId: 't1' })
    expect(events[1]).toEqual({ kind: 'text', text: 'hello from codex' })
    expect(events[events.length - 1]?.kind).toBe('result')
    const resultEv = events.find(e => e.kind === 'result')
    expect(resultEv).toBeDefined()
  })

  it('yields tool_call with server + tool from mcp_tool_call items', async () => {
    const fakeCodex = makeFakeCodex()
    fakeCodex.fake.thread.pushTurn([
      { type: 'thread.started', thread_id: 't1' },
      { type: 'item.completed', item: {
          id: 'tc1',
          type: 'mcp_tool_call',
          server: 'wechat',
          tool: 'reply',
          arguments: { text: 'replied via tool' },
          status: 'completed',
          result: { content: [{ type: 'text', text: 'ok' }], structured_content: null },
        },
      },
      { type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'done' } },
      { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } },
    ])
    const { provider: p } = provider({}, fakeCodex)
    const session = await p.spawn({ alias: 'a', path: '/p' })

    const events = await drain(session.dispatch('please reply'))

    expect(events.some(e => e.kind === 'tool_call' && e.server === 'wechat' && e.tool === 'reply')).toBe(true)
  })

  it('yields error event for turn.failed', async () => {
    const fakeCodex = makeFakeCodex()
    fakeCodex.fake.thread.pushTurn([
      { type: 'thread.started', thread_id: 't1' },
      { type: 'turn.failed', error: { message: 'context limit exceeded' } },
    ])
    const { provider: p } = provider({}, fakeCodex)
    const session = await p.spawn({ alias: 'a', path: '/p' })

    const events = await drain(session.dispatch('hi'))

    expect(events.some(e => e.kind === 'error')).toBe(true)
    const errorEv = events.find(e => e.kind === 'error')
    expect((errorEv as { message: string }).message).toBe('context limit exceeded')
  })

  it('yields error event for stream-level error', async () => {
    const fakeCodex = makeFakeCodex()
    fakeCodex.fake.thread.pushTurn([
      { type: 'thread.started', thread_id: 't1' },
      { type: 'error', message: 'network timeout' } as unknown as ThreadEvent,
    ])
    const { provider: p } = provider({}, fakeCodex)
    const session = await p.spawn({ alias: 'a', path: '/p' })

    const events = await drain(session.dispatch('hi'))

    expect(events.some(e => e.kind === 'error')).toBe(true)
    const errorEv = events.find(e => e.kind === 'error')
    expect((errorEv as { message: string }).message).toBe('network timeout')
  })

  it('returns empty iterable after close()', async () => {
    const fakeCodex = makeFakeCodex()
    // No turns pushed — close before dispatch
    const { provider: p } = provider({}, fakeCodex)
    const session = await p.spawn({ alias: 'a', path: '/p' })

    await session.close()
    const events = await drain(session.dispatch('after close'))

    expect(events).toEqual([])
  })

  it('preserves first-dispatch instruction injection (appendInstructions)', async () => {
    const fakeCodex = makeFakeCodex()
    // Push two turns: one for the first dispatch, one for the second
    fakeCodex.fake.thread.pushTurn([
      { type: 'thread.started', thread_id: 't1' },
      { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } },
    ])
    fakeCodex.fake.thread.pushTurn([
      { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } },
    ])

    const { provider: p } = provider({ appendInstructions: 'be terse' }, fakeCodex)
    const session = await p.spawn({ alias: 'a', path: '/p' })

    // First dispatch — should inject instructions
    await drain(session.dispatch('hi'))
    // Second dispatch — should NOT inject again
    await drain(session.dispatch('hello again'))

    const calls = fakeCodex.fake.thread.runStreamedCalls
    expect(calls).toHaveLength(2)
    // First call should contain both instructions and message
    expect(calls[0]!.input).toContain('be terse')
    expect(calls[0]!.input).toContain('hi')
    // Second call should NOT contain instructions
    expect(calls[1]!.input).not.toContain('be terse')
    expect(calls[1]!.input).toBe('hello again')
  })

  it('result event has incremented numTurns per dispatch', async () => {
    const fakeCodex = makeFakeCodex()
    fakeCodex.fake.thread.pushTurn([
      { type: 'thread.started', thread_id: 'sid-codex-abc' },
      { type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'hi' } },
      { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } },
    ])
    fakeCodex.fake.thread.pushTurn([
      { type: 'item.completed', item: { id: 'i2', type: 'agent_message', text: 'hi again' } },
      { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } },
    ])
    const { provider: p } = provider({}, fakeCodex)
    const session = await p.spawn({ alias: 'a', path: '/p' })

    const firstEvents = await drain(session.dispatch('first'))
    const secondEvents = await drain(session.dispatch('second'))

    const r1 = firstEvents.find(e => e.kind === 'result') as { kind: 'result'; numTurns: number } | undefined
    const r2 = secondEvents.find(e => e.kind === 'result') as { kind: 'result'; numTurns: number } | undefined
    expect(r1?.numTurns).toBe(1)
    expect(r2?.numTurns).toBe(2)
  })

  it('cancel() aborts in-flight turn without preventing future dispatches', async () => {
    const signalsCaptured: AbortSignal[] = []
    let dispatchCount = 0
    const codex: Codex = {
      startThread(): Thread {
        return {
          get id() { return 'tid' },
          async run(): Promise<never> { throw new Error('not used') },
          async runStreamed(_input: unknown, opts?: { signal?: AbortSignal }) {
            if (opts?.signal) signalsCaptured.push(opts.signal)
            dispatchCount++
            // First dispatch hangs forever (so cancel can abort it);
            // second dispatch completes immediately so we can assert the
            // session still functions after cancel.
            const myCount = dispatchCount
            async function* gen(): AsyncGenerator<ThreadEvent> {
              if (myCount === 1) {
                await new Promise<void>(() => {})  // never resolves
              } else {
                yield { type: 'thread.started', thread_id: 'tid' } as unknown as ThreadEvent
                yield {
                  type: 'turn.completed',
                  usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 },
                } as unknown as ThreadEvent
              }
            }
            return { events: gen() }
          },
        } as unknown as Thread
      },
      resumeThread(): Thread { throw new Error('not used') },
    } as unknown as Codex

    const p = createCodexAgentProvider({ codexFactory: () => codex })
    const session = await p.spawn({ alias: 'a', path: '/p' })

    // First dispatch hangs.
    void session.dispatch('hangs')[Symbol.asyncIterator]().next().catch(() => undefined)
    await new Promise(r => setTimeout(r, 5))
    expect(signalsCaptured).toHaveLength(1)
    expect(signalsCaptured[0]!.aborted).toBe(false)

    // Cancel — aborts the first signal but does NOT mark session closed.
    await session.cancel?.()
    expect(signalsCaptured[0]!.aborted).toBe(true)

    // Second dispatch still goes through.
    const iter2 = session.dispatch('after-cancel')[Symbol.asyncIterator]()
    const r = await iter2.next()
    expect(r.done).toBe(false)
    // drain the rest
    while (!(await iter2.next()).done) { /* empty */ }
    expect(signalsCaptured).toHaveLength(2)

    await session.close()
  })

  it('close() aborts in-flight turn via the AbortSignal passed to runStreamed', async () => {
    let signalCaptured: AbortSignal | undefined
    const codex: Codex = {
      startThread(): Thread {
        return {
          get id() { return 'tid' },
          async run(): Promise<never> { throw new Error('not used') },
          async runStreamed(_input: unknown, opts?: { signal?: AbortSignal }) {
            signalCaptured = opts?.signal
            // Generator that yields nothing and never completes.
            async function* gen(): AsyncGenerator<ThreadEvent> {
              await new Promise<void>(() => {})  // never resolves
            }
            return { events: gen() }
          },
        } as unknown as Thread
      },
      resumeThread(): Thread { throw new Error('not used') },
    } as unknown as Codex

    const p = createCodexAgentProvider({ codexFactory: () => codex })
    const session = await p.spawn({ alias: 'a', path: '/p' })
    // Don't await dispatch — it'll hang on the generator. Just trigger it
    // so runStreamed runs and our AbortSignal hook fires.
    void session.dispatch('hangs forever')[Symbol.asyncIterator]().next().catch(() => undefined)
    await new Promise(r => setTimeout(r, 5))
    expect(signalCaptured).toBeDefined()
    expect(signalCaptured!.aborted).toBe(false)
    await session.close()
    expect(signalCaptured!.aborted).toBe(true)
  })

  it('does not pass apiKey to the Codex constructor (auth-agnostic per RFC 03 §3.6)', async () => {
    const factoryArgs: unknown[] = []
    const fake = makeFakeCodex()
    const factory: CodexFactory = (args) => { factoryArgs.push(args); return fake.codex }
    const p = createCodexAgentProvider({ codexFactory: factory })
    await p.spawn({ alias: 'a', path: '/p' })
    // PR F: factory is called twice — once at provider construction for
    // the hoisted cheapEval Codex instance, once per spawn() call.
    // Neither call should pass apiKey.
    expect(factoryArgs.length).toBeGreaterThanOrEqual(1)
    for (const args of factoryArgs) {
      expect((args as Record<string, unknown>).apiKey).toBeUndefined()
    }
  })

  it('forwards codexPathOverride when provided', async () => {
    const factoryArgs: unknown[] = []
    const fake = makeFakeCodex()
    const factory: CodexFactory = (args) => { factoryArgs.push(args); return fake.codex }
    const p = createCodexAgentProvider({ codexFactory: factory, codexPathOverride: '/opt/codex/bin/codex' })
    await p.spawn({ alias: 'a', path: '/p' })
    expect(factoryArgs[0]).toMatchObject({ codexPathOverride: '/opt/codex/bin/codex' })
  })

  it('log() emits SESSION_INIT on thread.started (PR P4 — was console.error)', async () => {
    // Phase 4 routed SESSION_INIT through src/lib/log which writes to
    // process.stderr.write (and channel.log on disk). Spy that channel
    // instead of console.error.
    const writes: string[] = []
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString())
      return true
    })
    try {
      const fakeCodex = makeFakeCodex()
      fakeCodex.fake.thread.pushTurn([
        { type: 'thread.started', thread_id: 'tid-log-test' },
        { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } },
      ])
      const { provider: p } = provider({}, fakeCodex)
      const session = await p.spawn({ alias: 'logtest', path: '/p' })

      await drain(session.dispatch('hi'))

      const all = writes.join('')
      expect(all).toContain('SESSION_INIT')
      expect(all).toContain('tid-log-test')
    } finally {
      // Restore even if any assertion above throws — without this a
      // failing test would leak the spy into the rest of the file.
      writeSpy.mockRestore()
    }
  })

  it('emits code=auth_failed when turn.failed message matches auth-shape', async () => {
    const fakeCodex = makeFakeCodex()
    fakeCodex.fake.thread.pushTurn([
      { type: 'thread.started', thread_id: 't1' },
      { type: 'turn.failed', error: { message: 'OPENAI_API_KEY not set, run `codex login`' } },
    ])
    const { provider: p } = provider({}, fakeCodex)
    const session = await p.spawn({ alias: 'a', path: '/p' })

    const events = await drain(session.dispatch('hi'))

    const errs = events.filter((e) => e.kind === 'error')
    expect(errs).toHaveLength(1)
    expect((errs[0] as { code?: string }).code).toBe('auth_failed')
  })

  it('emits code=auth_failed when stream-level error message matches auth-shape', async () => {
    const fakeCodex = makeFakeCodex()
    fakeCodex.fake.thread.pushTurn([
      { type: 'thread.started', thread_id: 't1' },
      { type: 'error', message: 'not authenticated, please run codex login' } as unknown as ThreadEvent,
    ])
    const { provider: p } = provider({}, fakeCodex)
    const session = await p.spawn({ alias: 'a', path: '/p' })

    const events = await drain(session.dispatch('hi'))

    const errs = events.filter((e) => e.kind === 'error')
    expect(errs).toHaveLength(1)
    expect((errs[0] as { code?: string }).code).toBe('auth_failed')
  })

  it('does not emit code=auth_failed for non-auth stream-level errors', async () => {
    const fakeCodex = makeFakeCodex()
    fakeCodex.fake.thread.pushTurn([
      { type: 'thread.started', thread_id: 't1' },
      { type: 'error', message: 'network timeout' } as unknown as ThreadEvent,
    ])
    const { provider: p } = provider({}, fakeCodex)
    const session = await p.spawn({ alias: 'a', path: '/p' })

    const events = await drain(session.dispatch('hi'))

    const errs = events.filter((e) => e.kind === 'error')
    expect(errs).toHaveLength(1)
    expect((errs[0] as { code?: string }).code).toBeUndefined()
  })

  describe('cheapEval (PR F)', () => {
    it('builds an ephemeral one-shot thread with minimal reasoning + no tools/network/sandbox-write', async () => {
      const { provider: p, fake } = provider()
      fake.thread.pushRunResult([
        { type: 'agent_message', text: '8' },
      ])
      const out = await p.cheapEval?.('what is 9-1?')
      expect(out).toBe('8')

      // Each cheapEval call starts a fresh thread (no persistence).
      expect(fake.startThreadCalls).toHaveLength(1)
      const o = fake.startThreadCalls[0]!
      // Resolver picks something — exact value depends on local cache;
      // here we just assert it's set, the helper has its own tests.
      expect(typeof o.model).toBe('string')
      expect(o.modelReasoningEffort).toBe('minimal')
      expect(o.sandboxMode).toBe('read-only')
      expect(o.approvalPolicy).toBe('never')
      expect(o.webSearchEnabled).toBe(false)
      expect(o.webSearchMode).toBe('disabled')
      expect(o.networkAccessEnabled).toBe(false)
      expect(o.skipGitRepoCheck).toBe(true)

      // run() called once, not runStreamed (we don't need events).
      expect(fake.thread.runCalls).toHaveLength(1)
      expect(fake.thread.runCalls[0]?.input).toBe('what is 9-1?')
      expect(fake.thread.runStreamedCalls).toHaveLength(0)
    })

    it('concatenates multiple agent_message items, skipping other item types', async () => {
      const { provider: p, fake } = provider()
      fake.thread.pushRunResult([
        { type: 'reasoning', text: 'thinking...' },  // filtered out
        { type: 'agent_message', text: 'part 1' },
        { type: 'mcp_tool_call', server: 'x', tool: 'y' },  // filtered out
        { type: 'agent_message', text: ' part 2' },
      ])
      expect(await p.cheapEval?.('hi')).toBe('part 1 part 2')
    })

    it('returns empty string when the model produced no agent_message items', async () => {
      const { provider: p, fake } = provider()
      fake.thread.pushRunResult([
        { type: 'reasoning', text: 'only reasoning, no answer' },
      ])
      expect(await p.cheapEval?.('hi')).toBe('')
    })
  })
})
