import { SessionManager } from '../core/session-manager'
import { createClaudeAgentProvider } from '../core/claude-agent-provider'
import { createCodexAgentProvider } from '../core/codex-agent-provider'
import { createProviderRegistry, type ProviderRegistry } from '../core/provider-registry'
import { createConversationCoordinator, type ConversationCoordinator } from '../core/conversation-coordinator'
import { makeConversationStore, type ConversationStore } from '../core/conversation-store'
import { providerDisplayName as defaultProviderDisplayName } from './provider-display-names'
import type { ProviderId } from '../core/conversation'
import { makeResolver } from '../core/project-resolver'
import { makeCanUseTool } from '../core/permission-relay'
import { formatInbound } from '../core/prompt-format'
import type { IlinkAdapter } from './ilink-glue'
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import { findOnPath } from '../../util'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { WechatProjectsDep, WechatVoiceDep, WechatCompanionDep } from './wechat-tool-deps'
import { makeSessionStore } from '../core/session-store'
import { homedir } from 'node:os'
import { loadAgentConfig } from '../../agent-config'

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
}

function buildChannelSystemPrompt(companionEnabled: boolean, _currentPersona: string | null): string {
  const base = `你在 wechat-cc 的消息通道里接收来自作者个人微信的消息。规则：
- 每条入站消息用 <wechat chat_id="..." user="..." account="..." msg_type="..." ts="...">...</wechat> 包裹。回复时用 reply 工具（不要直接生成文本）。
- chat_id 是路由键；多条连续对话可能来自同一个 chat_id。
- 媒体附件以 [image:/abs/path] [file:/abs/path] [voice:/abs/path] 行内标注，用 Read/Bash 等工具打开或分析它们。
- /project 相关意图可以调 list_projects / switch_project / add_project / remove_project。
- 用户是个人开发者，偏好简短直接的中文回复。
- reply_voice 仅在用户明确要求语音回复时使用（消息中含 "语音回复" / "念一下" / "speak it" / "say it aloud" 等）。其他情况一律用 reply 回复文本。reply_voice 不适合代码块、URL、长列表。
- 如果用户第一次要求语音但未配置：先调 voice_config_status 检查；未配置则调 reply 引导用户发 API 配置（例如 VoxCPM2 的 base_url http://<mac>:8000/v1/audio/speech + model openbmb/VoxCPM2），再调 save_voice_config 保存。

你有 \`~/.claude/channels/wechat/memory/\` 目录，完全由你自治。用它跨会话记住这个用户 — 身份、偏好、正在做的事、上次 push 被怎么反应、技能模式（"他焦躁时该少说"）、什么梗、禁区。
- 工具: memory_read(path) / memory_write(path, content) / memory_list(dir?)。只允许 .md，单文件 100KB 上限，相对路径。
- 组织方式你自己定: 文件名、子目录、何时整理归并 — 比我更懂。一个合理的起点是 chat_id 作为子目录前缀（\`memory/<chat_id>/profile.md\`）避免多用户串味；但这是 convention，不是强制。
- 写入时机: 回复用户前先 memory_list + 读你认为相关的文件（避免从零开始）。回复后有值得记的就写 — 短一句话也行。
- 当 memory_list 返回几十个老文件时: 自行合并归并（读多份→写一篇 dense 的→删老的）。这是你的"睡觉整理"。相信你的判断力，没有任何规则能替代它。
- 留给未来的你看的，不是给当前对话用的 — 写时想想 3 个月后的你。`

  if (!companionEnabled) return base

  return base + `

---
Companion 主动推送模式已开启。

- 定时 tick: 每 15-30 分钟（jitter）scheduler 会唤醒你一次。唤醒时先 memory_list + 读相关文件 + 看当前时间上下文 → 决定是否 push 以及说什么。不确定就选"不打扰"。
- 推送后: 写 memory 记这次 push 的意图和后续观察 — 用户是否回复、情绪如何、是 positive/negative/ignored。下次决策会读到。
- 反感信号: 用户说"别烦我"/"停"/类似 → 调 companion_snooze。明示要关 → 调 companion_disable。
- 这套自学习不是靠规则，是你读 memory 自己判断。连续 3 次 push 被 ignored，你会在 memory 里记下来并自行调整频率 — 这就是"越来越聪明"。`
}

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

  const sdkOptionsForProject = (_alias: string, path: string): Options => {
    const cstatus = deps.ilink.companion.status()
    // Companion v2 dropped per_project_persona — Claude self-adjusts tone from
    // memory/ notes instead. currentPersona is no longer passed.
    const systemPrompt = buildChannelSystemPrompt(cstatus.enabled, null)
    const common: Options = {
      cwd: path,
      mcpServers: {
        ...(wechatStdioForClaude ? { wechat: { type: 'stdio' as const, ...wechatStdioForClaude } } : {}),
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
    // Codex's session files are sharded by date (~/.codex/sessions/YYYY/MM/DD/<id>.jsonl).
    // We don't know which date, so we glob via existsSync + a tiny manual walk.
    // For a P0 cheap check we just look for the unsharded fallback (top-level file)
    // and the dateless directory; if not found we return [] and skip-resume rather
    // than do a deep scan. False-negative resume is recoverable; false-positive resume
    // throws on the SDK side which is louder than we want.
    const root = join(HOME, '.codex', 'sessions')
    return [
      join(root, `${threadId}.jsonl`),
      join(root, `${threadId}.json`),
    ]
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
      ...(wechatStdioForCodex ? { mcpServers: { wechat: wechatStdioForCodex } } : {}),
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
  }
}
