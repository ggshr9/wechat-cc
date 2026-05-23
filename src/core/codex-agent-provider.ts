import { Codex, type Thread, type ThreadEvent, type ThreadItem } from '@openai/codex-sdk'
import { tmpdir } from 'node:os'
import type { AgentEvent, AgentProject, AgentProvider, AgentSession } from './agent-provider'
import { resolveCodexCheapModel } from './codex-cheap-model'
import type { TierProfile } from './user-tier'
import { log } from '../lib/log'

export interface CodexTierSdkOpts {
  sandboxMode: 'read-only' | 'workspace-write' | 'danger-full-access'
  approvalPolicy: 'untrusted' | 'on-request' | 'never'
}

/**
 * Pure translation from daemon TierProfile → Codex SDK options.
 *
 * Codex has no per-tool callback equivalent to Claude's canUseTool.
 * Tier enforcement is therefore coarser:
 *   - admin → full access
 *   - trusted → workspace-write sandbox (no admin UI to field
 *     'on-request' prompts, so we use 'never' approval — destructive
 *     ops within the workspace cwd are still possible; documented
 *     limitation)
 *   - guest → read-only sandbox + untrusted approval (functionally
 *     restricted to reading + replying)
 *
 * Distinguishing tiers by relay/deny size is a heuristic: a profile
 * with no relay and no deny is treated as admin-equivalent; any deny
 * presence means guest-equivalent; relay-only means trusted. This
 * works for the three default profiles; if custom profiles get added
 * later this needs revisiting.
 */
export function tierProfileToCodexSdkOpts(tp: TierProfile): CodexTierSdkOpts {
  if (tp.relay.size === 0 && tp.deny.size === 0) {
    return { sandboxMode: 'danger-full-access', approvalPolicy: 'never' }
  }
  if (tp.deny.size === 0) {
    return { sandboxMode: 'workspace-write', approvalPolicy: 'never' }
  }
  return { sandboxMode: 'read-only', approvalPolicy: 'untrusted' }
}

/**
 * codex-agent-provider — Codex SDK companion to claude-agent-provider, using
 * @openai/codex-sdk's persistent Thread API. Replaces the old one-shot
 * `codex exec` cli-provider (RFC 03 §6).
 *
 * Auth-agnostic per RFC 03 §3.6 / C7: this provider does NOT accept an
 * `apiKey` field, and does NOT pass apiKey to `new Codex({...})`. The SDK
 * transparently inherits process.env into the spawned codex CLI, so users
 * get whichever auth path they have set up locally:
 *   - `codex login` → ~/.codex/auth.json (ChatGPT subscription)
 *   - OPENAI_API_KEY / CODEX_API_KEY in env (or ~/.codex/config.toml)
 *
 * Translation table from Codex SDK events to AgentEvents:
 *
 *   thread.started                              → { kind: 'init', sessionId }
 *   item.completed{type=agent_message}          → { kind: 'text', text }
 *   item.completed{type=mcp_tool_call}          → { kind: 'tool_call', server, tool }
 *   turn.completed                              → { kind: 'result', sessionId, numTurns, durationMs }
 *   turn.failed                                 → { kind: 'error', message }
 *   error                                       → { kind: 'error', message }
 */

// Match common codex SDK auth-failure signatures. Conservative — we
// only want to special-case the ones we're confident about, since
// false positives mean the user gets "login expired" when their real
// problem is something else.
const AUTH_FAIL_RE = /(OPENAI_API_KEY|not authenticated|401 unauthorized|codex login|auth.*expired)/i

/** Test-time injection for the Codex constructor. */
export type CodexFactory = (opts: ConstructorParameters<typeof Codex>[0]) => Codex

/** stdio MCP server spec — same shape both Claude SDK + Codex CLI accept. */
export interface CodexMcpStdioServer {
  command: string
  args?: string[]
  env?: Record<string, string>
}

