import { query, type Options, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { AgentEvent, AgentProject, AgentProvider, AgentSession, PermissionMode, ProviderCapabilities, SpawnContext } from './agent-provider'
import type { TierProfile, ToolKind } from './user-tier'
import { log } from '../lib/log'

/**
 * RFC 05 Phase 2 — static capabilities. Claude is the only provider with
 * a per-tool callback SDK; sandbox levels are empty because Claude has
 * no SDK-level sandbox knob (relies on canUseTool + disallowedTools).
 */
export const CLAUDE_CAPABILITIES: ProviderCapabilities = {
  perToolCallback: true,
  sandboxLevels: new Set(),
  supportsDelegation: true,
  supportsResume: true,
  defaultPeer: 'codex',
  authFailHint: '⚠ Claude 登录已过期，请在电脑上跑 `claude login` 后再发消息。',
}

/**
 * Map ToolKind → the Claude Code built-in tool names that fall into it.
 * MCP tools (mcp__wechat__*) are NOT listed — they're gated by canUseTool
 * (a per-tool callback fires for every MCP invocation), which the
 * permission-relay layer sets up.
 */
const TOOL_KIND_TO_CLAUDE_BUILTINS: Record<ToolKind, ReadonlyArray<string>> = {
  reply: [],            // MCP-only
  share_page: [],       // MCP-only
  memory_read: [],      // MCP-only
  memory_write: [],     // MCP-only
  memory_delete: [],    // MCP-only
  observations_read: [],  // MCP-only
  observations_write: [], // MCP-only
  fs_read: ['Read', 'Glob', 'Grep', 'LS'],
  fs_write: ['Write', 'Edit', 'NotebookEdit'],
  shell: ['Bash', 'KillShell'],
  shell_destructive: [],   // virtual; same Bash tool, gated by canUseTool input inspection
  network: ['WebFetch', 'WebSearch'],
  subagent: ['Task'],
  a2a_send: [],            // MCP-only
  daemon_introspect: [],   // MCP-only (mcp__wechat__diagnostic_*), gated by canUseTool
  daemon_remediate: [],    // MCP-only (mcp__wechat__session_release / model_set / daemon_restart)
}

export interface ClaudeTierSdkOpts {
  permissionMode: 'default' | 'bypassPermissions'
  disallowedTools?: string[]
}

/**
 * Pure translation from (TierProfile, permissionMode) → Claude SDK options.
 * The caller layers `canUseTool` on top of this — `disallowedTools` only
 * covers built-ins (which the SDK knows by name); MCP tools and
 * shell_destructive get filtered inside the canUseTool closure.
 *
 * `permissionMode='dangerously'` bypasses unconditionally — operator
 * opted into full SDK bypass regardless of tier. `permissionMode='strict'`
 * always uses `default` + canUseTool; tier-aware allow/relay/deny
 * decisions happen inside the canUseTool callback (see
 * `effectivePolicy` in permission-relay.ts). Pre-RFC-05 this function
 * inferred "dangerously-equivalent" from `relay.size === 0 && deny.size === 0`
 * (admin tier shape), which broke when admin tier policy changed (C4)
 * and when --dangerously didn't propagate to non-admin chats (C5).
 */
export function tierProfileToClaudeSdkOpts(tp: TierProfile, permissionMode: PermissionMode): ClaudeTierSdkOpts {
  if (permissionMode === 'dangerously') {
    return { permissionMode: 'bypassPermissions' }
  }

  // Build disallowedTools from the deny set's built-in tools only
  const disallowed: string[] = []
  for (const kind of tp.deny) {
    for (const name of TOOL_KIND_TO_CLAUDE_BUILTINS[kind]) disallowed.push(name)
  }

  return {
    permissionMode: 'default',
    ...(disallowed.length > 0 ? { disallowedTools: disallowed } : {}),
  }
}

export interface ClaudeAgentProviderOptions {
  /**
   * Build the Options bag for this spawn. `chatId` is required so the
   * builder can construct a canUseTool whose resolveTier/mode closures
   * are bound to THIS session's chatId — not the process-wide
   * `lastActiveChatId` ref, which under concurrent dispatch could read
   * another chat's id mid-call and cross-resolve the tier.
   */
  sdkOptionsForProject: (alias: string, path: string, tierProfile: TierProfile, chatId: string, mcpEnv?: Record<string, string>, appendInstructions?: string) => Options
  /**
   * Path to the `claude` binary, threaded into cheapEval's query() call.
   * Optional — when omitted the SDK's bundled discovery runs. Used in
   * production to bypass the bun-compile findClaudePath() trap that
   * affected the chatroom moderator's haiku eval (see haiku-eval.ts
   * history before its deletion in PR F).
   */
  claudeBin?: string
}

const CLAUDE_CHEAP_MODEL_DEFAULT = 'claude-haiku-4-5'

// Local mirror of the SDK message variants this provider actually reads.
// The SDK's full union (`SDKMessage`) covers many more variants but our
// streaming loop only branches on these three. Defining a narrow local
// type means every reach into the message shape goes through one cast
// (`narrow` below) — when the SDK changes shape, that's the only place
// to update.
type AssistantContent = string | Array<{ type?: string; text?: string; name?: string }>
type AssistantMsg = { type: 'assistant'; message?: { content?: AssistantContent } }
type ResultMsg = {
  type: 'result'
  subtype?: string
  session_id?: string
  num_turns?: number
  duration_ms?: number
  result?: unknown
}
type SystemMsg = { type: 'system'; subtype?: string; session_id?: string }
type NarrowedMsg = AssistantMsg | ResultMsg | SystemMsg

// Returns null for SDK message types we don't branch on (rate_limit_event,
// stream_event, partial_assistant, etc.). The caller's for-await loop
// simply skips these.
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

// The claude binary prints these literal phrases as assistant text when it
// has no usable credentials (verified by inspecting the binary's string
// table). Two distinct markers because the SDK can split a single message
// across multiple `assistant` events — matching only "/login" would leak
// the first chunk ("Not logged in") to the user before the second arrives.
// Without interception the phrase leaks to the user as if it were the AI's
// reply. We tag it with a structured error code so the coordinator can
// suppress the fallback path and respond with a controlled notification
// instead.
const AUTH_FAIL_RE = /(Please run \/login|Not logged in)/i

/**
 * Fire-and-forget invoker that survives both sync throws and async
 * rejections from SDK lifecycle methods (`interrupt`, `close`). When the
 * underlying claude subprocess has already exited (crash, OOM, abnormal
 * end), the SDK's ProcessTransport rejects with "ProcessTransport is
 * not ready for writing" — unhandled, Bun terminates the daemon.
 * Crashed sessions caught the daemon down in 2026-05-28 PDT incident
 * (sweepIdle → release → close → interrupt path).
 */
function swallowSdkLifecycleError(fn: (() => unknown) | undefined): void {
  if (!fn) return
  try {
    const r = fn()
    if (r && typeof (r as Promise<unknown>).then === 'function') {
      ;(r as Promise<unknown>).catch(() => {})
    }
  } catch {
    /* SDK transport already torn down — nothing to do */
  }
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

export function createClaudeAgentProvider(opts: ClaudeAgentProviderOptions): AgentProvider {
  return {
    async cheapEval(prompt: string): Promise<string> {
      // One-shot haiku-class eval with no tools, no MCP, no session
      // continuation. Used by chatroom moderator + companion introspect
      // via ProviderRegistry.getCheapEval(). Env override lets users
      // pin to a newer haiku without a code change.
      const model = process.env['WECHAT_CLAUDE_CHEAP_MODEL'] || CLAUDE_CHEAP_MODEL_DEFAULT
      const q = query({
        prompt,
        options: {
          model,
          maxTurns: 1,
          ...(opts.claudeBin ? { pathToClaudeCodeExecutable: opts.claudeBin } : {}),
        } as Options,
      })
      let text = ''
      for await (const raw of q as AsyncGenerator<SDKMessage>) {
        const msg = narrow(raw)
        if (msg?.type === 'assistant') {
          text += extractText(msg.message?.content)
        }
      }
      return text
    },
    async spawn(
      project: AgentProject,
      spawnOpts: SpawnContext,
    ): Promise<AgentSession> {
      const sdkQueue = new AsyncQueue<SDKUserMessage>()
      // chatId is threaded into sdkOptionsForProject so the builder can
      // produce a canUseTool whose tier/mode closures are bound to THIS
      // session — see bootstrap/index.ts:buildCanUseTool().
      const options = opts.sdkOptionsForProject(project.alias, project.path, spawnOpts.tierProfile, spawnOpts.chatId, spawnOpts.mcpEnv, spawnOpts.appendInstructions)
      if (spawnOpts.resumeSessionId) {
        ;(options as Options & { resume?: string }).resume = spawnOpts.resumeSessionId
      }

      // Wire an AbortController so close() can tell the SDK to stop and tear
      // down the underlying claude subprocess. Per sdk.d.ts: "When aborted,
      // the query will stop and clean up resources." Without it, teardown
      // relied solely on best-effort interrupt()/close() which no-op against
      // an already-dead/wedged ProcessTransport — leaving the child running
      // (the TN-zombie source). The per-turn watchdog's release→close path
      // now actually reaps the subprocess through this.
      const aborter = options.abortController ?? new AbortController()
      options.abortController = aborter

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
              // No in-flight dispatch — preserves [STREAM_DROP] behavior.
              // Trailing chunks after a result, or assistant text from an SDK
              // quirk, get logged but not attributed to a future turn.
              if (msg.type === 'assistant') {
                const text = extractText(msg.message?.content)
                if (text) {
                  droppedAssistantChunks++
                  log('STREAM_DROP', `alias=${project.alias} count=${droppedAssistantChunks} preview=${JSON.stringify(text.slice(0, 80))}`)
                }
              }
              continue
            }

            // Use a type-cast reference to work around TS6's exhaustive-narrowing
            // of the discriminated-union if/else chain, which otherwise infers
            // 'never' for activeEventQueue within individual branches.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const aq = activeEventQueue as AsyncQueue<AgentEvent>

            if (msg.type === 'system' && msg.subtype === 'init') {
              // Routed via log() (info-level) so the line lands in
              // channel.log + dashboard, not just stderr.
              log('SESSION_INIT', `alias=${project.alias} session_id=${msg.session_id ?? ''}`)
              aq.push({ kind: 'init', sessionId: msg.session_id ?? '' })
            } else if (msg.type === 'assistant') {
              const content = msg.message?.content
              // Emit tool_call events for each tool_use block
              if (Array.isArray(content)) {
                for (const block of content as Array<{ type?: string; name?: string }>) {
                  if (block?.type === 'tool_use') {
                    aq.push(parseToolUseToEvent(block))
                  }
                }
              }
              // Emit text event for any text content — UNLESS the binary is
              // surfacing its "not logged in" sentinel as assistant text. In
              // that case route it as a structured error; coordinator drops
              // the fallback-reply and emits a controlled user-facing notice.
              const text = extractText(content)
              if (text) {
                if (AUTH_FAIL_RE.test(text)) {
                  aq.push({
                    kind: 'error',
                    code: 'auth_failed',
                    message: `claude reports not logged in: ${text.slice(0, 160)}`,
                  })
                } else {
                  aq.push({ kind: 'text', text })
                }
              }
            } else if (msg.type === 'result') {
              if (msg.subtype && msg.subtype !== 'success') {
                const summary = typeof msg.result === 'string'
                  ? msg.result.slice(0, 400)
                  : JSON.stringify(msg).slice(0, 400)
                log('SESSION_RESULT', `alias=${project.alias} subtype=${msg.subtype} result=${summary}`)
                aq.push({ kind: 'error', message: `subtype=${msg.subtype}` })
              }
              aq.push({
                kind: 'result',
                sessionId: msg.session_id ?? '',
                numTurns: msg.num_turns ?? 0,
                durationMs: msg.duration_ms ?? 0,
              })
              aq.end()
              activeEventQueue = null
            }
          }
        } catch (e) {
          log('SESSION_ERROR', `alias=${project.alias} ${e instanceof Error ? `${e.name}: ${e.message}\n${e.stack}` : String(e)}`)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const catchQueue = activeEventQueue as AsyncQueue<AgentEvent> | null
          if (catchQueue) {
            const errMsg = e instanceof Error ? e.message : String(e)
            catchQueue.push({ kind: 'error', message: errMsg })
            catchQueue.end()
            activeEventQueue = null
          }
        } finally {
          drainResolve?.()
        }
      })()

      return {
        dispatch(text: string): AsyncIterable<AgentEvent> {
          if (closed) {
            // Already closed — return an iterable that yields nothing.
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
        async cancel() {
          if (closed) return
          // Signal the SDK to interrupt the in-flight dispatch (if any).
          // Don't close, don't end the queue — we rely on the SDK to emit
          // a final `result` (or `error`) message in response to interrupt,
          // which the background consumer translates into a queue end and
          // clears `activeEventQueue`. Future dispatches on this same
          // session keep working.
          //
          // SDK assumption: this contract is observed by
          // @anthropic-ai/claude-agent-sdk's binary harness but is NOT
          // documented in the SDK's public types. If a future SDK version
          // silently drops interrupts (or the underlying claude process
          // exits without flushing), the symptom would be a `collectTurn`
          // call hanging until close() is invoked. Caller mitigates by
          // also wiring the abort signal at the coordinator level so the
          // next round-entry check still terminates the loop.
          //
          // SDK lifecycle methods can synchronously throw OR return a
          // rejected promise when the underlying claude subprocess is
          // dead (ProcessTransport gone). `swallowSdkLifecycleError`
          // shields the daemon from those — see helper doc for context.
          const qIface = q as unknown as { interrupt?: () => unknown }
          swallowSdkLifecycleError(qIface.interrupt?.bind(q))
        },
        async close() {
          closed = true
          sdkQueue.end()
          const qIface = q as unknown as { close?: () => unknown; interrupt?: () => unknown }
          swallowSdkLifecycleError(qIface.close?.bind(q))
          swallowSdkLifecycleError(qIface.interrupt?.bind(q))
          // Abort last — the SDK's documented teardown. Reaps the claude
          // subprocess even when interrupt()/close() above no-op'd against a
          // dead transport. abort() itself never throws, but guard anyway.
          try { aborter.abort() } catch { /* never throws */ }
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
