# P2 · AgentSession Async Iterator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `AgentSession.dispatch(text): Promise<{ assistantText[]; replyToolCalled }>` + `onAssistantText`/`onResult` listeners with a single `dispatch(text): AsyncIterable<AgentEvent>`. Both providers (Claude SDK, Codex SDK) become event yielders. The coordinator consumes via a new `collectTurn` helper that accumulates events into the same `{ assistantText, replyToolCalled }` shape consumers already expect.

**Architecture:** `AgentEvent` is a discriminated union with 5 variants (`text` / `tool_call` / `init` / `result` / `error`). Each provider yields events at its own SDK message boundaries. `collectTurn(events)` walks an iterable to a `TurnSummary`. Coordinator dispatch logic for `solo`, `parallel`, and `chatroom` modes uses `collectTurn` and keeps existing fallback semantics.

**Tech Stack:** TypeScript 6 async iterators, `@anthropic-ai/claude-agent-sdk` 0.2.116, `@openai/codex-sdk` 0.128.0, vitest, Bun.

**Reference spec:** `docs/specs/2026-05-07-api-contract-and-agent-session.md` §P2

**Discovery checklist:**
- Existing `AgentProvider` interface lives in `src/core/agent-provider.ts` (30 lines).
- Claude provider: `src/core/claude-agent-provider.ts` (~220 lines). Internal `pendingTurns` queue is the part being deleted.
- Codex provider: `src/core/codex-agent-provider.ts` (~225 lines). `assistantListeners` / `resultListeners` are the parts being deleted.
- Coordinator: `src/core/conversation-coordinator.ts` (~487 lines). Three dispatch functions (`dispatchSolo`, `dispatchParallel`, `dispatchChatroom`).
- Tests: `src/core/agent-provider.test.ts` (new), `claude-agent-provider.test.ts` (rewrite), `codex-agent-provider.test.ts` (rewrite), `conversation-coordinator.test.ts` (~367 lines, fixture rewrite).

---

### Task 1: Define `AgentEvent`, `TurnSummary`, `collectTurn`, `isReplyToolCall` in `agent-provider.ts`

**Files:**
- Modify: `src/core/agent-provider.ts`
- Create: `src/core/agent-provider.test.ts`

- [ ] **Step 1: Write failing tests for the new helpers**

```ts
// src/core/agent-provider.test.ts
import { describe, it, expect } from 'vitest'
import {
  collectTurn,
  isReplyToolCall,
  type AgentEvent,
} from './agent-provider'

async function* events(...e: AgentEvent[]): AsyncIterable<AgentEvent> {
  for (const ev of e) yield ev
}

describe('isReplyToolCall', () => {
  it('matches wechat reply tools', () => {
    expect(isReplyToolCall({ kind: 'tool_call', server: 'wechat', tool: 'reply' })).toBe(true)
    expect(isReplyToolCall({ kind: 'tool_call', server: 'wechat', tool: 'reply_voice' })).toBe(true)
    expect(isReplyToolCall({ kind: 'tool_call', server: 'wechat', tool: 'send_file' })).toBe(true)
    expect(isReplyToolCall({ kind: 'tool_call', server: 'wechat', tool: 'edit_message' })).toBe(true)
    expect(isReplyToolCall({ kind: 'tool_call', server: 'wechat', tool: 'broadcast' })).toBe(true)
  })
  it('rejects non-wechat servers', () => {
    expect(isReplyToolCall({ kind: 'tool_call', server: 'other', tool: 'reply' })).toBe(false)
  })
  it('rejects non-reply tools on wechat server', () => {
    expect(isReplyToolCall({ kind: 'tool_call', server: 'wechat', tool: 'memory_read' })).toBe(false)
  })
  it('rejects events with no server field (built-in tools)', () => {
    expect(isReplyToolCall({ kind: 'tool_call', tool: 'Read' })).toBe(false)
  })
  it('returns false for non-tool-call events', () => {
    expect(isReplyToolCall({ kind: 'text', text: 'hi' })).toBe(false)
    expect(isReplyToolCall({ kind: 'init', sessionId: 's1' })).toBe(false)
    expect(isReplyToolCall({ kind: 'result', sessionId: 's1', numTurns: 1, durationMs: 100 })).toBe(false)
    expect(isReplyToolCall({ kind: 'error', message: 'boom' })).toBe(false)
  })
})

describe('collectTurn', () => {
  it('accumulates text events', async () => {
    const summary = await collectTurn(events(
      { kind: 'text', text: 'hello' },
      { kind: 'text', text: 'world' },
    ))
    expect(summary.assistantText).toEqual(['hello', 'world'])
    expect(summary.replyToolCalled).toBe(false)
    expect(summary.result).toBeUndefined()
    expect(summary.error).toBeUndefined()
  })

  it('flags reply tool calls', async () => {
    const summary = await collectTurn(events(
      { kind: 'tool_call', server: 'wechat', tool: 'reply' },
    ))
    expect(summary.replyToolCalled).toBe(true)
  })

  it('does not flag non-reply tool calls', async () => {
    const summary = await collectTurn(events(
      { kind: 'tool_call', server: 'wechat', tool: 'memory_read' },
      { kind: 'tool_call', tool: 'Read' },
    ))
    expect(summary.replyToolCalled).toBe(false)
  })

  it('captures result event', async () => {
    const summary = await collectTurn(events(
      { kind: 'init', sessionId: 's1' },
      { kind: 'text', text: 'hi' },
      { kind: 'result', sessionId: 's1', numTurns: 1, durationMs: 250 },
    ))
    expect(summary.result).toEqual({ sessionId: 's1', numTurns: 1, durationMs: 250 })
    expect(summary.assistantText).toEqual(['hi'])
  })

  it('captures error events', async () => {
    const summary = await collectTurn(events(
      { kind: 'text', text: 'partial' },
      { kind: 'error', message: 'turn failed' },
    ))
    expect(summary.error).toBe('turn failed')
    expect(summary.assistantText).toEqual(['partial'])
  })

  it('handles empty iterable', async () => {
    const summary = await collectTurn(events())
    expect(summary).toEqual({ assistantText: [], replyToolCalled: false, result: undefined, error: undefined })
  })
})
```

