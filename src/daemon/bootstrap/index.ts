/**
 * buildBootstrap — wires up the daemon's core dispatch graph.
 *
 * Composes:
 *   - Provider registry (Claude + Codex providers)
 *   - SessionManager (LRU-evicting cache of (provider, alias) → session)
 *   - ConversationStore (per-chat mode persistence)
 *   - ConversationCoordinator (mode-aware dispatch entry)
 *   - Bare delegate providers (RFC 03 P4 peer-as-tool)
 *
 * Helpers extracted for readability:
 *   - ./mcp-specs.ts   — wechat / delegate stdio MCP spec builders
 *   - ./session-paths.ts — per-provider jsonl path resolvers (canResume probes)
 *   - ./delegate.ts    — bare delegate providers + dispatchDelegate
 *
 * Imported only by:
 *   - src/daemon/main.ts (production entry)
 *   - src/daemon/bootstrap.test.ts (integration tests)
 */
import { SessionManager } from '../../core/session-manager'
import { createClaudeAgentProvider } from '../../core/claude-agent-provider'
import { createCodexAgentProvider } from '../../core/codex-agent-provider'
import { createProviderRegistry, type ProviderRegistry } from '../../core/provider-registry'
import { createConversationCoordinator, type ConversationCoordinator } from '../../core/conversation-coordinator'
import { makeConversationStore, type ConversationStore } from '../../core/conversation-store'
import { buildSystemPrompt } from '../../core/prompt-builder'
import type { ProviderId } from '../../core/conversation'
import { makeResolver } from '../../core/project-resolver'
import { makeCanUseTool } from '../../core/permission-relay'
import { lookup, assertMatrixComplete, type PermissionMode } from '../../core/capability-matrix'
import { formatInbound } from '../../core/prompt-format'
import type { IlinkAdapter } from '../ilink-glue'
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import { findOnPath, probeBinaryVersion } from '../../lib/util'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { WechatProjectsDep, WechatVoiceDep, WechatCompanionDep } from '../wechat-tool-deps'
import { makeSessionStore } from '../../core/session-store'
import type { Db } from '../../lib/db'
import { homedir } from 'node:os'
import { loadAgentConfig } from '../../lib/agent-config'
import { wechatStdioMcpSpec, delegateStdioMcpSpec, type McpStdioSpec } from './mcp-specs'
import { claudeSessionJsonlPath, codexSessionJsonlPaths } from './session-paths'
import { buildDelegateDispatch, type DelegateDispatch } from './delegate'
import { makeSendAssistantText } from './fallback-reply'
import { findCodexBinary } from '../../lib/find-codex-binary'
import { checkCodexVersion } from './codex-version-check'
import { makeHaikuEval } from './haiku-eval'
// JSON import — version field is read at module init. resolveJsonModule is
// on in tsconfig, and `with { type: 'json' }` is the spec'd syntax.
import codexCliPkg from '@openai/codex/package.json' with { type: 'json' }

/**
 * Locate a working Claude Code binary. The SDK's own native-binary detection
 * mis-picks the musl variant under bun on glibc Ubuntu (bug in libc probing);
 * passing pathToClaudeCodeExecutable bypasses that. Preference order:
 *   1. env var override
 *   2. system claude on PATH (works in any CC-installed env)
 *   3. bundled glibc variant shipped with the SDK itself
 */
function resolveClaudeBinary(): string | undefined {
  if (process.env.CLAUDE_CODE_EXECUTABLE && existsSync(process.env.CLAUDE_CODE_EXECUTABLE)) {
    return process.env.CLAUDE_CODE_EXECUTABLE
  }
  const fromPath = findOnPath('claude')
  if (fromPath && existsSync(fromPath)) return fromPath
  const here = dirname(fileURLToPath(import.meta.url))
  // src/daemon/bootstrap/index.ts → ../../../node_modules/...
  const bundled = join(here, '..', '..', '..', 'node_modules', '@anthropic-ai', 'claude-agent-sdk-linux-x64', 'claude')
  if (existsSync(bundled)) return bundled
  return undefined
}

const CLAUDE_AUTH_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
] as const