export interface CodexAgentProviderOptions {
  /** Optional override for the codex CLI binary path; SDK default is the @openai/codex npm dep. */
  codexPathOverride?: string
  /** Maps to ThreadOptions.model. Falsy → SDK default. */
  model?: string
  /** Maps to ThreadOptions.sandboxMode. Default 'workspace-write' (matches old cli-provider behaviour). */
  sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access'
  /**
   * Maps to ThreadOptions.approvalPolicy. Default 'never' for daemon mode
   * — RFC 03 §10 risk: `on-request` etc. likely hangs waiting for human
   * input that never comes (Spike 3 will confirm); `never` is the only
   * safe default for a long-running headless daemon.
   */
  approvalPolicy?: 'never' | 'on-request' | 'on-failure' | 'untrusted'
  /**
   * stdio MCP servers to load via SDK config flattening (RFC 03 §5.2).
   * Passed to `new Codex({ config: { mcp_servers: <this> } })`; the SDK
   * serialises each entry as `--config mcp_servers.<name>.<key>=<toml>`,
   * which the codex CLI parses into its TOML mcp_servers table on
   * startup. Spike 1 verifies the round-trip end-to-end.
   *
   * Auth-agnostic per RFC 03 §3.6 / C7: we do NOT pass the user's
   * apiKey via this channel either — env on the spawned MCP child
   * process is supplied by the caller via the `env` field.
   */
  mcpServers?: Record<string, CodexMcpStdioServer>
  /**
   * Optional system-prompt-equivalent content prepended to the FIRST
   * dispatch of each spawned thread (RFC 03 P5 review #4). Codex SDK
   * doesn't expose a true system prompt slot, so we put the wechat-channel
   * rules in the conversation history's first user message; subsequent
   * turns rely on Codex's own context retention.
   *
   * Costs ~ N tokens once per thread. Skipped when undefined / empty.
   */
  appendInstructions?: string
  /**
   * v0.5.7 — when true, sets the codex CLI's
   * `dangerously_bypass_approvals_and_sandbox=true` config (equivalent to the
   * `--dangerously-bypass-approvals-and-sandbox` CLI flag). Without this,
   * codex 0.128.0 refuses MCP tool calls with `"user cancelled MCP tool
   * call"` even under `approval_policy="never"` + `sandbox="danger-full-access"`,
   * because MCP approval has its own gate that only the bypass key opens.
   * The daemon flips this on whenever the operator passed `--dangerously` so
   * codex can actually call `mcp__wechat__reply` headlessly.
   */
  dangerouslyBypassApprovalsAndSandbox?: boolean
  /** Test-only: inject a mock Codex factory. Production omits this. */
  codexFactory?: CodexFactory
}