- [ ] **Step 2: Run tests, expect failure**

```bash
bun --bun vitest run src/core/agent-provider.test.ts
```

Expected: FAIL — `collectTurn`, `isReplyToolCall`, `AgentEvent` not exported.

- [ ] **Step 3: Rewrite `src/core/agent-provider.ts` with new types + helpers**

Replace the entire file content with:

```ts
export interface AgentProject {
  alias: string
  path: string
}

/**
 * The provider-agnostic event a session yields on a dispatch turn.
 *
 * Variant semantics:
 *   text      — assistant produced visible text (one event per SDK
 *               assistant block; can occur multiple times per turn).
 *   tool_call — assistant invoked a tool. `server` is set when the SDK
 *               distinguishes MCP server (Codex always; Claude after
 *               parsing the `mcp__SERVER__TOOL` name pattern). For
 *               built-in tools (Read, Bash, etc.) `server` is omitted.
 *   init      — session initialised; emitted once per dispatch by Codex
 *               (thread.started) and by Claude on first dispatch only
 *               (system{init} message). Consumers can ignore.
 *   result    — turn completed cleanly. Always followed by iterator
 *               close; one per dispatch.
 *   error     — turn failed at the SDK semantic layer (turn.failed,
 *               result.subtype !== 'success'). Iterator continues to
 *               close normally — true exceptions throw instead.
 */
export type AgentEvent =
  | { kind: 'text'; text: string }
  | { kind: 'tool_call'; server?: string; tool: string }
  | { kind: 'init'; sessionId: string }
  | { kind: 'result'; sessionId: string; numTurns: number; durationMs: number }
  | { kind: 'error'; message: string }

export interface AgentSession {
  /**
   * Send `text` to the agent and yield events as they arrive. The
   * iterator closes after the first `result` (or `error`) event.
   *
   * Concurrency: providers are NOT required to support overlapping
   * dispatches. Claude provider serialises (one in-flight per session);
   * Codex provider runs each turn as a separate runStreamed.
   */
  dispatch(text: string): AsyncIterable<AgentEvent>
  close(): Promise<void>
}

export interface AgentProvider {
  spawn(project: AgentProject, opts?: { resumeSessionId?: string }): Promise<AgentSession>
}

/**
 * Reply-tool detection — moved out of the providers so the wechat-channel
 * concept doesn't leak into the provider interface. Coordinator and any
 * other consumer derives "did the agent call a reply tool this turn?" by
 * walking events and checking each `tool_call` event with this helper.
 */
const REPLY_TOOLS = new Set(['reply', 'reply_voice', 'send_file', 'edit_message', 'broadcast'])

export function isReplyToolCall(ev: AgentEvent): boolean {
  return ev.kind === 'tool_call' && ev.server === 'wechat' && REPLY_TOOLS.has(ev.tool)
}

/**
 * One-turn aggregation: drain an event stream and return the summary the
 * coordinator needs. Mirrors the shape consumers used to get from the old
 * dispatch return value, plus optional `result` / `error` for diagnostics.
 */
export interface TurnSummary {
  assistantText: string[]
  replyToolCalled: boolean
  result?: { sessionId: string; numTurns: number; durationMs: number }
  error?: string
}

export async function collectTurn(events: AsyncIterable<AgentEvent>): Promise<TurnSummary> {
  const texts: string[] = []
  let replyToolCalled = false
  let result: TurnSummary['result']
  let error: string | undefined
  for await (const ev of events) {
    if (ev.kind === 'text') {
      texts.push(ev.text)
    } else if (ev.kind === 'tool_call' && isReplyToolCall(ev)) {
      replyToolCalled = true
    } else if (ev.kind === 'result') {
      result = { sessionId: ev.sessionId, numTurns: ev.numTurns, durationMs: ev.durationMs }
    } else if (ev.kind === 'error') {
      error = ev.message
    }
  }
  return { assistantText: texts, replyToolCalled, result, error }
}
```

The old `AgentResult` interface is gone (subsumed into the `result` event variant). The old `AgentSession.dispatch` Promise return + `onAssistantText`/`onResult` listeners are gone.

- [ ] **Step 4: Run tests, expect pass**

```bash
bun --bun vitest run src/core/agent-provider.test.ts
```

Expected: PASS — 11 tests.

- [ ] **Step 5: Run typecheck**

```bash
bun run typecheck
```

Expected: FAIL — every consumer of the old AgentSession shape now has type errors. That's expected; subsequent tasks fix them.

- [ ] **Step 6: Commit**

```bash
git add src/core/agent-provider.ts src/core/agent-provider.test.ts
git commit -m "feat(core): AgentEvent + collectTurn + isReplyToolCall (typecheck red intentionally)"
```

The commit deliberately leaves typecheck red — provider rewrites in the next tasks restore green.

---

### Task 2: Rewrite `claude-agent-provider.ts` to yield events

**Files:**
- Modify: `src/core/claude-agent-provider.ts`
- Modify: `src/core/claude-agent-provider.test.ts`

- [ ] **Step 1: Read the current implementation**

```bash
cat src/core/claude-agent-provider.ts
```

Identify what stays:
- `AsyncQueue<T>` class at the bottom (reused for event queueing).
- `narrow()` helper (still translates SDK message variants).
- `extractText()` helper (still pulls text out of assistant content arrays).
- The background `for await (const raw of q)` task that consumes the SDK iterator.

