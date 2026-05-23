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
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

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

/**
 * Single-shot moderator script. Used by chatroom haiku eval (per-round
 * decision) and side-effects.ts isolated evals. Returns the assistant
 * text the caller will parse — typically a JSON ModeratorDecision.
 */
export interface ModeratorScript {
  onEval(prompt: string): Promise<string>
}

let claudeScript: FakeSdkScript | null = null
let codexScript: FakeSdkScript | null = null
let cursorScript: FakeSdkScript | null = null
let moderatorScript: ModeratorScript | null = null

/**
 * Optional recorder fired on every fake `query({ prompt, options })` call
 * with a streaming AsyncIterable prompt (i.e. the path
 * claude-agent-provider.ts uses for spawned sessions — NOT cheapEval).
 * Tests use this to assert the spawn-time SDK options (e.g.
 * `permissionMode`, `disallowedTools`) match the user's tier.
 *
 * Stays null unless a test calls installFakeClaudeSpawnRecorder().
 */
let claudeSpawnRecorder: ((options: Record<string, unknown>) => void) | null = null

/**
 * Optional recorder fired on every fake `Codex.startThread(opts)` and
 * `Codex.resumeThread(id, opts)` call — i.e. the codex provider's spawn
 * path (NOT cheapEval, which uses a hoisted Codex instance whose
 * cheap-thread options are read-only/never and not interesting for tier
 * tests). Tests use this to assert the spawn-time codex SDK options
 * (`sandboxMode`, `approvalPolicy`, `model`) match the user's tier.
 *
 * Stays null unless a test calls installCodexSpawnRecorder().
 */
let codexSpawnRecorder: ((options: Record<string, unknown>) => void) | null = null

/**
 * Optional recorder fired on every fake `Agent.create(options)` call —
 * i.e. the cursor provider's spawn path. Tests use this to assert
 * tier → cursor SDK options translation (parallel to
 * installClaudeSpawnRecorder / installCodexSpawnRecorder); the
 * `local.sandboxOptions.enabled` field is the entire permission
 * surface so a single recorder snapshot is enough.
 *
 * Stays null unless a test calls installCursorSpawnRecorder().
 */
let cursorSpawnRecorder: ((options: Record<string, unknown>) => void) | null = null

export function installFakeClaude(script: FakeSdkScript): { uninstall(): void } {
  claudeScript = script
  return { uninstall() { claudeScript = null } }
}

/**
 * Install a recorder that's called with the SDK options passed to
 * `query()` for every streaming (AgentSession) spawn. Returns an
 * uninstaller. Tests that want to verify tier → SDK options translation
 * (Task 17 e2e) use this.
 */
export function installClaudeSpawnRecorder(
  fn: (options: Record<string, unknown>) => void,
): { uninstall(): void } {
  claudeSpawnRecorder = fn
  return { uninstall() { claudeSpawnRecorder = null } }
}

export function installFakeCodex(script: FakeSdkScript): { uninstall(): void } {
  codexScript = script
  return { uninstall() { codexScript = null } }
}

/**
 * Install a recorder that's called with the thread options passed to
 * `Codex.startThread(opts)` / `Codex.resumeThread(id, opts)` for every
 * spawned codex session. Returns an uninstaller. Tests that want to
 * verify tier → codex SDK options translation (parallel to
 * installClaudeSpawnRecorder) use this.
 *
 * Only the per-session spawn path fires this — the cheapEval Codex
 * instance is constructed once at provider boot with hardcoded
 * read-only / never options, and its startThread calls are NOT
 * recorded (they don't reflect a user's tier).
 */
export function installCodexSpawnRecorder(
  fn: (options: Record<string, unknown>) => void,
): { uninstall(): void } {
  codexSpawnRecorder = fn
  return { uninstall() { codexSpawnRecorder = null } }
}

export function installFakeCursor(script: FakeSdkScript): { uninstall(): void } {
  cursorScript = script
  return { uninstall() { cursorScript = null } }
}

