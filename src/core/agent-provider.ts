import type { TierProfile } from './user-tier'
import type { PermissionMode } from './capability-matrix'

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
  | { kind: 'error'; message: string; code?: string }

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
  /**
   * Interrupt the in-flight dispatch (if any) without closing the
   * session — future dispatches still work. Wired into the chatroom
   * loop's `/stop` and the "new dispatch preempts prior" paths.
   *
   * Optional because not every provider may have a per-turn interrupt
   * mechanism. Coordinators should treat a missing implementation as
   * "best effort" — the abort signal still propagates at round entry,
   * mid-stream cancellation just isn't available.
   */
  cancel?(): Promise<void>
  close(): Promise<void>
}

/**
 * One-shot LLM eval used for routing / observation / decision flows that
 * don't need a full session (no tools, no memory, no chat history).
 *
 * Each provider implements with its cheapest practical model + reasoning
 * effort. Latency target ≤ 5 s for ~500-token prompts; cost target
 * ≪ $0.01 per call. Replaces the prior hardcoded `claude-haiku-4-5`
 * callsites in chatroom moderator + companion introspect.
 */
export type CheapEval = (prompt: string) => Promise<string>

/**
 * Per-spawn context passed to every `AgentProvider.spawn`. RFC 05 — the
 * uniform shape lets providers (Claude / Codex / Cursor / future
 * gemini-cli) translate daemon-owned policy (tierProfile +
 * permissionMode) into their own SDK options without the daemon having
 * to know provider-specific SDK shapes.
 *
 * **`permissionMode`** is the daemon-wide flag (`--dangerously` ⇒
 * `'dangerously'`; otherwise `'strict'`). Providers MUST honor this —
 * dangerously means "operator opted into full bypass, regardless of
 * what tier this chat is in".
 *
 * Why this lives next to `tierProfile`: pre-RFC-05, providers tried to
 * infer "is this a dangerously spawn" from `tierProfile.relay.size === 0
 * && tierProfile.deny.size === 0` (admin tier shape) — that conflated
 * "this user is admin" with "operator launched --dangerously", and
 * broke silently when admin tier policy changed (C4) or when the
 * dangerously flag changed without bumping tier (C5). The fix is to
 * thread `permissionMode` explicitly.
 */
export interface SpawnContext {
  tierProfile: TierProfile
  permissionMode: PermissionMode
  /** Bound at spawn time so per-session canUseTool closures resolve the
   *  right chat's tier under concurrent dispatch (no `lastActiveChatId`
   *  process-wide reads). */
  chatId: string
  /** When set, the provider should resume an existing session (claude
   *  jsonl, codex thread id, cursor agent id) instead of cold-starting. */
  resumeSessionId?: string
}

export interface AgentProvider {
  /**
   * Spawn a session. See `SpawnContext` for the per-spawn shape;
   * provider-construction opts (model, mcpServers, claude binary,
   * etc.) come from the factory call.
   *
   * Concurrency: providers are NOT required to support overlapping
   * spawns or dispatches on the same session. Coordinators serialise
   * per-chat.
   */
  spawn(project: AgentProject, ctx: SpawnContext): Promise<AgentSession>
  /**
   * Optional one-shot eval. Coordinators that need cheap routing /
   * decision LLM calls should resolve via `ProviderRegistry.getCheapEval()`
   * instead of calling this directly — the registry picks the cheapest
   * available provider's implementation. Missing implementation means
   * the provider doesn't have a lightweight one-shot path; callers
   * should fall back gracefully (skip the eval-driven feature).
   */
  cheapEval?: CheapEval
}

/**
 * Shared sentinel detector for the Claude binary's "not logged in" /
 * Codex's auth-failure markers when surfaced as the response text of a
 * cheapEval call. Lifted out of bootstrap/haiku-eval so all callers
 * (chatroom moderator + companion introspect) handle auth_failed
 * consistently — throw, let the caller decide on fallback.
 *
 * Regex is INTENTIONALLY narrow — only the exact phrases the binaries
 * emit on credential failure. Earlier draft included bare
 * `OPENAI_API_KEY` but that fires on legitimate LLM responses that
 * happen to quote the env-var name ("what does OPENAI_API_KEY do?" in
 * the moderator's view, "remember: put OPENAI_API_KEY in .env" in an
 * introspect memory snapshot). Stick to error-shape phrases only.
 */
const AUTH_FAIL_RE = /(Please run \/login|Not logged in|not authenticated|401 unauthorized|please run `?codex login|OPENAI_API_KEY (?:not|is not|missing|required)|auth(?:entication)?\s+(?:expired|failed))/i

export function assertNotAuthFailed(text: string, log: (tag: string, line: string) => void, source: string): void {
  if (AUTH_FAIL_RE.test(text)) {
    log('AUTH_FAILED', `${source} credentials stale: ${text.slice(0, 160)}`)
    throw new Error(`auth_failed: ${text.slice(0, 120)}`)
  }
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
  /** Provider-emitted error code (e.g. 'auth_failed') — lets the coordinator
   *  branch on failure category without string-matching the message. */
  errorCode?: string
}

export async function collectTurn(events: AsyncIterable<AgentEvent>): Promise<TurnSummary> {
  const texts: string[] = []
  let replyToolCalled = false
  let result: TurnSummary['result']
  let error: string | undefined
  let errorCode: string | undefined
  for await (const ev of events) {
    if (ev.kind === 'text') {
      texts.push(ev.text)
    } else if (ev.kind === 'tool_call' && isReplyToolCall(ev)) {
      replyToolCalled = true
    } else if (ev.kind === 'result') {
      result = { sessionId: ev.sessionId, numTurns: ev.numTurns, durationMs: ev.durationMs }
    } else if (ev.kind === 'error') {
      error = ev.message
      if (ev.code) errorCode = ev.code
    }
  }
  return { assistantText: texts, replyToolCalled, result, error, errorCode }
}