What goes:
- `pendingTurns` array + Turn type.
- `assistantListeners`, `resultListeners` Sets.
- The `REPLY_TOOL_NAMES` constant — it moves out (consumer-side).
- `onAssistantText` / `onResult` methods.
- The `dispatch` Promise resolution machinery.

- [ ] **Step 2: Update existing tests for the new shape**

```ts
// src/core/claude-agent-provider.test.ts — rewrite the assertions to walk events

import { describe, it, expect } from 'vitest'
import { createClaudeAgentProvider } from './claude-agent-provider'
import type { AgentEvent } from './agent-provider'

// Helper: drain an iterable into an array for assertion.
async function drain(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = []
  for await (const ev of events) out.push(ev)
  return out
}

describe('claude-agent-provider', () => {
  it('yields init then text then result for a simple turn', async () => {
    // Build a stub claude SDK that emits these messages on the iterator:
    //   { type: 'system', subtype: 'init', session_id: 's1' }
    //   { type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } }
    //   { type: 'result', session_id: 's1', num_turns: 1, duration_ms: 100 }
    //
    // The exact stubbing approach depends on what the existing test file
    // uses — check ./claude-agent-provider.test.ts for the current
    // pattern (likely a fake `query` from @anthropic-ai/claude-agent-sdk).
    const provider = createClaudeAgentProvider({ /* opts with the stub */ })
    const session = await provider.spawn({ alias: 'foo', path: '/tmp' })
    const events = await drain(session.dispatch('hi'))
    expect(events).toEqual([
      { kind: 'init', sessionId: 's1' },
      { kind: 'text', text: 'hello' },
      { kind: 'result', sessionId: 's1', numTurns: 1, durationMs: 100 },
    ])
    await session.close()
  })

  it('yields tool_call for mcp__wechat__reply', async () => {
    // Stub emits an assistant message with a tool_use block:
    //   { type: 'tool_use', name: 'mcp__wechat__reply', input: { ... } }
    // followed by a result.
    const provider = createClaudeAgentProvider({ /* stub */ })
    const session = await provider.spawn({ alias: 'foo', path: '/tmp' })
    const events = await drain(session.dispatch('reply please'))
    expect(events.some(e => e.kind === 'tool_call' && e.server === 'wechat' && e.tool === 'reply')).toBe(true)
    await session.close()
  })

  it('yields tool_call for built-in tools without server prefix', async () => {
    // Stub emits a tool_use with name 'Read'
    const provider = createClaudeAgentProvider({ /* stub */ })
    const session = await provider.spawn({ alias: 'foo', path: '/tmp' })
    const events = await drain(session.dispatch('read a file'))
    const toolCall = events.find(e => e.kind === 'tool_call')
    expect(toolCall).toBeDefined()
    expect((toolCall as { server?: string }).server).toBeUndefined()
    expect((toolCall as { tool: string }).tool).toBe('Read')
    await session.close()
  })

  it('yields error event for non-success result subtype', async () => {
    // Stub emits a result with subtype 'error' and a message.
    const provider = createClaudeAgentProvider({ /* stub */ })
    const session = await provider.spawn({ alias: 'foo', path: '/tmp' })
    const events = await drain(session.dispatch('hi'))
    expect(events.some(e => e.kind === 'error')).toBe(true)
    await session.close()
  })

  it('returns an empty iterable after close()', async () => {
    const provider = createClaudeAgentProvider({ /* stub */ })
    const session = await provider.spawn({ alias: 'foo', path: '/tmp' })
    await session.close()
    const events = await drain(session.dispatch('after close'))
    expect(events).toEqual([])
  })

  it('throws if dispatch is called while a previous dispatch is in flight', async () => {
    // Stub emits messages slowly so we can call dispatch twice.
    const provider = createClaudeAgentProvider({ /* stub */ })
    const session = await provider.spawn({ alias: 'foo', path: '/tmp' })
    const first = session.dispatch('a')
    expect(() => session.dispatch('b')).toThrow(/in flight/)
    // Drain first to clean up.
    for await (const _ of first) { /* drain */ }
    await session.close()
  })
})
```

The stubbing pattern depends on what's there now — read the existing test file and follow its convention.

- [ ] **Step 3: Run tests, expect failure**

```bash
bun --bun vitest run src/core/claude-agent-provider.test.ts
```

Expected: FAIL — old API removed, new not yet implemented.

- [ ] **Step 4: Rewrite `src/core/claude-agent-provider.ts`**