/**
 * Install a recorder that's called with the options passed to
 * `Agent.create(opts)` / `Agent.resume(id, opts)` for every spawned
 * cursor session. Returns an uninstaller. Tests that want to verify
 * tier → cursor SDK options translation (parallel to
 * installClaudeSpawnRecorder / installCodexSpawnRecorder) use this.
 *
 * Unlike Claude and Codex, Cursor has no cheap-eval path — all
 * Agent.create calls reflect a real spawn, so we don't need an
 * "only-the-streaming-path" filter here.
 */
export function installCursorSpawnRecorder(
  fn: (options: Record<string, unknown>) => void,
): { uninstall(): void } {
  cursorSpawnRecorder = fn
  return { uninstall() { cursorSpawnRecorder = null } }
}

export function installFakeModerator(script: ModeratorScript): { uninstall(): void } {
  moderatorScript = script
  return { uninstall() { moderatorScript = null } }
}

// ───────────────────────────────────────────────────────────────────────
// Tool-call → internal-api bridge
//
// In production the SDK spawns the wechat-mcp child which POSTs to the
// daemon's internal-api. Our fake yields the tool_use event but doesn't
// run the MCP child, so without a bridge `reply` etc. never produces an
// outbound sendmessage. Workaround: when the script returns toolCalls
// matching the wechat reply family, we POST directly to the daemon's
// internal-api using the token + baseUrl recorded in the test stateDir.
// ───────────────────────────────────────────────────────────────────────
const REPLY_TOOL_TO_ROUTE: Record<string, string | undefined> = {
  reply: '/v1/wechat/reply',
  reply_voice: '/v1/wechat/reply_voice',
  send_file: '/v1/wechat/send_file',
  edit_message: '/v1/wechat/edit_message',
  broadcast: '/v1/wechat/broadcast',
}

