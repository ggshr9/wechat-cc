/**
 * Cursor SDK agent provider.
 *
 * Third registered provider alongside claude / codex. Uses
 * `@cursor/sdk` (loaded via dynamic import in bootstrap) and conforms
 * to the AgentProvider / AgentSession interface defined in
 * src/core/agent-provider.ts.
 *
 * Permission surface is the coarsest of the three providers — Cursor
 * has neither a per-tool callback (cf. Claude's canUseTool) nor a
 * granular sandbox shape (cf. Codex's read-only / workspace-write /
 * danger-full-access). `local.sandboxOptions: { enabled }` is the
 * entire permission surface. Tier mapping reflects that.
 *
 * See docs/superpowers/specs/2026-05-23-cursor-sdk-provider-design.md.
 */
import type { AgentEvent } from './agent-provider'
import type { TierProfile } from './user-tier'

export interface CursorTierSdkOpts {
  sandboxOptions: { enabled: boolean }
}

/**
 * Translate daemon TierProfile → Cursor SDK options.
 *
 * Heuristic: a profile with no relay and no deny is admin-equivalent
 * (sandbox off). Any non-empty relay or deny → enable sandbox. Matches
 * the same size-based heuristic Codex uses.
 *
 * Guest gets the same sandbox as trusted — Cursor lacks a read-only
 * mode, so guest can write inside cwd. Documented in README as a
 * known limitation; operators with strict guest separation route
 * guests to Claude.
 */
export function tierProfileToCursorSdkOpts(tp: TierProfile): CursorTierSdkOpts {
  if (tp.relay.size === 0 && tp.deny.size === 0) {
    return { sandboxOptions: { enabled: false } }
  }
  return { sandboxOptions: { enabled: true } }
}

/**
 * Parse Cursor's tool name into { server?, tool } for AgentEvent.
 *
 * Cursor SDK docs say "tool call schema is not stable" — the exact
 * format of SDKToolUseMessage.name is unspecified. Handle multiple
 * plausible formats; fall back to no-server if no known MCP server
 * name appears as a prefix.
 *
 * First successful tool call from Cursor logs the observed format so
 * the implementer notices if it diverges (see cursor provider's
 * dispatch loop).
 */
export function mapCursorToolName(
  rawName: string,
  mcpServerNames: ReadonlySet<string>,
): { server?: string; tool: string } {
  // Anthropic-style: mcp__<server>__<tool>
  const m = /^mcp__([^_]+)__(.+)$/.exec(rawName)
  if (m && mcpServerNames.has(m[1]!)) return { server: m[1], tool: m[2]! }
  // Alternate separator forms
  for (const sep of ['__', ':', '/']) {
    const i = rawName.indexOf(sep)
    if (i > 0 && mcpServerNames.has(rawName.slice(0, i))) {
      return { server: rawName.slice(0, i), tool: rawName.slice(i + sep.length) }
    }
  }
  // Built-in tool or unrecognized — no server
  return { tool: rawName }
}

/**
 * Narrow shape of `@cursor/sdk`'s SDKMessage discriminated union — only
 * the variants we branch on. The full union has more variants
 * (rate_limit, partial deltas, etc.); we drop them.
 *
 * Defined inline rather than importing from `@cursor/sdk` so this file
 * remains type-resolvable when the SDK is uninstalled
 * (`optionalDependencies`). The actual SDK types live alongside
 * `Agent.create()` in the dynamically-imported module.
 */
export interface CursorMessageLike {
  type: string
  message?: {
    content?: Array<{
      type?: string
      text?: string
      name?: string
      input?: unknown
    }>
  }
  status?: string
  error?: { message?: string }
}

/**
 * Map one Cursor `SDKMessage` → zero-or-more `AgentEvent`s.
 *
 * Generator shape so an assistant message with multiple content
 * blocks (text + tool_use + ...) yields each block as a separate
 * AgentEvent. The dispatch loop forwards each yielded event verbatim.
 *
 * `agentId` is the persisted session id; emitted in `result` events
 * so session-store can later resume via `Agent.resume(agentId)` (P1.1).
 *
 * Event-shape choices reflect the real `AgentEvent` discriminated
 * union in agent-provider.ts (text / tool_call / init / result /
 * error). Errors are surfaced as `{ kind: 'error', message }` —
 * matching the codex provider's `turn.failed` mapping — rather than
 * piggy-backing on `result`. CANCELLED / EXPIRED carry a stable
 * `message` string so the coordinator can branch without inspecting
 * the raw status enum.
 *
 * `numTurns` / `durationMs` are placeholders (0) when the mapper
 * emits the terminal `result`; the dispatch loop (Task 6) tracks the
 * real values and is free to substitute them. The pure mapper has no
 * access to wall-clock state.
 */
export function* mapCursorMessage(
  msg: CursorMessageLike,
  mcpServerNames: ReadonlySet<string>,
  agentId: string,
): Generator<AgentEvent, void, void> {
  if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
    for (const block of msg.message.content) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
        yield { kind: 'text', text: block.text }
      } else if (block.type === 'tool_use' && typeof block.name === 'string') {
        const { server, tool } = mapCursorToolName(block.name, mcpServerNames)
        if (server !== undefined) {
          yield { kind: 'tool_call', server, tool }
        } else {
          yield { kind: 'tool_call', tool }
        }
      }
    }
    return
  }
  if (msg.type === 'status') {
    if (msg.status === 'FINISHED') {
      yield { kind: 'result', sessionId: agentId, numTurns: 0, durationMs: 0 }
      return
    }
    if (msg.status === 'ERROR') {
      const errMsg = msg.error?.message ?? 'cursor agent error'
      yield { kind: 'error', message: errMsg }
      return
    }
    if (msg.status === 'CANCELLED') {
      yield { kind: 'error', message: 'cancelled' }
      return
    }
    if (msg.status === 'EXPIRED') {
      yield { kind: 'error', message: 'expired' }
      return
    }
    // RUNNING / CREATING — drop
    return
  }
  // thinking / system / user (echo) / request / task — drop
}