```ts
import { query, type Options, type Query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { AgentEvent, AgentProject, AgentProvider, AgentSession } from './agent-provider'

export interface ClaudeAgentProviderOptions {
  sdkOptionsForProject: (alias: string, path: string) => Options
}

type AssistantContent = string | Array<{ type?: string; text?: string; name?: string }>
type AssistantMsg = { type: 'assistant'; message?: { content?: AssistantContent } }
type ResultMsg = {
  type: 'result'; subtype?: string; session_id?: string
  num_turns?: number; duration_ms?: number; result?: unknown
}
type SystemMsg = { type: 'system'; subtype?: string; session_id?: string }
type NarrowedMsg = AssistantMsg | ResultMsg | SystemMsg

function narrow(msg: SDKMessage): NarrowedMsg | null {
  const t = (msg as { type?: string }).type
  if (t === 'assistant' || t === 'result' || t === 'system') {
    return msg as unknown as NarrowedMsg
  }
  return null
}

function extractText(content: AssistantContent | undefined): string {
  if (!content) return ''
  if (typeof content === 'string') return content
  return content.map(b => (b?.type === 'text' ? b.text ?? '' : '')).join('')
}

/**
 * Parse a Claude SDK tool_use block's `name` (e.g. 'mcp__wechat__reply')
 * into our normalised `{ server, tool }` shape. Built-in tools (Read,
 * Bash) lack the prefix — those return `{ tool: name }` with no server.
 */
function parseToolUseToEvent(block: { name?: string }): AgentEvent {
  const name = block.name ?? ''
  const m = /^mcp__([^_]+)__(.+)$/.exec(name)
  if (m) return { kind: 'tool_call', server: m[1], tool: m[2]! }
  return { kind: 'tool_call', tool: name }
}

class AsyncQueue<T> {
  private buf: T[] = []
  private resolvers: ((v: IteratorResult<T>) => void)[] = []
  private closed = false
  push(v: T) {
    if (this.closed) return
    const r = this.resolvers.shift()
    if (r) r({ value: v, done: false })
    else this.buf.push(v)
  }
  end() {
    this.closed = true
    while (this.resolvers.length > 0) {
      const r = this.resolvers.shift()!
      r({ value: undefined as unknown as T, done: true })
    }
  }
  iterable(): AsyncIterable<T> {
    const self = this
    return {
      [Symbol.asyncIterator](): AsyncIterator<T> {
        return {
          next() {
            if (self.buf.length > 0) return Promise.resolve({ value: self.buf.shift() as T, done: false })
            if (self.closed) return Promise.resolve({ value: undefined as unknown as T, done: true })
            return new Promise<IteratorResult<T>>(res => self.resolvers.push(res))
          },
          async return() { self.end(); return { value: undefined as unknown as T, done: true } },
        }
      },
    }
  }
}

export function createClaudeAgentProvider(opts: ClaudeAgentProviderOptions): AgentProvider {
  return {
    async spawn(project: AgentProject, spawnOpts?: { resumeSessionId?: string }): Promise<AgentSession> {
      const sdkQueue = new AsyncQueue<SDKUserMessage>()
      const options = opts.sdkOptionsForProject(project.alias, project.path)
      if (spawnOpts?.resumeSessionId) {
        ;(options as Options & { resume?: string }).resume = spawnOpts.resumeSessionId
      }
      const q = query({ prompt: sdkQueue.iterable(), options })

      let activeEventQueue: AsyncQueue<AgentEvent> | null = null
      let closed = false
      let droppedAssistantChunks = 0
      let drainResolve: (() => void) | undefined
      const drainPromise = new Promise<void>(resolve => { drainResolve = resolve })

      // Background SDK message consumer — runs for the lifetime of the
      // session, translating SDK messages to AgentEvents on the in-flight
      // dispatch's queue. When no dispatch is in flight, drops with a warn.
      ;(async () => {
        try {
          for await (const raw of q as AsyncGenerator<SDKMessage>) {
            const msg = narrow(raw)
            if (!msg) continue
            if (!activeEventQueue) {
              if (msg.type === 'assistant') {
                const text = extractText(msg.message?.content)
                if (text) {
                  droppedAssistantChunks++
                  console.warn(`wechat channel: [STREAM_DROP] alias=${project.alias} count=${droppedAssistantChunks} preview=${JSON.stringify(text.slice(0, 80))}`)
                }
              }
              continue
            }
            if (msg.type === 'system' && msg.subtype === 'init') {
              activeEventQueue.push({ kind: 'init', sessionId: msg.session_id ?? '' })
            } else if (msg.type === 'assistant') {
              const content = msg.message?.content
              if (Array.isArray(content)) {
                for (const block of content) {
                  if (block?.type === 'tool_use') {
                    activeEventQueue.push(parseToolUseToEvent(block))
                  }
                }
              }
              const text = extractText(content)
              if (text) activeEventQueue.push({ kind: 'text', text })
            } else if (msg.type === 'result') {
              if (msg.subtype && msg.subtype !== 'success') {
                const summary = typeof msg.result === 'string'
                  ? msg.result.slice(0, 400)
                  : JSON.stringify(msg).slice(0, 400)
                console.error(`wechat channel: [SESSION_RESULT] alias=${project.alias} subtype=${msg.subtype} result=${summary}`)
                activeEventQueue.push({ kind: 'error', message: `subtype=${msg.subtype}` })
              }
              activeEventQueue.push({
                kind: 'result',
                sessionId: msg.session_id ?? '',
                numTurns: msg.num_turns ?? 0,
                durationMs: msg.duration_ms ?? 0,
              })
              activeEventQueue.end()
              activeEventQueue = null
            }
          }
        } catch (e) {
          console.error(`wechat channel: [SESSION_ERROR] alias=${project.alias} ${e instanceof Error ? `${e.name}: ${e.message}\n${e.stack}` : String(e)}`)
          if (activeEventQueue) {
            const errMsg = e instanceof Error ? e.message : String(e)
            activeEventQueue.push({ kind: 'error', message: errMsg })
            activeEventQueue.end()
            activeEventQueue = null
          }
        } finally {
          drainResolve?.()
        }
      })()

      return {
        dispatch(text: string): AsyncIterable<AgentEvent> {
          if (closed) {
            return { async *[Symbol.asyncIterator]() {} }
          }
          if (activeEventQueue) {
            throw new Error(`claude provider: previous dispatch still in flight (alias=${project.alias})`)
          }
          const queue = new AsyncQueue<AgentEvent>()
          activeEventQueue = queue
          sdkQueue.push({
            type: 'user',
            parent_tool_use_id: null,
            message: { role: 'user', content: [{ type: 'text', text }] },
          } as SDKUserMessage)
          return queue.iterable()
        },
        async close() {
          closed = true
          sdkQueue.end()
          ;(q as unknown as { close?: () => void }).close?.()
          ;(q as unknown as { interrupt?: () => void }).interrupt?.()
          if (activeEventQueue) {
            activeEventQueue.end()
            activeEventQueue = null
          }
          drainResolve?.()
          await drainPromise
        },
      }
    },
  }
}
```