async function bridgeToolCallToInternalApi(name: string, input: unknown): Promise<void> {
  const route = REPLY_TOOL_TO_ROUTE[name]
  if (!route) return
  const stateDir = process.env.WECHAT_CC_STATE_DIR
  if (!stateDir) return
  const apiInfoPath = join(stateDir, 'internal-api-info.json')
  const tokenPath = join(stateDir, 'internal-token')
  if (!existsSync(apiInfoPath) || !existsSync(tokenPath)) return
  let apiInfo: { baseUrl?: string }
  try {
    apiInfo = JSON.parse(readFileSync(apiInfoPath, 'utf8'))
  } catch { return }
  const baseUrl = apiInfo.baseUrl
  if (!baseUrl) return
  const token = readFileSync(tokenPath, 'utf8').trim()
  try {
    await fetch(`${baseUrl}${route}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        'x-wechat-mcp-depth': '0',
      },
      body: JSON.stringify(input),
    })
  } catch (err) {
    if (process.env.E2E_DEBUG_ILINK) console.log('[fake-sdk] bridge POST failed:', err)
  }
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
  async function buildCycle(
    dispatchResult: { toolCalls: Array<{ name: string; input: unknown }>; finalText: string },
  ): Promise<Array<Record<string, unknown>>> {
    const msgs: Array<Record<string, unknown>> = []

    // Emit tool_use + tool_result pairs for each tool call AND fire the
    // internal-api bridge so reply/send_file calls actually produce an
    // outbound sendmessage in the fake-ilink outbox (mirrors the real
    // wechat-mcp child's effect).
    //
    // Name shape: claude-agent-provider parses `mcp__<server>__<tool>` to
    // populate AgentEvent.server. Tests pass the bare tool name (e.g.
    // `reply`); we wrap with the wechat-mcp prefix here so isReplyToolCall
    // detects it. Tests that genuinely want a non-MCP tool can pass a
    // name with no `__` and bypass the prefix.
    for (const tc of dispatchResult.toolCalls) {
      const toolUseId = `tu${makeId()}`
      const sdkToolName = REPLY_TOOL_TO_ROUTE[tc.name] && !tc.name.includes('__')
        ? `mcp__wechat__${tc.name}`
        : tc.name
      msgs.push({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: toolUseId, name: sdkToolName, input: tc.input }],
        },
      })
      await bridgeToolCallToInternalApi(tc.name, tc.input)
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
  const fakeQuery = (opts: { prompt: unknown; options?: unknown }) => {
    return (async function* () {
      const { prompt } = opts

      if (typeof prompt === 'string') {
        // Single-shot path: chatroom haiku moderator (bootstrap inline
        // haikuEval) + side-effects.ts makeIsolatedSdkEval (companion
        // introspect). Both consume only assistant text blocks. Prefer
        // moderatorScript when installed; fall back to claudeScript.onDispatch
        // for tests that don't distinguish.
        if (moderatorScript) {
          const decision = await moderatorScript.onEval(prompt)
          yield { type: 'assistant', message: { content: [{ type: 'text', text: decision }] } }
          yield {
            type: 'result',
            subtype: 'success',
            session_id: `sess_${makeId()}`,
            num_turns: 1,
            duration_ms: 1,
            total_cost_usd: 0,
          }
          return
        }
        const script = claudeScript
        if (!script) {
          // Emit empty assistant message so callers don't hang on an empty
          // generator. makeIsolatedSdkEval only reads assistant text blocks.
          yield { type: 'assistant', message: { content: [{ type: 'text', text: '' }] } }
          return
        }
        const result = await script.onDispatch(prompt)
        for (const msg of await buildCycle(result)) yield msg
        return
      }

      // Streaming iterable path (claude-agent-provider.ts).
      // Drain the prompt iterable; each message is one user dispatch.
      // The provider's queue emits SDKUserMessage objects.
      //
      // Fire the spawn recorder ONCE per `query()` invocation — the
      // provider calls `query({ prompt: iterable, options })` once per
      // spawn(), so this captures the spawn-time options snapshot.
      if (claudeSpawnRecorder && opts.options && typeof opts.options === 'object') {
        try { claudeSpawnRecorder(opts.options as Record<string, unknown>) } catch {}
      }
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
        for (const msg of await buildCycle(result)) yield msg
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
      // Same internal-api bridge as Claude — turns reply/send_file tool
      // calls into actual outbound sendmessage POSTs.
      await bridgeToolCallToInternalApi(tc.name, tc.input)
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
    /**
     * Thread options captured at startThread/resumeThread time. Surfaced
     * to the spawn recorder on the FIRST runStreamed() call (mirrors the
     * Claude fake, which fires its recorder inside `query()` — i.e. when
     * the spawn is actually exercised, not just constructed).
     *
     * Held as `unknown` so the field works for the cheapEval path too
     * (whose `run()` throws here so the recorder never fires anyway).
     */
    private readonly _threadOptions: Record<string, unknown> | null

    constructor(id: string | null, threadOptions?: Record<string, unknown> | null) {
      this.id = id
      this._threadOptions = threadOptions ?? null
    }

    async runStreamed(
      input: unknown,
      _opts?: { signal?: AbortSignal },
    ): Promise<{ events: AsyncGenerator<Record<string, unknown>> }> {
      const text = typeof input === 'string' ? input : JSON.stringify(input)
      const threadId = this.id ?? `thread_${makeId()}`
      const emitStarted = this._firstRun
      // Fire the spawn recorder ONCE per thread on the first runStreamed
      // — matches the Claude side, which records inside `query()` so
      // cheapEval (single-shot string path) is naturally excluded.
      // Codex's cheapEval uses `thread.run()` (which throws below), so
      // this branch is only reachable from the provider's session spawn.
      if (this._firstRun && codexSpawnRecorder && this._threadOptions) {
        try { codexSpawnRecorder(this._threadOptions) } catch {}
      }
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

    startThread(opts?: unknown): FakeCodexThread {
      return new FakeCodexThread(
        `thread_${makeId()}`,
        (opts && typeof opts === 'object') ? opts as Record<string, unknown> : null,
      )
    }

    resumeThread(id: string, opts?: unknown): FakeCodexThread {
      return new FakeCodexThread(
        id,
        (opts && typeof opts === 'object') ? opts as Record<string, unknown> : null,
      )
    }
  }

  return { Codex: FakeCodex, default: FakeCodex }
})

// ---------------------------------------------------------------------------
// Cursor SDK mock
//
// @cursor/sdk exports:
//   Agent.create(options): Promise<Agent>
//   Agent.resume(agentId, options?): Promise<Agent>
//   Agent: { agentId: string; send(message): Promise<Run>; close(): void; reload?(): Promise<void> }
//   Run:   { id: string; agentId: string; stream(): AsyncIterable<SDKMessage> }
//
// SDKMessage shapes consumed by cursor-agent-provider.ts:
//   { type: 'assistant', message: { content: Array<{type:'text'|'tool_use', text?, name?, input?}> } }
//   { type: 'status', status: 'FINISHED' | 'ERROR' | 'CANCELLED' | 'EXPIRED' | 'RUNNING' | 'CREATING',
//                     error?: { message?: string } }
//
// The cursor provider has no cheap-eval path (cf. Claude/Codex), so every
// Agent.create call is a real session spawn and is unconditionally recorded
// when cursorSpawnRecorder is installed.
// ---------------------------------------------------------------------------
vi.mock('@cursor/sdk', () => {
  function makeId(): string {
    return Math.random().toString(36).slice(2, 10)
  }

  let agentSeq = 0

  /**
   * Build the SDKMessage stream for one send() call.
   *
   * Mirrors the Claude buildCycle shape — emit one assistant message per
   * tool call (with a `tool_use` content block), one assistant message
   * with the final text, then a `status: FINISHED` terminator so the
   * provider emits a `result` event with real timings.
   *
   * Tool names get wrapped with `mcp__wechat__<name>` for reply-family
   * tools (matching the Claude fake) so the bridge POSTs through to
   * the daemon's internal-api.
   */
  async function* buildCursorStream(
    dispatchResult: { toolCalls: Array<{ name: string; input: unknown }>; finalText: string },
  ): AsyncGenerator<Record<string, unknown>> {
    for (const tc of dispatchResult.toolCalls) {
      const sdkToolName = REPLY_TOOL_TO_ROUTE[tc.name] && !tc.name.includes('__')
        ? `mcp__wechat__${tc.name}`
        : tc.name
      yield {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', name: sdkToolName, input: tc.input }],
        },
      }
      await bridgeToolCallToInternalApi(tc.name, tc.input)
    }
    if (dispatchResult.finalText) {
      yield {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: dispatchResult.finalText }],
        },
      }
    }
    yield { type: 'status', status: 'FINISHED' }
  }

  class FakeCursorRun {
    readonly id: string
    readonly agentId: string
    private readonly _text: string
    constructor(agentId: string, text: string) {
      this.id = `run_${makeId()}`
      this.agentId = agentId
      this._text = text
    }
    stream(): AsyncGenerator<Record<string, unknown>> {
      const script = cursorScript
      if (!script) {
        // No script installed — emit a single FINISHED so the dispatch
        // generator concludes (provider yields a `result` event).
        return (async function* () {
          yield { type: 'status', status: 'FINISHED' } as Record<string, unknown>
        })()
      }
      const text = this._text
      return (async function* () {
        const result = await script.onDispatch(text)
        for await (const msg of buildCursorStream(result)) yield msg
      })()
    }
    async cancel(): Promise<void> { /* no-op */ }
  }

  class FakeCursorAgent {
    readonly agentId: string
    constructor(agentId: string) {
      this.agentId = agentId
    }
    async send(message: string): Promise<FakeCursorRun> {
      return new FakeCursorRun(this.agentId, message)
    }
    close(): void { /* no-op */ }
    async reload(): Promise<void> { /* no-op */ }
  }

  const Agent = {
    create: vi.fn(async (options: Record<string, unknown>): Promise<FakeCursorAgent> => {
      if (cursorSpawnRecorder) {
        try { cursorSpawnRecorder(options) } catch {}
      }
      agentSeq++
      return new FakeCursorAgent(`fake-cursor-agent-${agentSeq}`)
    }),
    resume: vi.fn(async (agentId: string, options?: Record<string, unknown>): Promise<FakeCursorAgent> => {
      if (cursorSpawnRecorder && options) {
        try { cursorSpawnRecorder(options) } catch {}
      }
      return new FakeCursorAgent(agentId)
    }),
  }

  return { Agent }
})