function hydrateClaudeAuthEnvFromUserSettings(log: BootstrapDeps['log']): void {
  const settingsPath = join(homedir(), '.claude', 'settings.json')
  if (!existsSync(settingsPath)) return

  try {
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf8')) as { env?: Record<string, unknown> }
    const env = parsed.env
    if (!env || typeof env !== 'object') return

    const copied: string[] = []
    for (const key of CLAUDE_AUTH_ENV_KEYS) {
      if (process.env[key]) continue
      const value = env[key]
      if (typeof value !== 'string' || value.length === 0) continue
      process.env[key] = value
      copied.push(key)
    }
    if (copied.length > 0) {
      log('BOOT', `claude auth env loaded from ~/.claude/settings.json: ${copied.join(', ')}`)
    }
  } catch {
    log('BOOT', 'claude auth env not loaded: failed to parse ~/.claude/settings.json')
  }
}

export interface BootstrapDeps {
  stateDir: string
  ilink: {
    sendMessage: (chatId: string, text: string) => Promise<{ msgId: string }>
    sendFile: (chatId: string, path: string) => Promise<void>
    editMessage: (chatId: string, msgId: string, text: string) => Promise<void>
    broadcast: (text: string, accountId?: string) => Promise<{ ok: number; failed: number }>
    sharePage: (title: string, content: string, opts?: { needs_approval?: boolean; chat_id?: string; account_id?: string }) => Promise<{ url: string; slug: string }>
    resurfacePage: (q: { slug?: string; title_fragment?: string }) => Promise<{ url: string; slug: string } | null>
    setUserName: (chatId: string, name: string) => Promise<void>
    projects: WechatProjectsDep
    voice: WechatVoiceDep
    companion: WechatCompanionDep
    askUser: (chatId: string, prompt: string, hash: string, timeoutMs: number) => Promise<'allow'|'deny'|'timeout'>
  }
  loadProjects: () => { projects: Record<string, { path: string; last_active: number }>; current: string | null }
  lastActiveChatId: () => string | null
  log: (tag: string, line: string) => void
  /**
   * Used when projects.current is unset. Prevents silent message drops on
   * fresh installs — matches v0.x UX where messages routed to the daemon's
   * launch cwd by default.
   */
  fallbackProject?: () => { alias: string; path: string } | null
  dangerouslySkipPermissions?: boolean
  agentProviderKind?: 'claude' | 'codex'
  /**
   * When provided, the standalone wechat-mcp stdio MCP server (RFC 03 §5)
   * is registered with both providers as `wechat`. The MCP child
   * process gets these env vars on spawn:
   *    WECHAT_INTERNAL_API        = baseUrl
   *    WECHAT_INTERNAL_TOKEN_FILE = tokenFilePath
   * Without this field, providers run with only the legacy in-process
   * `wechat` MCP — the stdio path is purely additive in P1.A. (P1.B
   * migrates the in-process tools and removes the legacy server.)
   */
  internalApi?: {
    baseUrl: string
    tokenFilePath: string
  }
  /**
   * Caller may inject a pre-built ConversationStore so the same instance
   * is shared with internal-api's reply-prefix lookup (RFC 03 P3). When
   * omitted, buildBootstrap creates its own — preserves test-time isolation
   * but means main.ts's internal-api can't see mode flips.
   */
  conversationStore?: ConversationStore
  /**
   * Daemon-owned SQLite connection (PR7). buildBootstrap doesn't open
   * its own — main.ts does and threads it in so all stores share one
   * file + one process-wide writer.
   */
  db: Db
}

export interface Bootstrap {
  sessionManager: SessionManager
  sessionStore: import('../../core/session-store').SessionStore
  conversationStore: ConversationStore
  registry: ProviderRegistry
  coordinator: ConversationCoordinator
  resolve: (chatId: string) => { alias: string; path: string } | null
  formatInbound: typeof formatInbound
  sdkOptionsForProject: (alias: string, path: string) => Options
  /** Daemon-default provider id — what new chats get until user runs `/cc` or `/codex`. */
  defaultProviderId: ProviderId
  /** Backward-compat alias for defaultProviderId. Pre-P2 callers expected this name. */
  agentProviderKind: ProviderId
  /**
   * RFC 03 P4 — one-shot delegate dispatcher. main.ts wires this into
   * internal-api via setDelegate() right after buildBootstrap returns.
   * Optional `cwd` per RFC 03 review #10.
   */
  dispatchDelegate: DelegateDispatch
}