- [ ] **Step 5: Run tests, expect pass**

```bash
bun --bun vitest run src/core/claude-agent-provider.test.ts
bun --bun vitest run src/core/agent-provider.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add src/core/claude-agent-provider.ts src/core/claude-agent-provider.test.ts
git commit -m "feat(claude-provider): yield AgentEvents per dispatch"
```

---

### Task 3: Rewrite `codex-agent-provider.ts` to yield events

**Files:**
- Modify: `src/core/codex-agent-provider.ts`
- Modify: `src/core/codex-agent-provider.test.ts`

- [ ] **Step 1: Read the current implementation**

```bash
cat src/core/codex-agent-provider.ts
```

Identify what stays:
- All the closure state (`activeAborter`, `instructionsInjected`, `turnCount`, `closed`).
- Codex SDK constructor + `thread.runStreamed` call.
- The `WECHAT_MCP_SERVER` constant and `REPLY_TOOL_NAMES` set get DELETED (consumer derives via `isReplyToolCall`).

What changes:
- `dispatch` body — wrap the existing `for await (const ev of events)` loop in an async-generator function and yield events instead of mutating state.
- `assistantListeners` / `resultListeners` Sets — DELETED.
- The `onAssistantText` / `onResult` methods — DELETED.

- [ ] **Step 2: Update existing tests for the new shape**

```ts
// src/core/codex-agent-provider.test.ts — rewrite the assertions

import { describe, it, expect } from 'vitest'
import { createCodexAgentProvider, type CodexFactory } from './codex-agent-provider'
import type { AgentEvent } from './agent-provider'

async function drain(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = []
  for await (const ev of events) out.push(ev)
  return out
}

describe('codex-agent-provider', () => {
  it('yields init then text then result for a simple turn', async () => {
    // Build a CodexFactory that returns a Codex stub whose runStreamed
    // emits these events:
    //   { type: 'thread.started', thread_id: 't1' }
    //   { type: 'item.completed', item: { type: 'agent_message', text: 'hello' } }
    //   { type: 'turn.completed' }
    //
    // The exact stub shape depends on what's in the existing test file —
    // read it for the established CodexFactory pattern.
    const factory: CodexFactory = (/* args */) => makeStub(/* sequence */)
    const provider = createCodexAgentProvider({ codexFactory: factory })
    const session = await provider.spawn({ alias: 'foo', path: '/tmp' })
    const events = await drain(session.dispatch('hi'))
    expect(events[0]).toEqual({ kind: 'init', sessionId: 't1' })
    expect(events[1]).toEqual({ kind: 'text', text: 'hello' })
    expect(events[events.length - 1]?.kind).toBe('result')
  })

  it('yields tool_call with server + tool from mcp_tool_call items', async () => {
    // Stub: { type: 'item.completed', item: { type: 'mcp_tool_call', server: 'wechat', tool: 'reply' } }
    // ... build the test similarly.
    const provider = createCodexAgentProvider({ /* stub */ })
    const session = await provider.spawn({ alias: 'foo', path: '/tmp' })
    const events = await drain(session.dispatch('reply please'))
    expect(events.some(e => e.kind === 'tool_call' && e.server === 'wechat' && e.tool === 'reply')).toBe(true)
  })

  it('yields error for turn.failed', async () => {
    const provider = createCodexAgentProvider({ /* stub */ })
    const session = await provider.spawn({ alias: 'foo', path: '/tmp' })
    const events = await drain(session.dispatch('hi'))
    expect(events.some(e => e.kind === 'error')).toBe(true)
  })

  it('returns empty iterable after close()', async () => {
    const provider = createCodexAgentProvider({ /* stub */ })
    const session = await provider.spawn({ alias: 'foo', path: '/tmp' })
    await session.close()
    const events = await drain(session.dispatch('after close'))
    expect(events).toEqual([])
  })

  it('preserves first-dispatch instruction injection', async () => {
    let firstPrompt = ''
    const factory: CodexFactory = (/* ... */) => /* stub that captures runStreamed's text */
    const provider = createCodexAgentProvider({
      codexFactory: factory,
      appendInstructions: 'be terse',
    })
    const session = await provider.spawn({ alias: 'foo', path: '/tmp' })
    await drain(session.dispatch('hi'))
    expect(firstPrompt).toContain('be terse')
    expect(firstPrompt).toContain('hi')
  })
})
```

- [ ] **Step 3: Run tests, expect failure**

- [ ] **Step 4: Rewrite `src/core/codex-agent-provider.ts`**

