import { describe, expect, it, vi } from 'vitest'
import type { Codex, Thread, ThreadEvent, ThreadOptions } from '@openai/codex-sdk'
import { createCodexAgentProvider, type CodexFactory } from './codex-agent-provider'

/**
 * Tests for codex-agent-provider. Uses an injected `codexFactory` to swap
 * the real Codex SDK (which would spawn the codex CLI) for a fake. The
 * fake exposes the same surface — startThread / resumeThread / Thread.run
 * / Thread.runStreamed / Thread.id — so we can assert:
 *
 *   1. spawn() routes resumeSessionId to resumeThread, fresh to startThread
 *   2. dispatch() translates Codex events to AgentSession callbacks per
 *      RFC 03 §3.5 + Spike 2 README translation table
 *   3. session_id reported by onResult comes from thread.id
 *   4. mcp_tool_call from server='wechat' with reply-family tool flips
 *      replyToolCalled true (matches Claude provider semantics)
 *   5. close() aborts any in-flight turn
 *   6. ThreadOptions defaults match RFC 03 §10 (sandbox=workspace-write,
 *      approval=never)
 *
 * This test does NOT touch the real Codex CLI or OpenAI API.
 */

interface FakeRunRecord {
  input: string
  signal: AbortSignal | undefined
  events: ThreadEvent[]
}

interface FakeThread {
  id: string | null
  runStreamedCalls: FakeRunRecord[]
  pushTurn(events: ThreadEvent[]): void
}

interface FakeCodex {
  startThreadCalls: ThreadOptions[]
  resumeThreadCalls: { id: string; opts: ThreadOptions }[]
  thread: FakeThread
}

