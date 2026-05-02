import { SessionManager } from '../core/session-manager'
import { createClaudeAgentProvider } from '../core/claude-agent-provider'
import { createCodexAgentProvider } from '../core/codex-agent-provider'
import { createProviderRegistry, type ProviderRegistry } from '../core/provider-registry'
import { createConversationCoordinator, type ConversationCoordinator } from '../core/conversation-coordinator'
import { makeConversationStore, type ConversationStore } from '../core/conversation-store'
import { providerDisplayName as defaultProviderDisplayName } from './provider-display-names'
import { buildSystemPrompt } from '../core/prompt-builder'
import type { ProviderId } from '../core/conversation'
import { makeResolver } from '../core/project-resolver'
import { makeCanUseTool } from '../core/permission-relay'
import { formatInbound } from '../core/prompt-format'
import type { IlinkAdapter } from './ilink-glue'
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import { findOnPath } from '../lib/util'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { WechatProjectsDep, WechatVoiceDep, WechatCompanionDep } from './wechat-tool-deps'
import { makeSessionStore } from '../core/session-store'
import { homedir } from 'node:os'
import { loadAgentConfig } from '../lib/agent-config'

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
  const bundled = join(here, '..', '..', 'node_modules', '@anthropic-ai', 'claude-agent-sdk-linux-x64', 'claude')
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
}

export interface Bootstrap {
  sessionManager: SessionManager
  sessionStore: import('../core/session-store').SessionStore
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
  dispatchDelegate: (peer: ProviderId, prompt: string, cwd?: string) => Promise<
    | { ok: true; response: string; num_turns?: number; duration_ms?: number }
    | { ok: false; reason: string }
  >
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
  // Note: MemoryFS is no longer constructed here — main.ts owns the
  // single instance and passes it to createInternalApi (which serves the
  // memory_* HTTP routes). The legacy in-process `wechat` MCP that used
  // to consume it via toolDeps is gone in RFC 03 P1.B B1.

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
  // History: from P1.A through P1.B B6 the stdio server was named
  // `wechat_ipc` to coexist with the legacy in-process `wechat` server.
  // After B1 the legacy server is gone and the stdio one inherits the
  // canonical `wechat` name — keeping tool names like `mcp__wechat__reply`
  // stable for the agent and the providers' replyToolCalled detection.
  //
  // The optional `participantTag` (RFC 03 P3) is the providerId baked into
  // the child's env so the stdio reply tool can identify which agent
  // generated each reply. internal-api uses this to prefix `[Claude]` /
  // `[Codex]` in parallel + chatroom modes.
  function wechatStdioMcpSpec(participantTag?: ProviderId): { command: string; args: string[]; env: Record<string, string> } | null {
    if (!deps.internalApi) return null
    const here = dirname(fileURLToPath(import.meta.url))
    // src/daemon/bootstrap.ts → ../mcp-servers/wechat/main.ts
    const mainPath = join(here, '..', 'mcp-servers', 'wechat', 'main.ts')
    return {
      command: process.execPath,  // bun or node — whichever is running the daemon
      args: [mainPath],
      env: {
        WECHAT_INTERNAL_API: deps.internalApi.baseUrl,
        WECHAT_INTERNAL_TOKEN_FILE: deps.internalApi.tokenFilePath,
        ...(participantTag ? { WECHAT_PARTICIPANT_TAG: participantTag } : {}),
      },
    }
  }
  const wechatStdioForClaude = wechatStdioMcpSpec('claude')
  const wechatStdioForCodex = wechatStdioMcpSpec('codex')