```ts
import { Codex, type Thread, type ThreadEvent, type ThreadItem } from '@openai/codex-sdk'
import type { AgentEvent, AgentProject, AgentProvider, AgentSession } from './agent-provider'

export type CodexFactory = (opts: ConstructorParameters<typeof Codex>[0]) => Codex

export interface CodexMcpStdioServer {
  command: string
  args?: string[]
  env?: Record<string, string>
}

export interface CodexAgentProviderOptions {
  codexPathOverride?: string
  model?: string
  sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access'
  approvalPolicy?: 'never' | 'on-request' | 'on-failure' | 'untrusted'
  mcpServers?: Record<string, CodexMcpStdioServer>
  appendInstructions?: string
  dangerouslyBypassApprovalsAndSandbox?: boolean
  codexFactory?: CodexFactory
}

export function createCodexAgentProvider(opts: CodexAgentProviderOptions = {}): AgentProvider {
  const factory: CodexFactory = opts.codexFactory ?? ((args) => new Codex(args))

  return {
    async spawn(project: AgentProject, spawnOpts?: { resumeSessionId?: string }): Promise<AgentSession> {
      const config: Record<string, unknown> = {}
      if (opts.mcpServers) {
        config.mcp_servers = opts.mcpServers as unknown as Record<string, never>
      }
      if (opts.dangerouslyBypassApprovalsAndSandbox) {
        config.dangerously_bypass_approvals_and_sandbox = true
      }
      const codex = factory({
        ...(opts.codexPathOverride ? { codexPathOverride: opts.codexPathOverride } : {}),
        ...(Object.keys(config).length > 0 ? { config: config as never } : {}),
      })
      const threadOptions = {
        workingDirectory: project.path,
        skipGitRepoCheck: true,
        sandboxMode: opts.sandboxMode ?? 'workspace-write',
        approvalPolicy: opts.approvalPolicy ?? 'never',
        ...(opts.model ? { model: opts.model } : {}),
      } as const

      const thread: Thread = spawnOpts?.resumeSessionId
        ? codex.resumeThread(spawnOpts.resumeSessionId, threadOptions)
        : codex.startThread(threadOptions)

      if (spawnOpts?.resumeSessionId) {
        console.error(`wechat channel: [SESSION_RESUME] alias=${project.alias} thread_id=${spawnOpts.resumeSessionId} provider=codex`)
      }

      let turnCount = 0
      let activeAborter: AbortController | null = null
      let closed = false
      let instructionsInjected = !opts.appendInstructions

      return {
        dispatch(text: string): AsyncIterable<AgentEvent> {
          return {
            async *[Symbol.asyncIterator](): AsyncGenerator<AgentEvent> {
              if (closed) return
              const turnAborter = new AbortController()
              activeAborter = turnAborter
              const turnStarted = Date.now()
              let initEmitted = false

              let dispatchedText = text
              if (!instructionsInjected && opts.appendInstructions) {
                dispatchedText = `${opts.appendInstructions}\n\n---\n\n${text}`
                instructionsInjected = true
              }

              try {
                const { events } = await thread.runStreamed(dispatchedText, { signal: turnAborter.signal })
                for await (const ev of events as AsyncGenerator<ThreadEvent>) {
                  if (ev.type === 'thread.started') {
                    if (!initEmitted) {
                      console.error(`wechat channel: [SESSION_INIT] alias=${project.alias} thread_id=${ev.thread_id} provider=codex`)
                      initEmitted = true
                    }
                    yield { kind: 'init', sessionId: ev.thread_id }
                  } else if (ev.type === 'item.completed') {
                    const item = (ev as { item: ThreadItem }).item
                    if (item.type === 'agent_message') {
                      yield { kind: 'text', text: item.text }
                    } else if (item.type === 'mcp_tool_call') {
                      yield { kind: 'tool_call', server: item.server, tool: item.tool }
                    }
                  } else if (ev.type === 'turn.completed') {
                    yield {
                      kind: 'result',
                      sessionId: thread.id ?? '',
                      numTurns: ++turnCount,
                      durationMs: Date.now() - turnStarted,
                    }
                  } else if (ev.type === 'turn.failed') {
                    const m = ev.error.message
                    console.error(`wechat channel: [SESSION_RESULT] alias=${project.alias} provider=codex turn.failed=${m.slice(0, 400)}`)
                    yield { kind: 'error', message: m }
                  } else if (ev.type === 'error') {
                    const m = (ev as { type: 'error'; message: string }).message
                    console.error(`wechat channel: [SESSION_ERROR] alias=${project.alias} provider=codex stream-error=${m.slice(0, 400)}`)
                    yield { kind: 'error', message: m }
                  }
                }
              } catch (err) {
                const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
                console.error(`wechat channel: [SESSION_ERROR] alias=${project.alias} provider=codex dispatch threw: ${detail}`)
                throw err
              } finally {
                if (activeAborter === turnAborter) activeAborter = null
              }
            },
          }
        },
        async close(): Promise<void> {
          closed = true
          activeAborter?.abort()
        },
      }
    },
  }
}
```

The deleted `WECHAT_MCP_SERVER` constant and `REPLY_TOOL_NAMES` set are gone — those concerns are now in `agent-provider.ts`'s `isReplyToolCall`.

- [ ] **Step 5: Run tests, expect pass**

```bash
bun --bun vitest run src/core/codex-agent-provider.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add src/core/codex-agent-provider.ts src/core/codex-agent-provider.test.ts
git commit -m "feat(codex-provider): yield AgentEvents per dispatch"
```

---

### Task 4: Build `makeFakeSession` test helper

**Files:**
- Create: `src/core/test-helpers.ts` (or extend an existing test-helpers location — check the repo for the convention)

`conversation-coordinator.test.ts` (next task) will use this helper extensively. Build it once.

- [ ] **Step 1: Check for existing test-helpers location**

```bash
find src/core -name 'test-helpers*' -o -name '*test-utils*' 2>/dev/null
ls src/core | grep -i helper
```

If a file already exists, add the helper there. Otherwise create `src/core/test-helpers.ts`.

- [ ] **Step 2: Write a test for the helper itself**

