/**
 * Fake SDK installer for daemon e2e tests.
 *
 * Replaces @anthropic-ai/claude-agent-sdk and @openai/codex-sdk with
 * script-driven fakes. Each test passes a FakeSdkScript whose onDispatch
 * is invoked when the daemon's AgentSession.dispatch(text) is called.
 *
 * Uses vi.mock — this file MUST be imported in the test file (or via
 * setupFiles) BEFORE the daemon imports the SDKs. The harness.ts ensures
 * this ordering.
 *
 * ## Audit findings (Step 0)
 *
 * ### @anthropic-ai/claude-agent-sdk
 *   - Used in two places:
 *     1. claude-agent-provider.ts: `query({ prompt: AsyncIterable<SDKUserMessage>, options })`
 *        yields SDKMessage objects; the provider iterates `type='assistant'`,
 *        `type='result'`, `type='system'` messages.
 *     2. side-effects.ts: `query({ prompt: string, options })` — single-shot
 *        Haiku eval (makeIsolatedSdkEval). Also reads assistant+text blocks.
 *   - The fake query handles both calling conventions (string OR AsyncIterable
 *     prompt). When prompt is an AsyncIterable we drive dispatches from
 *     claudeScript; when it's a plain string we do a single onDispatch call.
 *
 * ### @openai/codex-sdk
 *   - Exports: `Codex` class (constructor + startThread/resumeThread),
 *     `Thread` (id, runStreamed), `ThreadEvent`, `ThreadItem` types.
 *   - codex-agent-provider.ts uses `codexFactory` injection for unit tests;
 *     for e2e we mock the SDK module itself so the factory falls through to
 *     `new Codex(args)` and hits our fake class instead.
 *   - Thread.runStreamed(input, opts) → { events: AsyncGenerator<ThreadEvent> }
 *   - Events consumed: thread.started, item.completed{agent_message / mcp_tool_call},
 *     turn.completed, turn.failed, error.
 */
import { vi } from 'vitest'

export interface FakeSdkScript {
  /**
   * Called when AgentSession.dispatch(text) runs. Returns what tool calls
   * to "emit" and the final reply text the agent produces.
   */
  onDispatch(text: string): Promise<{
    toolCalls: Array<{ name: string; input: unknown }>
    finalText: string
  }>
}

let claudeScript: FakeSdkScript | null = null
let codexScript: FakeSdkScript | null = null

export function installFakeClaude(script: FakeSdkScript): { uninstall(): void } {
  claudeScript = script
  return { uninstall() { claudeScript = null } }
}

export function installFakeCodex(script: FakeSdkScript): { uninstall(): void } {
  codexScript = script
  return { uninstall() { codexScript = null } }
}

// ---------------------------------------------------------------------------
// Claude SDK mock
//
// `query` is called with either:
//   { prompt: string, options }          — single-shot eval (side-effects.ts)
//   { prompt: AsyncIterable<msg>, options } — streaming session (claude-agent-provider.ts)
//
// For the streaming (AgentSession) case:
//   The provider pushes one SDKUserMessage per dispatch() call onto the queue
//   and awaits a `result` event to resolve each dispatch(). We must therefore
//   iterate the prompt iterable and emit one (assistant? + result) cycle per
//   message consumed from it. When the iterable ends (queue.end() called on
//   close()), we stop.
//
// For the single-shot string case we emit exactly one cycle then stop.
// ---------------------------------------------------------------------------
vi.mock('@anthropic-ai/claude-agent-sdk', () => {
  function makeId(): string {
    return Math.random().toString(36).slice(2, 10)
  }

  /**
   * Build a single dispatch cycle: tool-use blocks + final text + result event.
   * Returns the array of SDKMessage-shaped objects to yield.
   */
  function buildCycle(
    dispatchResult: { toolCalls: Array<{ name: string; input: unknown }>; finalText: string },
  ): Array<Record<string, unknown>> {
    const msgs: Array<Record<string, unknown>> = []

    // Emit tool_use + tool_result pairs for each tool call.
    for (const tc of dispatchResult.toolCalls) {
      const toolUseId = `tu${makeId()}`
      msgs.push({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: toolUseId, name: tc.name, input: tc.input }],
        },
      })
      msgs.push({
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok' }],
        },
      })
    }

    // Emit text reply if present.
    if (dispatchResult.finalText) {
      msgs.push({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: dispatchResult.finalText }],
        },
      })
    }

    // Always emit a result event so the provider resolves the pending turn.
    msgs.push({
      type: 'result',
      subtype: 'success',
      session_id: `sess_${makeId()}`,
      num_turns: 1,
      duration_ms: 10,
      total_cost_usd: 0,
    })

    return msgs
  }

  /**
   * Fake `query` implementation.
   *
   * Accepts both { prompt: string } and { prompt: AsyncIterable<SDKUserMessage> }.
   * Returns an AsyncGenerator of SDKMessage-shaped objects.
   */
  const fakeQuery = (opts: { prompt: unknown }) => {
    return (async function* () {
      const { prompt } = opts

      if (typeof prompt === 'string') {
        // Single-shot path (makeIsolatedSdkEval in side-effects.ts).
        const script = claudeScript
        if (!script) {
          // Emit empty assistant message so callers don't hang on an empty
          // generator. makeIsolatedSdkEval only reads assistant text blocks.
          yield { type: 'assistant', message: { content: [{ type: 'text', text: '' }] } }
          return
        }
        const result = await script.onDispatch(prompt)
        for (const msg of buildCycle(result)) yield msg
        return
      }

      // Streaming iterable path (claude-agent-provider.ts).
      // Drain the prompt iterable; each message is one user dispatch.
      // The provider's queue emits SDKUserMessage objects.
      const iterable = prompt as AsyncIterable<{ message?: { content?: Array<{ type?: string; text?: string }> } }>
      for await (const userMsg of iterable) {
        // Extract the user text from the SDKUserMessage payload.
        const content = userMsg?.message?.content
        const text = Array.isArray(content)
          ? content.map(b => (b?.type === 'text' ? (b.text ?? '') : '')).join('')
          : ''

        const script = claudeScript
        if (!script) {
          // No script installed — yield empty cycle so the turn resolves.
          yield { type: 'assistant', message: { content: [{ type: 'text', text: '' }] } }
          yield {
            type: 'result',
            subtype: 'success',
            session_id: `sess_${makeId()}`,
            num_turns: 1,
            duration_ms: 10,
            total_cost_usd: 0,
          }
          continue
        }

        const result = await script.onDispatch(text)
        for (const msg of buildCycle(result)) yield msg
      }
    })()
  }

  return { query: fakeQuery }
})

