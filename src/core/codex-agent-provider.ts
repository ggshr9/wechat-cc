import { Codex, type Thread, type ThreadEvent, type ThreadItem } from '@openai/codex-sdk'
import type { AgentProject, AgentProvider, AgentResult, AgentSession } from './agent-provider'

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
 * Translation table from Codex SDK events to AgentSession callbacks
 * (validated against @openai/codex-sdk@0.128.0/dist/index.d.ts):
 *
 *   item.completed{type=agent_message}    → onAssistantText(item.text)
 *                                          + push to dispatch() return.assistantText
 *   item.completed{type=mcp_tool_call,    → set replyToolCalled=true
 *     server='wechat',                       (matches the wechat-mcp reply tool family;
 *     tool ∈ REPLY_TOOL_NAMES}              shipped in P1, currently inert)
 *   turn.completed{usage}                  → onResult({session_id: thread.id,
 *                                                      num_turns, duration_ms})
 *   turn.failed                            → log + throw (next dispatch fresh)
 *   error                                  → log + throw
 */

// Mirrors the Claude provider's reply-family. Tool *names* (not server-prefixed)
// because Codex's mcp_tool_call item separates server + tool fields.
const REPLY_TOOL_NAMES = new Set([
  'reply',
  'reply_voice',
  'send_file',
  'edit_message',
  'broadcast',
])
const WECHAT_MCP_SERVER = 'wechat'

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
  /** Test-only: inject a mock Codex factory. Production omits this. */
  codexFactory?: CodexFactory
}

export function createCodexAgentProvider(opts: CodexAgentProviderOptions = {}): AgentProvider {
  const factory: CodexFactory = opts.codexFactory ?? ((args) => new Codex(args))

  return {
    async spawn(project: AgentProject, spawnOpts?: { resumeSessionId?: string }): Promise<AgentSession> {
      const codex = factory({
        ...(opts.codexPathOverride ? { codexPathOverride: opts.codexPathOverride } : {}),
        // Cast through `unknown` because CodexConfigValue forbids undefined
        // and our optional fields (args?, env?) carry that variance through
        // the index signature even when always populated. SDK serialiser
        // (flattenConfigOverrides at dist/index.js:297) skips undefined
        // children so this is safe at runtime.
        ...(opts.mcpServers
          ? { config: { mcp_servers: opts.mcpServers as unknown as Record<string, never> } }
          : {}),
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

      const assistantListeners = new Set<(text: string) => void>()
      const resultListeners = new Set<(result: AgentResult) => void>()
      let turnCount = 0
      let activeAborter: AbortController | null = null
      let closed = false
      // RFC 03 P5 review #4: prepend appendInstructions exactly once per
      // session (on the first dispatch). Codex remembers it via SDK
      // conversation history; subsequent turns are unprefixed.
      let instructionsInjected = !opts.appendInstructions

      return {
        async dispatch(text: string): Promise<{ assistantText: string[]; replyToolCalled: boolean }> {
          if (closed) return { assistantText: [], replyToolCalled: false }
          const turnAborter = new AbortController()
          activeAborter = turnAborter
          const turnTexts: string[] = []
          let replyToolCalled = false
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
                  console.error(`wechat channel: [SESSION_INIT] alias=${project.alias} thread_id=${ev.thread_id} provider=codex`)
                  initEmitted = true
                }
              } else if (ev.type === 'item.completed') {
                const item = (ev as { item: ThreadItem }).item
                if (item.type === 'agent_message') {
                  turnTexts.push(item.text)
                  for (const cb of assistantListeners) cb(item.text)
                } else if (item.type === 'mcp_tool_call') {
                  if (item.server === WECHAT_MCP_SERVER && REPLY_TOOL_NAMES.has(item.tool)) {
                    replyToolCalled = true
                  }
                }
              } else if (ev.type === 'turn.completed') {
                const result: AgentResult = {
                  session_id: thread.id ?? '',
                  num_turns: ++turnCount,
                  duration_ms: Date.now() - turnStarted,
                }
                for (const cb of resultListeners) cb(result)
              } else if (ev.type === 'turn.failed') {
                const msg = ev.error.message
                console.error(`wechat channel: [SESSION_RESULT] alias=${project.alias} provider=codex turn.failed=${msg.slice(0, 400)}`)
              } else if (ev.type === 'error') {
                const msg = (ev as { type: 'error'; message: string }).message
                console.error(`wechat channel: [SESSION_ERROR] alias=${project.alias} provider=codex stream-error=${msg.slice(0, 400)}`)
              }
            }
          } catch (err) {
            const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
            console.error(`wechat channel: [SESSION_ERROR] alias=${project.alias} provider=codex dispatch threw: ${detail}`)
            throw err
          } finally {
            if (activeAborter === turnAborter) activeAborter = null
          }

          return { assistantText: turnTexts, replyToolCalled }
        },
        async close(): Promise<void> {
          closed = true
          // Codex SDK's Thread doesn't expose a `close()` — the underlying
          // codex CLI subprocess is per-runStreamed (one CLI invocation per
          // turn), so there's nothing long-running to terminate. Aborting
          // any in-flight turn is sufficient.
          activeAborter?.abort()
        },
        onAssistantText(cb) { assistantListeners.add(cb); return () => { assistantListeners.delete(cb) } },
        onResult(cb) { resultListeners.add(cb); return () => { resultListeners.delete(cb) } },
      }
    },
  }
}