```ts
// src/core/test-helpers.test.ts
import { describe, it, expect } from 'vitest'
import { makeFakeSession } from './test-helpers'
import type { AgentEvent } from './agent-provider'

async function drain(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = []
  for await (const ev of events) out.push(ev)
  return out
}

describe('makeFakeSession', () => {
  it('yields the provided events in order', async () => {
    const session = makeFakeSession({
      events: [
        { kind: 'text', text: 'hi' },
        { kind: 'result', sessionId: 's1', numTurns: 1, durationMs: 10 },
      ],
    })
    expect(await drain(session.dispatch('any'))).toEqual([
      { kind: 'text', text: 'hi' },
      { kind: 'result', sessionId: 's1', numTurns: 1, durationMs: 10 },
    ])
  })

  it('records the dispatched text', async () => {
    const dispatchSpy: string[] = []
    const session = makeFakeSession({ events: [], onDispatch: t => dispatchSpy.push(t) })
    await drain(session.dispatch('foo'))
    await drain(session.dispatch('bar'))
    expect(dispatchSpy).toEqual(['foo', 'bar'])
  })

  it('supports per-turn event lists via getEventsForTurn', async () => {
    let turn = 0
    const session = makeFakeSession({
      getEventsForTurn: () => {
        turn++
        return turn === 1
          ? [{ kind: 'text', text: 'first' } as AgentEvent]
          : [{ kind: 'text', text: 'second' } as AgentEvent]
      },
    })
    expect(await drain(session.dispatch('a'))).toEqual([{ kind: 'text', text: 'first' }])
    expect(await drain(session.dispatch('b'))).toEqual([{ kind: 'text', text: 'second' }])
  })

  it('close() resolves and subsequent dispatch yields nothing', async () => {
    const session = makeFakeSession({ events: [{ kind: 'text', text: 'x' }] })
    await session.close()
    expect(await drain(session.dispatch('after'))).toEqual([])
  })
})
```

- [ ] **Step 3: Run tests, expect failure**

```bash
bun --bun vitest run src/core/test-helpers.test.ts
```

- [ ] **Step 4: Implement `makeFakeSession`**

```ts
// src/core/test-helpers.ts
import type { AgentEvent, AgentSession } from './agent-provider'

export interface MakeFakeSessionOpts {
  /** Static event list — used if `getEventsForTurn` isn't provided. */
  events?: AgentEvent[]
  /** Per-turn event list — called once per `dispatch()`. Overrides `events`. */
  getEventsForTurn?: () => AgentEvent[]
  /** Optional spy invoked with each dispatched text. */
  onDispatch?: (text: string) => void
}

export function makeFakeSession(opts: MakeFakeSessionOpts): AgentSession {
  let closed = false
  return {
    dispatch(text: string): AsyncIterable<AgentEvent> {
      if (closed) {
        return { async *[Symbol.asyncIterator]() {} }
      }
      opts.onDispatch?.(text)
      const events = opts.getEventsForTurn ? opts.getEventsForTurn() : (opts.events ?? [])
      return {
        async *[Symbol.asyncIterator]() {
          for (const ev of events) yield ev
        },
      }
    },
    async close() { closed = true },
  }
}
```

- [ ] **Step 5: Run tests, expect pass**

```bash
bun --bun vitest run src/core/test-helpers.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add src/core/test-helpers.ts src/core/test-helpers.test.ts
git commit -m "test(core): makeFakeSession helper for AgentSession event-shape fixtures"
```

---

### Task 5: Update `conversation-coordinator.ts` (3 dispatch funcs)

**Files:**
- Modify: `src/core/conversation-coordinator.ts`

This is mechanical — three dispatch functions each have a `await handle.dispatch(text)` call that needs to be replaced with `await collectTurn(handle.dispatch(text))`. The downstream destructuring uses the same field names so no further changes.

- [ ] **Step 1: Add the import**

```diff
+import { collectTurn } from './agent-provider'
 import { evaluateRound as evaluateModeratorRound, type ModeratorDecision, type ChatroomEntry } from './chatroom-moderator'
```

- [ ] **Step 2: Update `dispatchSolo`**

```diff
   const handle = await deps.manager.acquire(proj.alias, proj.path, providerId)
   const text = deps.format(msg)
-  const result = await handle.dispatch(text)
-  const assistantTexts = result.assistantText
-  const replyToolCalled = result.replyToolCalled
+  const summary = await collectTurn(handle.dispatch(text))
+  const assistantTexts = summary.assistantText
+  const replyToolCalled = summary.replyToolCalled
```

- [ ] **Step 3: Update `dispatchParallel`**

```diff
   const handles = await Promise.all(
     parallelProviders.map(p => deps.manager.acquire(proj.alias, proj.path, p)),
   )
   const text = deps.format(msg)
-  const settled = await Promise.allSettled(handles.map(h => h.dispatch(text)))
+  const settled = await Promise.allSettled(handles.map(h => collectTurn(h.dispatch(text))))
```

The downstream loop reads `r.value.assistantText` and `r.value.replyToolCalled` — same field names on `TurnSummary`, so no further changes.

- [ ] **Step 4: Update `dispatchChatroom`**

Two call sites — the moderator-driven inner loop has `await handle.dispatch(dispatchedPrompt)`:

```diff
       try {
         const handle = await deps.manager.acquire(proj.alias, proj.path, speaker)
-        result = await handle.dispatch(dispatchedPrompt)
+        result = await collectTurn(handle.dispatch(dispatchedPrompt))
       } catch (err) {
```

The local `result` typing was previously inferred from `handle.dispatch(text)`'s return — now it's `TurnSummary`. Update the type annotation:

```diff
-      let result: { assistantText: string[]; replyToolCalled: boolean }
+      let result: import('./agent-provider').TurnSummary
```

(Or import `TurnSummary` at the top.)