// ---------------------------------------------------------------------------
// Codex SDK mock
//
// @openai/codex-sdk exports:
//   class Codex { startThread(opts): Thread; resumeThread(id, opts): Thread }
//   Thread: { id: string|null; runStreamed(input, opts): Promise<{events: AsyncGenerator<ThreadEvent>}> }
//
// ThreadEvent shapes consumed by codex-agent-provider.ts:
//   { type: 'thread.started', thread_id: string }
//   { type: 'item.completed', item: ThreadItem }
//     ThreadItem = { type: 'agent_message', text: string }
//                | { type: 'mcp_tool_call', server: string, tool: string, input?: unknown }
//   { type: 'turn.completed', usage?: unknown }
//   { type: 'turn.failed', error: { message: string } }
//   { type: 'error', message: string }
// ---------------------------------------------------------------------------
vi.mock('@openai/codex-sdk', () => {
  function makeId(): string {
    return Math.random().toString(36).slice(2, 10)
  }

  /**
   * Build a complete turn's ThreadEvent sequence for one dispatch() call.
   * Mirrors the real SDK's event ordering: started → items → turn.completed.
   */
  async function* buildTurnEvents(
    threadId: string,
    text: string,
    emitStarted: boolean,
  ): AsyncGenerator<Record<string, unknown>> {
    const script = codexScript
    if (!script) {
      if (emitStarted) yield { type: 'thread.started', thread_id: threadId }
      yield { type: 'turn.completed', usage: null }
      return
    }

    if (emitStarted) yield { type: 'thread.started', thread_id: threadId }

    const result = await script.onDispatch(text)

    // Emit mcp_tool_call items for the wechat reply tool family.
    for (const tc of result.toolCalls) {
      // The provider checks item.server === 'wechat' and item.tool ∈ REPLY_TOOL_NAMES.
      // We emit each tool call as a completed mcp_tool_call item so
      // replyToolCalled is set correctly.
      yield {
        type: 'item.completed',
        item: {
          type: 'mcp_tool_call',
          server: 'wechat',
          tool: tc.name,
          input: tc.input,
        },
      }
    }

    // Emit the final text as an agent_message item.
    if (result.finalText) {
      yield {
        type: 'item.completed',
        item: { type: 'agent_message', text: result.finalText },
      }
    }

    yield { type: 'turn.completed', usage: null }
  }

  class FakeCodexThread {
    readonly id: string | null
    private _firstRun = true

    constructor(id: string | null) {
      this.id = id
    }

    async runStreamed(
      input: unknown,
      _opts?: { signal?: AbortSignal },
    ): Promise<{ events: AsyncGenerator<Record<string, unknown>> }> {
      const text = typeof input === 'string' ? input : JSON.stringify(input)
      const threadId = this.id ?? `thread_${makeId()}`
      const emitStarted = this._firstRun
      this._firstRun = false

      return { events: buildTurnEvents(threadId, text, emitStarted) }
    }

    // Satisfy the Thread interface — provider uses runStreamed exclusively.
    async run(): Promise<never> {
      throw new Error('FakeCodexThread.run: not implemented; provider uses runStreamed')
    }
  }

  class FakeCodex {
    constructor(_opts?: unknown) {}

    startThread(_opts?: unknown): FakeCodexThread {
      return new FakeCodexThread(`thread_${makeId()}`)
    }

    resumeThread(id: string, _opts?: unknown): FakeCodexThread {
      return new FakeCodexThread(id)
    }
  }

  return { Codex: FakeCodex, default: FakeCodex }
})
