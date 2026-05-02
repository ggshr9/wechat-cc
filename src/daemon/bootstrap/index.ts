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
import { formatInbound } from '../../core/prompt-format'
import type { IlinkAdapter } from '../ilink-glue'
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import { findOnPath } from '../../lib/util'
import { existsSync } from 'node:fs'
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
  const resolve = makeResolver({
    loadProjects: deps.loadProjects,
    fallback: deps.fallbackProject,
  })

  const canUseTool = makeCanUseTool({
    askUser: deps.ilink.askUser,
    defaultChatId: () => deps.lastActiveChatId(),
    log: deps.log,
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
      mcpServers: {
        ...(wechatStdioForClaude ? { wechat: { type: 'stdio' as const, ...wechatStdioForClaude } } : {}),
        ...(delegateStdioForClaude ? { delegate: { type: 'stdio' as const, ...delegateStdioForClaude } } : {}),
      },
      // Using preset+append (instead of raw string) keeps MCP tools inline in
      // the system prompt — otherwise they're deferred behind ToolSearch,
      // which adds a round-trip every time Claude wants to call `reply`
      // (~10-15s per inbound). Extra ~2-4k tokens per turn is a fair trade.
      systemPrompt: { type: 'preset', preset: 'claude_code', append: systemPrompt },
      settingSources: ['user', 'project', 'local'],
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

  const configuredAgent = loadAgentConfig(deps.stateDir)
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
  registry.register(
    'codex',
    createCodexAgentProvider({
      ...(process.env.CODEX_MODEL || configuredAgent.model
        ? { model: process.env.CODEX_MODEL ?? configuredAgent.model }
        : {}),
      // RFC 03 §10 risk: daemon mode safe defaults — no user in the loop
      // for individual tool approvals. Spike 3 confirms `on-request` likely
      // hangs; `never` is the only viable headless setting.
      approvalPolicy: 'never',
      sandboxMode: 'workspace-write',
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

  const sessionManager = new SessionManager({
    maxConcurrent: 6,
    idleEvictMs: 30 * 60_000,
    registry,
    sessionStore,
    resumeTTLMs: 7 * 24 * 60 * 60_000,
  })

  // Per-chat conversation mode (RFC 03 P2). Default for new chats =
  // `solo` with the daemon-configured provider. `/cc` `/codex` `/solo`
  // commands flip individual chats; persisted in conversations.json.
  // Caller may inject a shared instance so internal-api (which needs
  // to look up modes for reply-prefixing in P3 parallel mode) sees
  // the same flips. When absent, we own one rooted at <stateDir>.
  const conversationStore = deps.conversationStore ?? makeConversationStore(
    deps.db,
    { migrateFromFile: join(deps.stateDir, 'conversations.json') },
  )

  const coordinator = createConversationCoordinator({
    resolveProject: resolve,
    manager: sessionManager,
    conversationStore,
    registry,
    defaultProviderId,
    format: formatInbound,
    // sendAssistantText fallback path: same fall-through the legacy
    // routeInbound used to take when the agent didn't call a reply tool.
    // main.ts injects a real ilink.sendMessage closure; bootstrap.ts only
    // wires the structural piece.
    sendAssistantText: deps.ilink.sendMessage
      ? async (chatId, text) => { await deps.ilink.sendMessage(chatId, text) }
      : undefined,
    log: deps.log,
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