export function createCodexAgentProvider(opts: CodexAgentProviderOptions = {}): AgentProvider {
  const factory: CodexFactory = opts.codexFactory ?? ((args) => new Codex(args))
  // Resolve once at provider construction — auto-detect picks up new
  // model cache entries on next daemon restart, matching how the user
  // adds models (codex login → cache refreshes → restart daemon).
  const cheapModel = resolveCodexCheapModel()
  // Hoisted Codex instance reused across every cheapEval call. The
  // Codex constructor itself does NOT spawn a CLI subprocess (only
  // startThread + run/runStreamed do), so a single instance is safe to
  // share. Without this hoist, the chatroom moderator's 3-5 cheapEval
  // calls per /chat dispatch each constructed a fresh Codex →
  // measurable cold-start overhead per round.
  const cheapCodex = factory({
    ...(opts.codexPathOverride ? { codexPathOverride: opts.codexPathOverride } : {}),
  })

  return {
    async cheapEval(prompt: string): Promise<string> {
      // One-shot eval via an ephemeral thread. Minimal everything — no
      // MCP, no network, no shell, no codebase context. Used by chatroom
      // moderator + companion introspect via ProviderRegistry.getCheapEval().
      const thread = cheapCodex.startThread({
        model: cheapModel,
        modelReasoningEffort: 'minimal',
        sandboxMode: 'read-only',
        approvalPolicy: 'never',
        webSearchEnabled: false,
        webSearchMode: 'disabled',
        networkAccessEnabled: false,
        workingDirectory: tmpdir(),
        skipGitRepoCheck: true,
      })
      const turn = await thread.run(prompt)
      // Concatenate agent_message items — that's the assistant's text
      // output. Reasoning items and tool calls are filtered out.
      const parts: string[] = []
      for (const item of turn.items as ThreadItem[]) {
        if (item.type === 'agent_message') {
          parts.push((item as ThreadItem & { text: string }).text)
        }
      }
      return parts.join('')
    },
    async spawn(project: AgentProject, spawnOpts?: { resumeSessionId?: string }): Promise<AgentSession> {
      const config: Record<string, unknown> = {}
      if (opts.mcpServers) {
        // Cast through `unknown` because CodexConfigValue forbids undefined
        // and our optional fields (args?, env?) carry that variance through
        // the index signature even when always populated. SDK serialiser
        // (flattenConfigOverrides at dist/index.js:297) skips undefined
        // children so this is safe at runtime.
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
        log('SESSION_RESUME', `alias=${project.alias} thread_id=${spawnOpts.resumeSessionId} provider=codex`)
      }

      let turnCount = 0
      let activeAborter: AbortController | null = null
      let closed = false
      // RFC 03 P5 review #4: prepend appendInstructions exactly once per
      // session (on the first dispatch). Codex remembers it via SDK
      // conversation history; subsequent turns are unprefixed.
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

              // First-dispatch-only injection of channel instructions (RFC 03 P5
              // review #4). Codex SDK has no system_prompt slot; prefix the
              // user message instead. Subsequent turns rely on Codex's own
              // history retention.
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
                      log('SESSION_INIT', `alias=${project.alias} thread_id=${ev.thread_id} provider=codex`)
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
                    if (AUTH_FAIL_RE.test(m)) {
                      yield { kind: 'error', code: 'auth_failed', message: m }
                    } else {
                      yield { kind: 'error', message: m }
                    }
                  } else if (ev.type === 'error') {
                    const m = (ev as { type: 'error'; message: string }).message
                    console.error(`wechat channel: [SESSION_ERROR] alias=${project.alias} provider=codex stream-error=${m.slice(0, 400)}`)
                    if (AUTH_FAIL_RE.test(m)) {
                      yield { kind: 'error', code: 'auth_failed', message: m }
                    } else {
                      yield { kind: 'error', message: m }
                    }
                  }
                }
              } catch (err) {
                // Skip the SESSION_ERROR log on user/preempt-initiated
                // aborts — both `/stop` and "new dispatch preempts prior"
                // legitimately abort the in-flight runStreamed, and the
                // coordinator already surfaces that path silently. Logging
                // them at error severity would spam channel.log and
                // obscure real SDK failures.
                const isAbort = err instanceof Error
                  && (err.name === 'AbortError' || turnAborter.signal.aborted)
                if (!isAbort) {
                  const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
                  console.error(`wechat channel: [SESSION_ERROR] alias=${project.alias} provider=codex dispatch threw: ${detail}`)
                }
                throw err
              } finally {
                if (activeAborter === turnAborter) activeAborter = null
              }
            },
          }
        },
        async cancel(): Promise<void> {
          if (closed) return
          // Abort the in-flight runStreamed without setting closed=true,
          // so subsequent dispatches still work. The thread itself is
          // long-lived; only the per-turn CLI invocation gets killed.
          activeAborter?.abort()
        },
        async close(): Promise<void> {
          closed = true
          // Codex SDK's Thread doesn't expose a `close()` — the underlying
          // codex CLI subprocess is per-runStreamed (one CLI invocation per
          // turn), so there's nothing long-running to terminate. Aborting
          // any in-flight turn is sufficient.
          activeAborter?.abort()
        },
      }
    },
  }
}