function makeFakeCodex(initialThreadId: string | null = null): { codex: Codex; fake: FakeCodex } {
  const queuedTurns: ThreadEvent[][] = []
  const runStreamedCalls: FakeRunRecord[] = []
  let threadId: string | null = initialThreadId

  const fakeThread: Thread = {
    get id(): string | null { return threadId },
    async run(): Promise<never> { throw new Error('FakeThread.run not used by provider; use runStreamed') },
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
      pushTurn(events) { queuedTurns.push(events) },
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

  it('dispatch translates agent_message into onAssistantText + return value', async () => {
    const fakeCodex = makeFakeCodex()
    fakeCodex.fake.thread.pushTurn([
      { type: 'thread.started', thread_id: 'tid-1' },
      { type: 'turn.started' },
      { type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'hello from codex' } },
      { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 0 } },
    ])
    const { provider: p } = provider({}, fakeCodex)
    const session = await p.spawn({ alias: 'a', path: '/p' })
    const heard: string[] = []
    session.onAssistantText(t => heard.push(t))

    const result = await session.dispatch('hi')

    expect(result.assistantText).toEqual(['hello from codex'])
    expect(result.replyToolCalled).toBe(false)
    expect(heard).toEqual(['hello from codex'])
  })

  it('dispatch fires onResult with thread.id + incremented num_turns + duration on turn.completed', async () => {
    const fakeCodex = makeFakeCodex()
    fakeCodex.fake.thread.pushTurn([
      { type: 'thread.started', thread_id: 'sid-codex-abc' },
      { type: 'turn.started' },
      { type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'hi' } },
      { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } },
    ])
    fakeCodex.fake.thread.pushTurn([
      { type: 'turn.started' },
      { type: 'item.completed', item: { id: 'i2', type: 'agent_message', text: 'hi again' } },
      { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } },
    ])
    const { provider: p } = provider({}, fakeCodex)
    const session = await p.spawn({ alias: 'a', path: '/p' })
    const results: { session_id: string; num_turns: number; duration_ms: number }[] = []
    session.onResult(r => results.push(r))

    await session.dispatch('first')
    await session.dispatch('second')

    expect(results).toHaveLength(2)
    expect(results[0]).toMatchObject({ session_id: 'sid-codex-abc', num_turns: 1 })
    expect(results[1]).toMatchObject({ session_id: 'sid-codex-abc', num_turns: 2 })
    expect(results[0]!.duration_ms).toBeGreaterThanOrEqual(0)
  })

  it('flags replyToolCalled when wechat-mcp reply-family tool is invoked', async () => {
    const fakeCodex = makeFakeCodex()
    fakeCodex.fake.thread.pushTurn([
      { type: 'thread.started', thread_id: 't1' },
      { type: 'turn.started' },
      // wechat reply tool — should flip the flag
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

    const r = await session.dispatch('please reply')

    expect(r.replyToolCalled).toBe(true)
  })

  it('does NOT flag replyToolCalled for non-wechat MCP servers or non-reply tools', async () => {
    const fakeCodex = makeFakeCodex()
    fakeCodex.fake.thread.pushTurn([
      { type: 'thread.started', thread_id: 't1' },
      { type: 'turn.started' },
      // Some other MCP server, same tool name — must NOT flip
      { type: 'item.completed', item: {
          id: 'tc1', type: 'mcp_tool_call', server: 'unrelated', tool: 'reply',
          arguments: {}, status: 'completed',
        },
      },
      // wechat-mcp but a non-reply-family tool — must NOT flip
      { type: 'item.completed', item: {
          id: 'tc2', type: 'mcp_tool_call', server: 'wechat', tool: 'memory_read',
          arguments: { path: 'foo.md' }, status: 'completed',
        },
      },
      { type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'no reply' } },
      { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } },
    ])
    const { provider: p } = provider({}, fakeCodex)
    const session = await p.spawn({ alias: 'a', path: '/p' })

    const r = await session.dispatch('hi')
    expect(r.replyToolCalled).toBe(false)
  })

  it('flags all reply-family tool variants (reply_voice, send_file, edit_message, broadcast)', async () => {
    for (const tool of ['reply_voice', 'send_file', 'edit_message', 'broadcast']) {
      const fakeCodex = makeFakeCodex()
      fakeCodex.fake.thread.pushTurn([
        { type: 'thread.started', thread_id: 't' },
        { type: 'turn.started' },
        { type: 'item.completed', item: {
            id: 'tc', type: 'mcp_tool_call', server: 'wechat', tool,
            arguments: {}, status: 'completed',
          },
        },
        { type: 'item.completed', item: { id: 'i', type: 'agent_message', text: 'ok' } },
        { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } },
      ])
      const { provider: p } = provider({}, fakeCodex)
      const session = await p.spawn({ alias: 'a', path: '/p' })
      const r = await session.dispatch('go')
      expect(r.replyToolCalled, `tool=${tool}`).toBe(true)
    }
  })

  it('close() aborts in-flight turn via the AbortSignal passed to runStreamed', async () => {
    // A turn that never yields turn.completed — simulates a hung/long-running call.
    // close() should fire the AbortSignal so the SDK terminates the underlying child.
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
    void session.dispatch('hangs forever').catch(() => undefined)
    await new Promise(r => setTimeout(r, 5))
    expect(signalCaptured).toBeDefined()
    expect(signalCaptured!.aborted).toBe(false)
    await session.close()
    expect(signalCaptured!.aborted).toBe(true)
  })

  it('does not pass apiKey to the Codex constructor (auth-agnostic per RFC 03 §3.6)', async () => {
    // The provider constructs Codex via the injected factory; we capture
    // its argument and assert no apiKey leaked through.
    const factoryArgs: unknown[] = []
    const fake = makeFakeCodex()
    const factory: CodexFactory = (args) => { factoryArgs.push(args); return fake.codex }
    const p = createCodexAgentProvider({ codexFactory: factory })
    await p.spawn({ alias: 'a', path: '/p' })
    expect(factoryArgs).toHaveLength(1)
    const a = factoryArgs[0] as Record<string, unknown>
    expect(a.apiKey).toBeUndefined()
  })

  it('forwards codexPathOverride when provided', async () => {
    const factoryArgs: unknown[] = []
    const fake = makeFakeCodex()
    const factory: CodexFactory = (args) => { factoryArgs.push(args); return fake.codex }
    const p = createCodexAgentProvider({ codexFactory: factory, codexPathOverride: '/opt/codex/bin/codex' })
    await p.spawn({ alias: 'a', path: '/p' })
    expect(factoryArgs[0]).toMatchObject({ codexPathOverride: '/opt/codex/bin/codex' })
  })
})