- [ ] **Step 5: Run all coordinator-related tests** (they'll fail next task — this is intentional)

```bash
bun --bun vitest run src/core/conversation-coordinator.test.ts
```

Expected: many failures because the test's fake-AgentSession is still old-shape (returning Promise). That's fixed in Task 6.

- [ ] **Step 6: Run typecheck**

```bash
bun run typecheck
```

`conversation-coordinator.ts` itself should typecheck green. The errors are all in the `.test.ts` file from old-shape fixtures.

- [ ] **Step 7: Commit**

```bash
git add src/core/conversation-coordinator.ts
git commit -m "feat(coordinator): consume AgentSession via collectTurn"
```

---

### Task 6: Rewrite `conversation-coordinator.test.ts` to use `makeFakeSession`

**Files:**
- Modify: `src/core/conversation-coordinator.test.ts`

This is the biggest mechanical change of the plan. The test file is ~367 lines with ~30 test cases that build fake AgentSession instances inline. Each one must be rewritten to use `makeFakeSession({ events })`.

- [ ] **Step 1: Read the current test file**

```bash
cat src/core/conversation-coordinator.test.ts
```

Identify the patterns. Most fixture sites likely look something like:

```ts
const fakeSession = {
  dispatch: async () => ({ assistantText: ['hi'], replyToolCalled: false }),
  close: async () => {},
  onAssistantText: () => () => {},
  onResult: () => () => {},
}
```

These get replaced with:

```ts
import { makeFakeSession } from './test-helpers'

const fakeSession = makeFakeSession({
  events: [
    { kind: 'text', text: 'hi' },
    { kind: 'result', sessionId: 's1', numTurns: 1, durationMs: 10 },
  ],
})
```

- [ ] **Step 2: Add the import at the top**

```ts
import { makeFakeSession } from './test-helpers'
import type { AgentEvent } from './agent-provider'
```

- [ ] **Step 3: Rewrite each fixture**

For each occurrence of an inline fake AgentSession, translate:

| Old fake field | New equivalent |
|---|---|
| `dispatch: async () => ({ assistantText: ['hi'], replyToolCalled: false })` | `events: [{ kind: 'text', text: 'hi' }, { kind: 'result', sessionId: '_', numTurns: 1, durationMs: 0 }]` |
| `dispatch: async () => ({ assistantText: [], replyToolCalled: true })` | `events: [{ kind: 'tool_call', server: 'wechat', tool: 'reply' }, { kind: 'result', sessionId: '_', numTurns: 1, durationMs: 0 }]` |
| `dispatch: async () => ({ assistantText: ['a', 'b'], replyToolCalled: false })` | `events: [{ kind: 'text', text: 'a' }, { kind: 'text', text: 'b' }, { kind: 'result', sessionId: '_', numTurns: 1, durationMs: 0 }]` |
| `onAssistantText: ...`, `onResult: ...` | DELETE these fields entirely |

For tests that need varying behavior across dispatches (e.g. parallel mode where each provider's session emits different events), use `getEventsForTurn`:

```ts
const fakeSession = makeFakeSession({
  getEventsForTurn: () => [/* dynamic event list per call */],
})
```

If the test asserts `dispatch` was called with a specific text, use `onDispatch`:

```ts
const dispatched: string[] = []
const fakeSession = makeFakeSession({
  events: [/* ... */],
  onDispatch: t => dispatched.push(t),
})
// ... later ...
expect(dispatched).toContain('expected text')
```

- [ ] **Step 4: Run tests after each test-case rewrite**

```bash
bun --bun vitest run src/core/conversation-coordinator.test.ts
```

Iterate test-by-test. As each test goes green, move to the next.

- [ ] **Step 5: Verify the full coordinator test suite is green**

```bash
bun --bun vitest run src/core/conversation-coordinator.test.ts
```

Expected: PASS — all ~30 test cases.

- [ ] **Step 6: Run typecheck**

```bash
bun run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/core/conversation-coordinator.test.ts
git commit -m "test(coordinator): rewrite fixtures to AgentEvent shape via makeFakeSession"
```

---

### Task 7: Final integration verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

```bash
bun --bun vitest run
```

Expected: PASS. Test count baseline (1316 at v0.5.13) plus ~15 new tests for collectTurn/isReplyToolCall/makeFakeSession. The pre-existing baseline failures (citty/codex-sdk env, send-reply timeout) are unchanged.

- [ ] **Step 2: Run typecheck**

```bash
bun run typecheck
```

Expected: PASS.

- [ ] **Step 3: Run depcheck**

```bash
bun run depcheck
```

Expected: PASS — no new module-boundary violations.

- [ ] **Step 4: Run e2e (fake-ilink + fake-sdk)**

```bash
bun --bun vitest run -c vitest.e2e.config.ts
```

Expected: PASS — these tests exercise the daemon end-to-end, including the coordinator's dispatch path. The fake-sdk implementations need to be inspected for old-shape compatibility — if they implement `AgentSession`, they need the new `dispatch` shape too. Update them following the same pattern as the providers if any tests fail.

- [ ] **Step 5: Spot-check via shim against a real Claude or Codex session (optional)**

```bash
cd apps/desktop && bun shim
# Send a test message, observe daemon logs for proper event flow.
```

Look for `[STREAM_DROP]` warnings — they should be 0 in normal operation. If they fire, the event queue lifecycle has a subtle bug; review the `activeEventQueue = null` assignment timing in `claude-agent-provider.ts`.

- [ ] **Step 6: No commit needed for verification.**

If you reached this step with all green, the P2 PR is ready. Push and open `feat(p2): AgentSession unified async iterator interface`.

---

## Final notes for the implementer

- **Rewrite atomicity**: Tasks 1, 2, 3 introduce typecheck-red intermediate states. That's fine — they're separate commits and each task drives the suite green for ITS scope. The full repo greens up at Task 5 / 6.
- **Concurrent dispatch**: Claude provider now throws on second dispatch while one is in flight. Coordinator never makes parallel dispatches against the same session (parallel mode acquires DIFFERENT provider sessions). If a future change does need overlapping dispatches, that's a deliberate provider-interface evolution — don't paper over with internal queueing.
- **`tool_call` server normalisation**: Claude parses `mcp__SERVER__TOOL`; Codex passes `server` and `tool` through. Make sure `parseToolUseToEvent` handles edge cases like `mcp__weird__name__with__underscores` (the regex `^mcp__([^_]+)__(.+)$` handles it because `[^_]+` is non-greedy from the start).
- **Frequent commits**: every task ends with a commit. Don't batch.
- **e2e fake providers**: `src/daemon/__e2e__/` likely has its own fake AgentProvider. Update it if e2e tests fail in step 4.