  // RFC 03 P4 — delegate-mcp stdio server. Loaded alongside wechat-mcp
  // so the primary agent can call `delegate_<peer>(prompt)` to consult
  // the OTHER provider once. The peer is fixed per-spawn via the
  // WECHAT_DELEGATE_PEER env.
  function delegateStdioMcpSpec(peer: ProviderId): { command: string; args: string[]; env: Record<string, string> } | null {
    if (!deps.internalApi) return null
    const here = dirname(fileURLToPath(import.meta.url))
    const mainPath = join(here, '..', 'mcp-servers', 'delegate', 'main.ts')
    return {
      command: process.execPath,
      args: [mainPath],
      env: {
        WECHAT_INTERNAL_API: deps.internalApi.baseUrl,
        WECHAT_INTERNAL_TOKEN_FILE: deps.internalApi.tokenFilePath,
        WECHAT_DELEGATE_PEER: peer,
      },
    }
  }
  // For each provider session, the peer is the OTHER provider.
  const delegateStdioForClaude = delegateStdioMcpSpec('codex')  // Claude session → can delegate to Codex
  const delegateStdioForCodex = delegateStdioMcpSpec('claude')  // Codex session → can delegate to Claude

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
  // Each provider stores its session/thread jsonl in a different place:
  //   Claude:  ~/.claude/projects/<encoded-cwd>/<session_id>.jsonl
  //   Codex:   ~/.codex/sessions/**/<thread_id>.jsonl  (rollout file)
  // We probe the right one before trying to resume (avoids hard error if
  // the SDK rotated or user cleared history).
  const sessionStore = makeSessionStore(join(deps.stateDir, 'sessions.json'), { debounceMs: 500 })
  const HOME = homedir()
  function claudeSessionJsonlPath(cwd: string, sessionId: string): string {
    const encoded = cwd.replace(/\//g, '-')
    return join(HOME, '.claude', 'projects', encoded, `${sessionId}.jsonl`)
  }
  function codexSessionJsonlPaths(threadId: string): string[] {
    // Codex's session files are sharded by date (~/.codex/sessions/YYYY/MM/DD/<thread_id>.jsonl).
    // RFC 03 P5 review #9 — earlier P0 implementation only checked the
    // unsharded path (`~/.codex/sessions/<id>.jsonl`) which never matches
    // real Codex output → resume always silently failed. Now does a
    // bounded depth-3 walk under ~/.codex/sessions for files matching
    // `<threadId>.jsonl` or `<threadId>.json`.
    const root = join(HOME, '.codex', 'sessions')
    const candidates: string[] = [
      // Unsharded fallback first (cheapest existsSync check).
      join(root, `${threadId}.jsonl`),
      join(root, `${threadId}.json`),
    ]
    if (!existsSync(root)) return candidates
    try {
      // Walk: <root>/<YYYY>/<MM>/<DD>/<id>.{jsonl,json}
      // Bounded by Codex's known sharding scheme (year/month/day) so we
      // don't accidentally scan unbounded user dirs.
      const { readdirSync, statSync } = require('node:fs') as typeof import('node:fs')
      for (const year of safeReaddir(root, readdirSync)) {
        const yearDir = join(root, year)
        if (!isDir(yearDir, statSync)) continue
        for (const month of safeReaddir(yearDir, readdirSync)) {
          const monthDir = join(yearDir, month)
          if (!isDir(monthDir, statSync)) continue
          for (const day of safeReaddir(monthDir, readdirSync)) {
            const dayDir = join(monthDir, day)
            if (!isDir(dayDir, statSync)) continue
            candidates.push(
              join(dayDir, `${threadId}.jsonl`),
              join(dayDir, `${threadId}.json`),
            )
          }
        }
      }
    } catch {
      // permissions / EIO — fall back to unsharded candidates only.
    }
    return candidates
  }
  function safeReaddir(p: string, readdirSync: typeof import('node:fs').readdirSync): string[] {
    try { return readdirSync(p) } catch { return [] }
  }
  function isDir(p: string, statSync: typeof import('node:fs').statSync): boolean {
    try { return statSync(p).isDirectory() } catch { return false }
  }

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
      canResume: (cwd, sid) => existsSync(claudeSessionJsonlPath(cwd, sid)),
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
      canResume: (_cwd, sid) => codexSessionJsonlPaths(sid).some(p => existsSync(p)),
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
    join(deps.stateDir, 'conversations.json'),
    { debounceMs: 500 },
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

  // RFC 03 P4 — bare delegate providers. Constructed separately from
  // the registry's main providers because they intentionally have NO
  // mcpServers configured: a delegated peer must not have access to
  // wechat tools (would let it pretend to reply directly to the user)
  // or its own delegate-mcp (would allow recursion). Recursion
  // prevention is structural here, not counter-based.
  //
  // Each delegate call spawns a fresh thread; SessionManager isn't
  // involved because these are throwaway one-shot consultations.
  const delegateClaude = createClaudeAgentProvider({
    sdkOptionsForProject: (_alias: string, path: string): Options => {
      const o: Options = {
        cwd: path,
        // Plain claude_code preset — no wechat-specific append. Peer
        // doesn't see wechat conversation history; it's a clean slate.
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        settingSources: ['user', 'project', 'local'],
        // Safer than bypassPermissions: delegate is read-mostly. Skip
        // the permission relay too — there's no human to ask, and
        // delegated peers shouldn't be writing to disk anyway.
        permissionMode: 'default',
        ...(claudeBin ? { pathToClaudeCodeExecutable: claudeBin } : {}),
      }
      return o
    },
  })
  const delegateCodex = createCodexAgentProvider({
    ...(process.env.CODEX_MODEL || configuredAgent.model
      ? { model: process.env.CODEX_MODEL ?? configuredAgent.model }
      : {}),
    approvalPolicy: 'never',
    // Read-only sandbox: delegate is for "ask a question", not "do work".
    // Spike 3 confirmed read-only blocks writes cleanly.
    sandboxMode: 'read-only',
    // Deliberately NO mcpServers — bare-bones is the structural
    // recursion-prevention guarantee.
  })

  /**
   * Run a one-shot prompt against the bare delegate provider for `peer`.
   * Used by internal-api's /v1/delegate route. Spawns a fresh thread,
   * dispatches once, closes. Cold-start cost (~3-5s) per call is
   * accepted as the price of "consult the peer cleanly."
   *
   * `cwd` (RFC 03 review #10): when caller passes one, peer can Read /
   * Bash files there (e.g. the calling agent's project). Otherwise
   * peer runs in deps.stateDir (a stable location with no project
   * files), preserving the "ask, don't do" framing.
   */
  async function dispatchDelegate(
    peer: ProviderId,
    prompt: string,
    cwd?: string,
  ): Promise<{ ok: true; response: string; num_turns?: number; duration_ms?: number } | { ok: false; reason: string }> {
    const provider = peer === 'claude' ? delegateClaude
                   : peer === 'codex' ? delegateCodex
                   : null
    if (!provider) return { ok: false, reason: `unknown_peer: ${peer}` }
    const started = Date.now()
    let session: Awaited<ReturnType<typeof provider.spawn>> | null = null
    try {
      session = await provider.spawn({ alias: '_delegate', path: cwd ?? deps.stateDir })
      const result = await session.dispatch(prompt)
      const response = result.assistantText.join('\n').trim()
      return { ok: true, response, duration_ms: Date.now() - started }
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) }
    } finally {
      if (session) {
        try { await session.close() } catch { /* swallow shutdown errors */ }
      }
    }
  }

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
