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
import { mergeEnvIntoMcpServers, type AgentEvent, type AgentProject, type AgentProvider, type AgentSession, type PermissionMode, type ProviderCapabilities } from './agent-provider'
import { sessionAuthEnv, type TierProfile } from './user-tier'
import { log } from '../lib/log'

/**
 * RFC 05 Phase 2 — Cursor's SDK has no per-tool callback and no
 * read-only sandbox (only workspace-write / full), and no sub-agent
 * surface (so it can't be a delegate peer in v1 — see RFC 05 §7 #3).
 * Flip `supportsDelegation` when Cursor ships sub-agent support.
 */
export const CURSOR_CAPABILITIES: ProviderCapabilities = {
  perToolCallback: false,
  sandboxLevels: new Set(['workspace-write', 'full']),
  supportsDelegation: false,
  supportsResume: true,
}

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
export function tierProfileToCursorSdkOpts(_tp: TierProfile, permissionMode: PermissionMode): CursorTierSdkOpts {
  // Cursor has no per-tool callback. The only knob is sandbox on/off.
  // Strict mode → always sandboxed (operator wanting unrestricted access
  // opts in via `--dangerously`). Pre-RFC-05 this varied by tier shape,
  // but post-C4 the "admin tier = no sandbox" shortcut conflated with
  // "admin can still call destructive Bash" — and cursor can't enforce
  // the relay, so the safer default is "sandboxed unless the operator
  // explicitly bypassed at daemon level".
  if (permissionMode === 'dangerously') {
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
  // Match against known server names (sorted longest-first so e.g.
  // `delegate_v2` is tried before `delegate`). The previous regex
  // `^mcp__([^_]+)__` rejected any server name containing `_`, and the
  // fallback indexOf('__') matched the literal `mcp` prefix instead of
  // the server — so `mcp__compass_sidecar__call` resolved to no server
  // at all and the permission/log path lost attribution.
  const names = [...mcpServerNames].sort((a, b) => b.length - a.length)
  for (const name of names) {
    // Anthropic-style with mcp prefix: mcp__<server>__<tool>
    const prefixed = `mcp__${name}__`
    if (rawName.startsWith(prefixed)) {
      return { server: name, tool: rawName.slice(prefixed.length) }
    }
    // Alternate separator forms: <server>__<tool>, <server>:<tool>, <server>/<tool>
    for (const sep of ['__', ':', '/']) {
      const probe = `${name}${sep}`
      if (rawName.startsWith(probe)) {
        return { server: name, tool: rawName.slice(probe.length) }
      }
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

/**
 * Shape of the `@cursor/sdk` module's relevant exports — narrow
 * enough that the factory can compile even when the SDK is absent.
 * The dynamically-imported module is type-erased into this surface.
 */
export interface CursorSdkNamespace {
  Agent: {
    create(options: Record<string, unknown>): Promise<unknown>
    resume?(agentId: string, options?: Record<string, unknown>): Promise<unknown>
  }
}

/**
 * Spec for an MCP server passed to Cursor. Mirrors the stdio variant
 * of Cursor's McpServerConfig (command + args + env), which matches
 * our existing McpStdioSpec from src/daemon/bootstrap/mcp-specs.ts.
 */
export interface CursorMcpStdioSpec {
  command: string
  args?: string[]
  env?: Record<string, string>
}

export interface CursorAgentProviderOptions {
  /** The dynamically-imported `@cursor/sdk` namespace (bootstrap loads it via `await import('@cursor/sdk')`). */
  sdk: CursorSdkNamespace
  /** Required — Cursor API key. Bootstrap reads from `process.env.CURSOR_API_KEY`. */
  apiKey: string
  /** Optional Cursor model id (e.g. `'composer-2'`). When omitted, SDK picks its default. */
  model?: string
  /** MCP servers passed into Agent.create — `wechat` + `delegate` come from the bootstrap. */
  mcpServers?: Record<string, CursorMcpStdioSpec>
}

interface CursorAgentLike {
  agentId: string
  send(message: string): Promise<CursorRunLike>
  close(): void
}
interface CursorRunLike {
  id: string
  agentId: string
  stream(): AsyncIterable<unknown>
  cancel?(): Promise<void>
}

export function createCursorAgentProvider(opts: CursorAgentProviderOptions): AgentProvider {
  const mcpServerNames = new Set(Object.keys(opts.mcpServers ?? {}))
  let firstToolNameLogged = false

  return {
    async spawn(project: AgentProject, spawnOpts) {
      const tierOpts = tierProfileToCursorSdkOpts(spawnOpts.tierProfile, spawnOpts.permissionMode)
      // Per-session internal-api auth — merge the env-only token + tier into
      // each stdio MCP child's env (provider-agnostic seam; same as claude/codex).
      const sessionEnv = sessionAuthEnv(spawnOpts.tierProfile, spawnOpts.sessionToken)
      const mcpWithEnv = opts.mcpServers
        ? mergeEnvIntoMcpServers(opts.mcpServers, sessionEnv)
        : undefined
      const createOptions: Record<string, unknown> = {
        apiKey: opts.apiKey,
        ...(opts.model ? { model: { id: opts.model } } : {}),
        ...(mcpWithEnv ? { mcpServers: mcpWithEnv } : {}),
        local: {
          cwd: project.path,
          sandboxOptions: tierOpts.sandboxOptions,
        },
      }
      // Resume an existing Cursor agent when the framework passes a
      // persisted session id, matching the Claude / Codex providers.
      // Pre-fix this branch was missing — Cursor sessions cold-started on
      // every daemon restart and the user's chat history / context was
      // silently lost. `Agent.resume` is declared optional in the SDK
      // namespace; if a future SDK build drops it we fall back to create.
      let agent: CursorAgentLike | null = null
      if (spawnOpts.resumeSessionId && opts.sdk.Agent.resume) {
        try {
          agent = (await opts.sdk.Agent.resume(spawnOpts.resumeSessionId, createOptions)) as CursorAgentLike
          log('SESSION_RESUME', `alias=${project.alias} agent_id=${spawnOpts.resumeSessionId} provider=cursor`)
        } catch (err) {
          // Resume can legitimately fail (agent expired, sdk-side delete);
          // fall back to a fresh agent so the user still gets a reply.
          log('SESSION_RESUME', `alias=${project.alias} agent_id=${spawnOpts.resumeSessionId} provider=cursor FAILED — fresh agent: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      if (!agent) {
        agent = (await opts.sdk.Agent.create(createOptions)) as CursorAgentLike
      }

      return makeCursorSession(agent, mcpServerNames, (rawName) => {
        if (!firstToolNameLogged) {
          firstToolNameLogged = true
          // Single observability log: helps the next engineer notice if
          // the SDK's tool name format diverges from our parser.
          // eslint-disable-next-line no-console
          console.log(`[CURSOR_TOOL] first observed tool name: ${rawName}`)
        }
      })
    },
  }
}

function makeCursorSession(
  agent: CursorAgentLike,
  mcpServerNames: ReadonlySet<string>,
  onFirstToolName: (rawName: string) => void,
): AgentSession {
  let turnCounter = 0
  return {
    dispatch(text: string) {
      const startMs = Date.now()
      turnCounter++
      const myTurns = turnCounter
      return (async function* dispatchGenerator() {
        let run: CursorRunLike
        try {
          run = await agent.send(text)
        } catch (err) {
          yield { kind: 'error', message: err instanceof Error ? err.message : String(err) } as const
          return
        }
        let sawFinish = false
        try {
          for await (const raw of run.stream() as AsyncIterable<CursorMessageLike>) {
            // Side-effect hook: log first observed tool name once
            if (raw?.type === 'assistant' && Array.isArray(raw.message?.content)) {
              for (const block of raw.message.content) {
                if (block.type === 'tool_use' && typeof block.name === 'string') {
                  onFirstToolName(block.name)
                  break
                }
              }
            }
            // Special-case status: FINISHED — emit our own result with real timings.
            if (raw?.type === 'status' && (raw as { status?: string }).status === 'FINISHED') {
              sawFinish = true
              yield {
                kind: 'result',
                sessionId: agent.agentId,
                numTurns: myTurns,
                durationMs: Date.now() - startMs,
              } as const
              continue
            }
            // All other variants → mapper handles them
            for (const ev of mapCursorMessage(raw, mcpServerNames, agent.agentId)) {
              yield ev
            }
          }
          // Stream ended without explicit FINISHED status — emit a result event anyway
          // so callers can see the dispatch concluded.
          if (!sawFinish) {
            yield {
              kind: 'result',
              sessionId: agent.agentId,
              numTurns: myTurns,
              durationMs: Date.now() - startMs,
            } as const
          }
        } catch (err) {
          yield { kind: 'error', message: err instanceof Error ? err.message : String(err) } as const
        }
      })()
    },
    async close() {
      try { agent.close() } catch { /* swallow */ }
    },
  }
}