// buildChannelSystemPrompt() moved to src/core/prompt-builder.ts in
// the RFC 03 review follow-up: the inline string here was v0.x and
// missed delegate_*, share_*, broadcast, set_user_name, send_file,
// edit_message — none of which were in the prompt despite being
// available tools. The prompt-builder also encodes mode-awareness so
// the agent doesn't get confused by chatroom envelopes.

export function buildBootstrap(deps: BootstrapDeps): Bootstrap {
  hydrateClaudeAuthEnvFromUserSettings(deps.log)

  const resolve = makeResolver({
    loadProjects: deps.loadProjects,
    fallback: deps.fallbackProject,
  })

  const permissionMode: PermissionMode = deps.dangerouslySkipPermissions ? 'dangerously' : 'strict'

  // Hoisted from below: canUseTool's per-dispatch mode lookup reads
  // from this store. Bootstrap's later code uses the SAME instance —
  // assigning it here just brings the creation up so the closure has a
  // live reference instead of one needing a forward declaration.
  const conversationStore = deps.conversationStore ?? makeConversationStore(
    deps.db,
    { migrateFromFile: join(deps.stateDir, 'conversations.json') },
  )

  const canUseTool = makeCanUseTool({
    askUser: deps.ilink.askUser,
    defaultChatId: () => deps.lastActiveChatId(),
    log: deps.log,
    // Per-dispatch mode lookup: read the chat's current mode from the
    // conversation store at the moment the tool call arrives. Falls back
    // to 'solo' if no chat is active or no mode persisted. Previously
    // hardcoded to 'solo' at boot — wrong for chatroom / parallel /
    // primary_tool chats which have different capability-matrix rows.
    mode: () => {
      const chatId = deps.lastActiveChatId()
      if (!chatId) return 'solo'
      return conversationStore.get(chatId)?.mode.kind ?? 'solo'
    },
    provider: 'claude',
    permissionMode,
  })

  const claudeBin = resolveClaudeBinary()
  if (!claudeBin) {
    deps.log('BOOT', 'WARNING: no Claude Code binary found — install Claude Code (`claude`) or set CLAUDE_CODE_EXECUTABLE')
  } else {
    deps.log('BOOT', `claude binary: ${claudeBin}`)
  }

  // RFC 03 §5 — standalone wechat-mcp stdio server. When deps.internalApi is
  // wired, both providers receive a `wechat` MCP server spec that spawns
  // the wechat-mcp child with token-auth env vars.
  const wechatStdioForClaude: McpStdioSpec | null = deps.internalApi ? wechatStdioMcpSpec(deps.internalApi, 'claude') : null
  const wechatStdioForCodex: McpStdioSpec | null = deps.internalApi ? wechatStdioMcpSpec(deps.internalApi, 'codex') : null

  // RFC 03 P4 — delegate-mcp stdio server. Loaded alongside wechat-mcp so
  // the primary agent can call `delegate_<peer>(prompt)` to consult the
  // OTHER provider once. The peer is fixed per-spawn.
  const delegateStdioForClaude: McpStdioSpec | null = deps.internalApi ? delegateStdioMcpSpec(deps.internalApi, 'codex') : null  // Claude session → can delegate to Codex
  const delegateStdioForCodex: McpStdioSpec | null = deps.internalApi ? delegateStdioMcpSpec(deps.internalApi, 'claude') : null  // Codex session → can delegate to Claude

  // Pin a Claude model from agent-config.json (or fall back to a stable
  // full ID). Without this, the spawned Claude Code subprocess inherits
  // whatever `~/.claude/.claude.json` says — which breaks the daemon
  // whenever the user's interactive CLI uses an alias the SDK subprocess
  // can't resolve. 2026-05-08 incident: user had fast-mode `opus[1m]`
  // configured for interactive sessions; CLI 2.1.133 mis-parsed that
  // under SDK mode and sent literal `"opus"` to the API → 404 on every
  // inbound. The codex side already pinned model from config; Claude
  // didn't, so this closes that asymmetry. Loaded once here (outside the
  // per-project closure) to keep startup config visible at boot time.
  const configuredAgent = loadAgentConfig(deps.stateDir)
  const claudeModel = configuredAgent.provider === 'claude' && configuredAgent.model
    ? configuredAgent.model
    : 'claude-opus-4-7'

  const sdkOptionsForProject = (_alias: string, path: string): Options => {
    const cstatus = deps.ilink.companion.status()
    const systemPrompt = buildSystemPrompt({
      providerId: 'claude',
      // Claude session's delegate-mcp child exposes delegate_codex.
      peerProviderId: 'codex',
      companionEnabled: cstatus.enabled,
      // wechat + delegate stdio MCP both loaded for regular sessions.
      delegateAvailable: !!delegateStdioForClaude,
    })
    const common: Options = {
      cwd: path,
      model: claudeModel,
      mcpServers: {
        ...(wechatStdioForClaude ? { wechat: { type: 'stdio' as const, ...wechatStdioForClaude } } : {}),
        ...(delegateStdioForClaude ? { delegate: { type: 'stdio' as const, ...delegateStdioForClaude } } : {}),
      },
      // Using preset+append (instead of raw string) keeps MCP tools inline in
      // the system prompt — otherwise they're deferred behind ToolSearch,
      // which adds a round-trip every time Claude wants to call `reply`
      // (~10-15s per inbound). Extra ~2-4k tokens per turn is a fair trade.
      systemPrompt: { type: 'preset', preset: 'claude_code', append: systemPrompt },
      // Drop 'user' from settingSources (2026-05-08): user-global
      // ~/.claude/settings.json is meant for the human's interactive CLI
      // — its `effortLevel`, `alwaysThinkingEnabled`, custom mcpServers,
      // model alias preferences (cf. opus[1m] / 404 incident driving
      // commit e6f40f5) shouldn't bleed into a long-running headless
      // daemon. project + local still load so a per-project .claude/
      // setup the user wires in CWD continues to work.
      settingSources: ['project', 'local'],
      ...(claudeBin ? { pathToClaudeCodeExecutable: claudeBin } : {}),
    }
    if (deps.dangerouslySkipPermissions) {
      return { ...common, permissionMode: 'bypassPermissions' }
    }
    return { ...common, permissionMode: 'default', canUseTool }
  }

  // Persistent session_id map — enables `resume` after daemon restart.
  // Each provider stores its session/thread jsonl in a different place; we
  // probe the right one before trying to resume (avoids hard error if the
  // SDK rotated or user cleared history). See ./session-paths.ts.
  const sessionStore = makeSessionStore(deps.db, { migrateFromFile: join(deps.stateDir, 'sessions.json') })
  const HOME = homedir()

  const defaultProviderId: ProviderId = deps.agentProviderKind
    ?? (process.env.WECHAT_AGENT_PROVIDER === 'codex' ? 'codex' : configuredAgent.provider)

  // RFC 03 P2 — register BOTH providers up front, regardless of which one
  // is the current default. Per-chat /cc and /codex slash commands flip
  // chats independently; the registry is the source of truth for what's
  // dispatchable. Construction is cheap (no subprocess until first
  // acquire), so we don't gate codex behind any "is the binary installed"
  // check — that's reported by `wechat-cc doctor` separately.
  // RFC 03 §3.6 / C7 — auth-agnostic. We do NOT pass `apiKey` to the codex
  // provider; the user's `codex login` or OPENAI_API_KEY env are honored
  // transparently by the SDK.
  const registry = createProviderRegistry()
  registry.register(
    'claude',
    createClaudeAgentProvider({ sdkOptionsForProject }),
    {
      displayName: 'Claude',
      canResume: (cwd, sid) => existsSync(claudeSessionJsonlPath(HOME, cwd, sid)),
    },
  )
  // Conditional codex registration (v0.5.6) — find a real codex CLI on disk.
  // The Codex SDK's internal `findCodexPath()` uses moduleRequire.resolve()
  // which can't see real node_modules from inside the bun-compiled bundle
  // (its `import.meta.url` is `/$bunfs/...`), so we MUST pass `codexPathOverride`.
  // When no codex is on disk we just don't register the provider — setMode
  // codex then 4xx's at validateMode (visible in dashboard as a red dropdown
  // border + revert) instead of silently swallowing dispatch errors per turn.
  const codexBinary = findCodexBinary()
  // Boot-time SDK ↔ CLI version match. The codex wire protocol is version-
  // locked: a mismatched CLI (e.g. globally-installed `codex` 0.125 paired
  // with our bundled SDK 0.128) silently emits events the SDK can't decode
  // and every dispatch returns empty assistantText (no reply, no error —
  // see src/lib/find-codex-binary.ts:81-86). Better to refuse registration
  // loudly than ship a provider that will silently never reply.
  const codexVersionCheck = codexBinary
    ? checkCodexVersion({
        binary: codexBinary,
        probe: probeBinaryVersion,
        expectedVersion: codexCliPkg.version,
      })
    : null
  if (codexBinary && codexVersionCheck?.ok) {
    deps.log('BOOT', `codex binary: ${codexBinary} (v${codexVersionCheck.actualSemver})`)
    registry.register(
      'codex',
      createCodexAgentProvider({
        codexPathOverride: codexBinary,
        ...(process.env.CODEX_MODEL || configuredAgent.model
          ? { model: process.env.CODEX_MODEL ?? configuredAgent.model }
          : {}),
        // RFC 03 §10 risk: daemon mode safe defaults — no user in the loop
        // for individual tool approvals. Spike 3 confirms `on-request` likely
        // hangs; `never` is the only viable headless setting.
        // Use the capability matrix as the single source of truth for the policy.
        approvalPolicy: lookup('solo', 'codex', permissionMode).approvalPolicy ?? 'never',
        // v0.5.7 — when daemon runs --dangerously, mirror the same posture
        // for codex: bypass MCP approval (else codex 0.128 cancels every
        // mcp__wechat__reply with "user cancelled MCP tool call") and remove
        // the workspace-write sandbox so the bypass is actually honoured.
        // Without this combination the user sees "no reply" silently.
        sandboxMode: permissionMode === 'dangerously' ? 'danger-full-access' : 'workspace-write',
        dangerouslyBypassApprovalsAndSandbox: permissionMode === 'dangerously',
        // RFC 03 P5 review #4: Codex SDK has no system prompt slot, so we
        // inject the channel rules into the first user message of each
        // session. Without this, Codex doesn't know to use `reply` tool
        // and falls into the FALLBACK_REPLY anomaly path on every turn.
        appendInstructions: buildSystemPrompt({
          providerId: 'codex',
          peerProviderId: 'claude',
          companionEnabled: deps.ilink.companion.status().enabled,
          delegateAvailable: !!delegateStdioForCodex,
        }),
        mcpServers: {
          ...(wechatStdioForCodex ? { wechat: wechatStdioForCodex } : {}),
          ...(delegateStdioForCodex ? { delegate: delegateStdioForCodex } : {}),
        },
      }),
      {
        displayName: 'Codex',
        canResume: (_cwd, sid) => codexSessionJsonlPaths(HOME, sid).some(p => existsSync(p)),
      },
    )
  } else if (codexBinary && codexVersionCheck && !codexVersionCheck.ok) {
    deps.log('BOOT',
      `codex provider NOT registered — version check failed. ` +
      `binary=${codexBinary} actual=${codexVersionCheck.actualSemver ?? codexVersionCheck.rawVersion ?? '(unreadable)'} ` +
      `expected=${codexVersionCheck.expectedVersion} reason=${codexVersionCheck.reason}. ` +
      `The codex SDK ↔ CLI protocol is version-locked; a mismatched CLI silently emits events the SDK can't decode (no reply ever reaches the user). ` +
      `Run \`npm i -g @openai/codex@${codexVersionCheck.expectedVersion}\` or remove the older codex from PATH.`,
    )
  } else {
    deps.log('BOOT', 'codex binary not found in PATH or ~/.nvm — codex provider not registered. Install `npm i -g @openai/codex` to enable /codex /both /chat modes.')
  }

  // Fail-fast at boot if any registered provider is missing matrix rows.
  // Was previously a module-load self-call in capability-matrix with a
  // hardcoded ['claude', 'codex'] — added providers (gemini, cursor, …)
  // would silently slip past and only throw at first use in production.
  assertMatrixComplete(registry.list())

  const sessionManager = new SessionManager({
    maxConcurrent: 6,
    idleEvictMs: 30 * 60_000,
    registry,
    sessionStore,
    resumeTTLMs: 7 * 24 * 60 * 60_000,
  })

  // Periodic idle sweep — without this, idleEvictMs is dead config (the
  // method exists but was never called from production paths). 30 min of
  // inactivity is the limit before a session is dropped; the next dispatch
  // spawns a fresh subprocess that re-reads keychain credentials. Required
  // to avoid the long-running-daemon OAuth-staleness path that surfaces as
  // the claude binary streaming "Not logged in · Please run /login" as
  // assistant text. unref() so the timer never keeps the event loop alive
  // (matters for tests that build a real bootstrap and then exit).
  const idleSweepTimer = setInterval(() => {
    sessionManager.sweepIdle().catch(err => {
      deps.log('IDLE_SWEEP', `error: ${err instanceof Error ? err.message : String(err)}`)
    })
  }, 60_000)
  idleSweepTimer.unref()

  // Per-chat conversation mode (RFC 03 P2). Default for new chats =
  // `conversationStore` is created earlier in this function (hoisted so
  // the canUseTool closure has a live reference). `/cc` `/codex` `/solo`
  // commands flip individual chats; persisted in conversations.json.
  // Caller may inject a shared instance so internal-api (which needs
  // to look up modes for reply-prefixing in P3 parallel mode) sees
  // the same flips. When absent, we own one rooted at <stateDir>.

  const coordinator = createConversationCoordinator({
    resolveProject: resolve,
    manager: sessionManager,
    conversationStore,
    registry,
    defaultProviderId,
    format: formatInbound,
    permissionMode,
    // sendAssistantText fallback path: same fall-through the legacy
    // routeInbound used to take when the agent didn't call a reply tool.
    // main.ts injects a real ilink.sendMessage closure; bootstrap.ts only
    // wires the structural piece.
    //
    // v0.5.3 — extracted to fallback-reply.ts so the failure paths log
    // [FALLBACK_REPLY_FAIL] / success path logs [FALLBACK_REPLY_SENT].
    // The previous `await ilink.sendMessage()` discard masked the
    // {msgId, error?} envelope; an ilink RETRY_FAIL was invisible to the
    // dashboard logs panel + the inbound flow.
    sendAssistantText: makeSendAssistantText({ sendMessage: deps.ilink.sendMessage, log: deps.log }),
    log: deps.log,
    // v0.5.8 — chatroom moderator. One-shot haiku-4-5 eval per round.
    // Extracted to ./haiku-eval so the AUTH_FAIL sentinel interception is
    // testable: stale moderator credentials throw with a structured error
    // + emit a loud [AUTH_FAILED] log, instead of silently degrading to
    // alternation via the parse-failed branch of evaluateRound.
    haikuEval: makeHaikuEval({ log: deps.log, ...(claudeBin ? { claudeBin } : {}) }),
  })

  // RFC 03 P4 — bare delegate providers + one-shot dispatcher.
  // See ./delegate.ts for why these are constructed separately from the
  // registry's main providers (no mcpServers — recursion prevention).
  const dispatchDelegate = buildDelegateDispatch({
    stateDir: deps.stateDir,
    ...(claudeBin ? { claudeBin } : {}),
  })

  return {
    sessionManager,
    sessionStore,
    conversationStore,
    registry,
    coordinator,
    resolve,
    formatInbound,
    sdkOptionsForProject,
    defaultProviderId,
    agentProviderKind: defaultProviderId,
    /**
     * RFC 03 P4 — late-bound into internal-api by main.ts after
     * buildBootstrap returns. The route is 503 until that wiring lands.
     */
    dispatchDelegate,
  }
}
