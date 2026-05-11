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
