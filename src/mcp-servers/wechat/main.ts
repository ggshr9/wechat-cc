#!/usr/bin/env bun
/**
 * wechat-mcp — standalone stdio MCP server (RFC 03 §5).
 *
 * Loaded by both the Claude Agent SDK and Codex SDK as a stdio MCP
 * server. Exposes the wechat tool family (P1.B will populate it: reply,
 * memory_*, voice_*, projects_*, ...). For P1.A there's only one tool —
 * `ping` — which calls daemon's internal-api `/v1/health` to prove the
 * full provider → stdio MCP → loopback HTTP → daemon round-trip works.
 *
 * Two env vars must be set by the spawning daemon:
 *   WECHAT_INTERNAL_API        e.g. http://127.0.0.1:54321
 *   WECHAT_INTERNAL_TOKEN_FILE absolute path to mode-0600 token file
 *
 * Stdout is the MCP transport — DO NOT write logs there. All logs go
 * to stderr.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { createInternalApiClient, InternalApiError } from './client'

function logErr(line: string): void {
  process.stderr.write(`[wechat-mcp] ${line}\n`)
}

const baseUrl = process.env.WECHAT_INTERNAL_API
const tokenFilePath = process.env.WECHAT_INTERNAL_TOKEN_FILE

if (!baseUrl || !tokenFilePath) {
  logErr('FATAL: WECHAT_INTERNAL_API and WECHAT_INTERNAL_TOKEN_FILE env vars are required')
  logErr(`got WECHAT_INTERNAL_API=${baseUrl ?? '(unset)'} WECHAT_INTERNAL_TOKEN_FILE=${tokenFilePath ?? '(unset)'}`)
  process.exit(2)
}

const client = createInternalApiClient({
  baseUrl,
  tokenFilePath,
  logger: logErr,
})

const server = new McpServer(
  { name: 'wechat-mcp', version: '0.1.0' },
  { capabilities: { tools: {} } },
)

// Admin-session flag, derived from the non-secret WECHAT_SESSION_TIER the
// daemon bakes into THIS MCP child's env at spawn (next to the secret
// WECHAT_SESSION_TOKEN). The agent runs in the LLM and cannot alter this env,
// so gating the daemon-control tools (diagnostic_* / model_* / session_release
// / daemon_restart) on it is robust on EVERY provider — including codex, which
// has no per-tool canUseTool callback. Non-admin sessions simply don't get the
// tools registered, AND the route layer rejects a non-admin token anyway
// (defence in depth).
const SESSION_IS_ADMIN = process.env.WECHAT_SESSION_TIER === 'admin'

// ──────────────────────────────────────────────────────────────────────
// Tools
// ──────────────────────────────────────────────────────────────────────
//
// P1.A: just `ping`. Tool list will grow in P1.B. Each tool's
// implementation is a thin wrapper over the internal-api client; the
// real logic lives in src/features/tools.ts → bridged via internal-api.

server.registerTool(
  'ping',
  {
    title: 'Ping daemon',
    description: 'Round-trips a request through the daemon internal-api and returns its pid. Used by integration tests to verify the full MCP-over-stdio + internal-api channel is alive.',
    inputSchema: {},
    outputSchema: {
      ok: z.boolean(),
      daemon_pid: z.number(),
    },
  },
  async () => {
    try {
      const resp = await client.request<{ ok: boolean; daemon_pid: number }>('GET', '/v1/health')
      return {
        content: [{ type: 'text', text: JSON.stringify(resp) }],
        structuredContent: resp,
      }
    } catch (err) {
      logErr(`ping failed: ${formatError(err)}`)
      return {
        content: [{ type: 'text', text: `ping failed: ${formatError(err)}` }],
        isError: true,
      }
    }
  },
)

// ─── memory_* (RFC 03 P1.B B2) ──────────────────────────────────────────
// Mirror legacy wire shapes (features/tools.ts:313-357) so the system
// prompt's tool documentation continues to read true. These tools were
// in the in-process `wechat` server before B2; now they live exclusively
// here. P1.B keeps them sandboxed under `<stateDir>/memory/` via
// MemoryFS — same instance as before, called over loopback.

server.registerTool(
  'memory_read',
  {
    title: 'Read memory file',
    description: '读 memory/ 下的一个文件。不存在返回 exists:false。相对路径，只允许 .md。',
    inputSchema: { path: z.string() },
  },
  async ({ path }) => {
    try {
      const resp = await client.request<{ exists: boolean; content?: string; error?: string }>(
        'POST', '/v1/memory/read', { path },
      )
      // Preserve legacy wire shape: agent sees the same JSON it always saw.
      return { content: [{ type: 'text', text: JSON.stringify(resp) }] }
    } catch (err) {
      return passthroughErrorResult(err, 'memory_read')
    }
  },
)

server.registerTool(
  'memory_write',
  {
    title: 'Write memory file',
    description: '写 memory/ 下的一个文件（atomic, 覆盖）。相对路径，只允许 .md。单文件 100KB 上限。父目录自动创建。',
    inputSchema: { path: z.string(), content: z.string() },
  },
  async ({ path, content }) => {
    try {
      const resp = await client.request<{ ok: boolean; error?: string }>(
        'POST', '/v1/memory/write', { path, content },
      )
      return { content: [{ type: 'text', text: JSON.stringify(resp) }] }
    } catch (err) {
      return passthroughErrorResult(err, 'memory_write')
    }
  },
)

server.registerTool(
  'memory_list',
  {
    title: 'List memory files',
    description: '列 memory/ 下所有 .md 文件（递归）。传 dir 只列该子目录。返回相对路径数组。',
    // Refine `dir`: cap length + reject null bytes. Defense-in-depth for
    // the downstream /v1/memory/list URL — encodeURIComponent doesn't
    // protect against URL-shape attacks at the daemon's HTTP layer if
    // the daemon ever trusts the path beyond its sandboxed memory root.
    inputSchema: {
      dir: z.string()
        .max(512, 'dir must be <= 512 chars')
        .refine(s => !s.includes('\0'), { message: 'dir must not contain null bytes' })
        .optional(),
    },
  },
  async ({ dir }) => {
    try {
      const qs = dir ? `?dir=${encodeURIComponent(dir)}` : ''
      const resp = await client.request<{ files: string[]; error?: string }>(
        'GET', `/v1/memory/list${qs}`,
      )
      return { content: [{ type: 'text', text: JSON.stringify(resp) }] }
    } catch (err) {
      return passthroughErrorResult(err, 'memory_list')
    }
  },
)

server.registerTool(
  'memory_delete',
  {
    title: 'Soft-delete a memory file',
    description:
      '把 memory/ 下的一个 .md 文件"软删除"——重命名为 .deleted-<时间> 后缀，不进入 memory_list() 结果；用户可在终端 mv 还原。\n' +
      '何时调用：用户明确说"忘了/删掉/不要这个了"。不要因为"觉得过时了"主观删除。\n' +
      '硬删除：本工具不提供。若需彻底擦除（隐私 / 法律原因），让用户手动 rm `~/.claude/channels/wechat/memory/<chat>/<path>.deleted-*`。\n' +
      '必填 reason：写下用户说了什么 / 你为何认为该删，会进 audit 日志（dashboard 可查），方便事后追溯。',
    inputSchema: {
      chat_id: z.string(),
      path: z.string()
        .max(500, 'path must be <= 500 chars')
        .refine(s => !s.includes('\0'), { message: 'path must not contain null bytes' }),
      reason: z.string()
        .min(4, 'reason must be at least 4 chars — quote the user or state your inference')
        .max(500, 'reason must be <= 500 chars'),
    },
  },
  async ({ chat_id, path, reason }) => {
    try {
      const resp = await client.request<{
        ok: boolean
        tombstone?: string
        existed?: boolean
        error?: string
      }>('POST', '/v1/memory/delete', { chat_id, path, reason })
      return { content: [{ type: 'text', text: JSON.stringify(resp) }] }
    } catch (err) {
      return passthroughErrorResult(err, 'memory_delete')
    }
  },
)

// ─── projects + user name (RFC 03 P1.B B3) ───────────────────────────────
// Legacy descriptions kept verbatim — agent's mental model unchanged.

server.registerTool(
  'list_projects',
  {
    title: 'List projects',
    description: '列出已注册的项目及当前项目。',
    inputSchema: {},
  },
  async () => {
    try {
      const arr = await client.request<unknown>('GET', '/v1/projects/list')
      return { content: [{ type: 'text', text: JSON.stringify(arr) }] }
    } catch (err) {
      return passthroughErrorResult(err, 'list_projects')
    }
  },
)

server.registerTool(
  'switch_project',
  {
    title: 'Switch project',
    description: '切换到指定项目别名。',
    inputSchema: { alias: z.string() },
  },
  async ({ alias }) => {
    try {
      const r = await client.request<unknown>('POST', '/v1/projects/switch', { alias })
      return { content: [{ type: 'text', text: JSON.stringify(r) }] }
    } catch (err) {
      return passthroughErrorResult(err, 'switch_project')
    }
  },
)

server.registerTool(
  'add_project',
  {
    title: 'Register a new project',
    description: '注册一个新项目（别名 + 绝对路径）。',
    inputSchema: { alias: z.string(), path: z.string() },
  },
  async ({ alias, path }) => {
    try {
      const r = await client.request<unknown>('POST', '/v1/projects/add', { alias, path })
      return { content: [{ type: 'text', text: JSON.stringify(r) }] }
    } catch (err) {
      return passthroughErrorResult(err, 'add_project')
    }
  },
)

server.registerTool(
  'remove_project',
  {
    title: 'Remove a project',
    description: '移除一个已注册的项目。',
    inputSchema: { alias: z.string() },
  },
  async ({ alias }) => {
    try {
      const r = await client.request<unknown>('POST', '/v1/projects/remove', { alias })
      return { content: [{ type: 'text', text: JSON.stringify(r) }] }
    } catch (err) {
      return passthroughErrorResult(err, 'remove_project')
    }
  },
)

server.registerTool(
  'set_user_name',
  {
    title: 'Persist a wechat user display name',
    description: '记住新用户的显示名称。',
    inputSchema: { chat_id: z.string(), name: z.string() },
  },
  async ({ chat_id, name }) => {
    try {
      const r = await client.request<unknown>('POST', '/v1/user/set_name', { chat_id, name })
      return { content: [{ type: 'text', text: JSON.stringify(r) }] }
    } catch (err) {
      return passthroughErrorResult(err, 'set_user_name')
    }
  },
)

// ─── voice config (RFC 03 P1.B B4) ───────────────────────────────────────
// Note: `reply_voice` lives in B1 — it crosses the ilink boundary to
// actually send a voice message and is the riskier slice. These two
// just read/write the local TTS config.

server.registerTool(
  'voice_config_status',
  {
    title: 'Get TTS config status',
    description: '查询当前 TTS 配置状态。不返回 api_key，只返回 provider、默认音色、base_url/model（如果是 http_tts）、saved_at。',
    inputSchema: {},
  },
  async () => {
    try {
      const r = await client.request<unknown>('GET', '/v1/voice/status')
      return { content: [{ type: 'text', text: JSON.stringify(r) }] }
    } catch (err) {
      return passthroughErrorResult(err, 'voice_config_status')
    }
  },
)

server.registerTool(
  'save_voice_config',
  {
    title: 'Save TTS config (with test-synth validation)',
    description: '保存 TTS 配置。provider=http_tts 时必须提供 base_url + model（常见：VoxCPM2 通过本地 vllm serve --omni 部署）；provider=qwen 时必须提供 api_key。保存前会做一次 1 秒测试合成验证。',
    inputSchema: {
      provider: z.enum(['http_tts', 'qwen']),
      base_url: z.string().url().optional(),
      model: z.string().optional(),
      api_key: z.string().optional(),
      default_voice: z.string().optional(),
    },
  },
  async (args) => {
    try {
      const r = await client.request<unknown>('POST', '/v1/voice/save_config', args)
      return { content: [{ type: 'text', text: JSON.stringify(r) }] }
    } catch (err) {
      return passthroughErrorResult(err, 'save_voice_config')
    }
  },
)

// ─── share_page / resurface_page (RFC 03 P1.B B5) ────────────────────────

server.registerTool(
  'share_page',
  {
    title: 'Publish Markdown to a one-time URL',
    description: '把 Markdown 内容发布为一次性 URL。返回 {url, slug}。needs_approval=true 时页面会渲染 ✓ Approve 按钮（默认 false，纯内容文档不带按钮）。chat_id 传入后页脚会出现"📄 发 PDF 到微信"按钮，点击会把 PDF 推到该 chat。',
    inputSchema: {
      title: z.string(),
      content: z.string(),
      needs_approval: z.boolean().optional(),
      chat_id: z.string().optional(),
      account_id: z.string().optional(),
    },
  },
  async (args) => {
    try {
      const r = await client.request<unknown>('POST', '/v1/share/page', args)
      return { content: [{ type: 'text', text: JSON.stringify(r) }] }
    } catch (err) {
      return passthroughErrorResult(err, 'share_page')
    }
  },
)

server.registerTool(
  'resurface_page',
  {
    title: 'Resurface a previously shared page',
    description: '根据 slug 或标题片段重新生成一个有效 URL。',
    inputSchema: {
      slug: z.string().optional(),
      title_fragment: z.string().optional(),
    },
  },
  async (args) => {
    try {
      const r = await client.request<unknown>('POST', '/v1/share/resurface', args)
      return { content: [{ type: 'text', text: JSON.stringify(r) }] }
    } catch (err) {
      return passthroughErrorResult(err, 'resurface_page')
    }
  },
)

// ─── ilink-bound message family (RFC 03 P1.B B1) ─────────────────────────
// reply / reply_voice / send_file / edit_message / broadcast — the
// "reply-tool family" detected by both providers' replyToolCalled flag.
// After B1 these are exposed by the stdio `wechat` server (renamed back
// from `wechat_ipc`), matching what claude-agent-provider's REPLY_TOOL_NAMES
// set and codex-agent-provider's WECHAT_MCP_SERVER='wechat' check expect.
// Legacy 中文 descriptions kept verbatim so the system prompt stays accurate.

// RFC 03 P3: when daemon spawns this MCP child it sets WECHAT_PARTICIPANT_TAG
// to the providerId (e.g. 'claude' / 'codex'). The reply tool forwards
// the tag in its body so internal-api can prefix `[Claude]` / `[Codex]`
// in parallel + chatroom modes. In solo mode the tag is ignored.
const PARTICIPANT_TAG = process.env.WECHAT_PARTICIPANT_TAG

server.registerTool(
  'reply',
  {
    title: 'Reply text to a wechat user',
    description: '给当前微信用户回复文本。chat_id 必填。长文本会自动分段。',
    inputSchema: { chat_id: z.string(), text: z.string() },
  },
  async ({ chat_id, text }) => {
    try {
      const r = await client.request<unknown>('POST', '/v1/wechat/reply', {
        chat_id, text,
        ...(PARTICIPANT_TAG ? { participant_tag: PARTICIPANT_TAG } : {}),
      })
      return { content: [{ type: 'text', text: JSON.stringify(r) }] }
    } catch (err) {
      return passthroughErrorResult(err, 'reply')
    }
  },
)

server.registerTool(
  'reply_voice',
  {
    title: 'Reply via voice message',
    description: '用语音回复用户。仅在用户明确要求语音回复时使用（"念一下"/"语音回复"/"speak it" 等）。文本 ≤ 500 字；不适合代码块、长 URL、结构化列表。',
    inputSchema: { chat_id: z.string(), text: z.string() },
  },
  async ({ chat_id, text }) => {
    try {
      const r = await client.request<unknown>('POST', '/v1/wechat/reply_voice', { chat_id, text })
      return { content: [{ type: 'text', text: JSON.stringify(r) }] }
    } catch (err) {
      return passthroughErrorResult(err, 'reply_voice')
    }
  },
)

server.registerTool(
  'send_file',
  {
    title: 'Send a local file to a wechat user',
    description: '给当前用户发送文件（本地绝对路径）。',
    inputSchema: { chat_id: z.string(), path: z.string() },
  },
  async ({ chat_id, path }) => {
    try {
      const r = await client.request<unknown>('POST', '/v1/wechat/send_file', { chat_id, path })
      return { content: [{ type: 'text', text: JSON.stringify(r) }] }
    } catch (err) {
      return passthroughErrorResult(err, 'send_file')
    }
  },
)

server.registerTool(
  'edit_message',
  {
    title: 'Edit a previously-sent message',
    description: '编辑已发送的消息（需要 msg_id）。',
    inputSchema: { chat_id: z.string(), msg_id: z.string(), text: z.string() },
  },
  async ({ chat_id, msg_id, text }) => {
    try {
      const r = await client.request<unknown>('POST', '/v1/wechat/edit_message', { chat_id, msg_id, text })
      return { content: [{ type: 'text', text: JSON.stringify(r) }] }
    } catch (err) {
      return passthroughErrorResult(err, 'edit_message')
    }
  },
)

server.registerTool(
  'broadcast',
  {
    title: 'Broadcast text to all online users',
    description: '向所有在线用户群发文本。account_id 可选（不填则默认主账号）。',
    inputSchema: { text: z.string(), account_id: z.string().optional() },
  },
  async (args) => {
    try {
      const r = await client.request<unknown>('POST', '/v1/wechat/broadcast', args)
      return { content: [{ type: 'text', text: JSON.stringify(r) }] }
    } catch (err) {
      return passthroughErrorResult(err, 'broadcast')
    }
  },
)

// ─── companion proactive tick (RFC 03 P1.B B6) ───────────────────────────

server.registerTool(
  'companion_enable',
  {
    title: 'Enable Companion proactive ticks',
    description: '开启 Companion 主动关心：你在聊天里记下的待跟进（agenda.md）到点时系统会唤醒你来兑现。第一次调用会创建 config.json 并返回欢迎消息。幂等。',
    inputSchema: {},
  },
  async () => {
    try {
      const r = await client.request<unknown>('POST', '/v1/companion/enable')
      return { content: [{ type: 'text', text: JSON.stringify(r) }] }
    } catch (err) {
      return passthroughErrorResult(err, 'companion_enable')
    }
  },
)

server.registerTool(
  'companion_disable',
  {
    title: 'Disable Companion proactive ticks',
    description: '关闭 Companion 主动推送。下一次 scheduler tick 不再触发。',
    inputSchema: {},
  },
  async () => {
    try {
      const r = await client.request<unknown>('POST', '/v1/companion/disable')
      return { content: [{ type: 'text', text: JSON.stringify(r) }] }
    } catch (err) {
      return passthroughErrorResult(err, 'companion_disable')
    }
  },
)

server.registerTool(
  'companion_status',
  {
    title: 'Companion status',
    description: '查询 Companion 状态：是否开启、时区、默认 chat_id、snooze 截止时间。人格 / 触发器等历史详情请从 memory/ 读。',
    inputSchema: {},
  },
  async () => {
    try {
      const r = await client.request<unknown>('GET', '/v1/companion/status')
      return { content: [{ type: 'text', text: JSON.stringify(r) }] }
    } catch (err) {
      return passthroughErrorResult(err, 'companion_status')
    }
  },
)

server.registerTool(
  'companion_snooze',
  {
    title: 'Snooze proactive pushes',
    description: '暂停所有主动推送若干分钟。用户说 "别烦我"/"停"/"snooze N 小时"/"shut up" 等时调用。',
    inputSchema: { minutes: z.number().int().min(1).max(24 * 60) },
  },
  async ({ minutes }) => {
    try {
      const r = await client.request<unknown>('POST', '/v1/companion/snooze', { minutes })
      return { content: [{ type: 'text', text: JSON.stringify(r) }] }
    } catch (err) {
      return passthroughErrorResult(err, 'companion_snooze')
    }
  },
)

// ─── a2a outbound send ────────────────────────────────────────────────────────

server.registerTool(
  'a2a_send',
  {
    title: 'Send to A2A agent',
    description: '给已注册的外部 A2A agent 发送消息。用于操作者让你"回复 [A2A:xxx]"那条通知时——agent_id 就是 [A2A:<id>] 前缀里的 id。返回 { ok, http_status?, error?, registered? }。',
    inputSchema: {
      agent_id: z.string().describe('已注册的 agent id，例如 deploy-bot'),
      text: z.string().describe('要发给该 agent 的消息正文'),
    },
  },
  async ({ agent_id, text }) => {
    try {
      const resp = await client.request<unknown>('POST', '/v1/a2a/send', { agent_id, text })
      return { content: [{ type: 'text', text: JSON.stringify(resp) }] }
    } catch (err) {
      return passthroughErrorResult(err, 'a2a_send')
    }
  },
)

// ─── daemon self-diagnosis + remediation (admin-only) ─────────────────────────
// Registered ONLY for an admin-tier session (WECHAT_SESSION_TIER=admin, set by the
// daemon at spawn). This is the robust, provider-agnostic gate — for non-admin
// sessions (including codex, which has no canUseTool) the tools don't exist.
// The claude canUseTool layer (daemon_introspect/daemon_remediate denied for
// trusted/guest) is a second, defence-in-depth gate on top.
if (SESSION_IS_ADMIN) {

// These let the operator ask the bot "检查下为什么 X 不回消息了". Read-only.

server.registerTool(
  'diagnostic_turns',
  {
    title: 'Recent turn outcomes',
    description: '【管理员】查询每个对话回合的结局（completed/timeout/auth_failed/error）、耗时、是否回复，用于诊断"为什么某个 chat 不回消息了"。给 chatId 看该 chat 最近的回合（倒序）；不给则看全局最近。limit 默认 50。',
    inputSchema: {
      chatId: z.string().optional().describe('微信 chat_id；省略则返回所有 chat 的最近回合'),
      limit: z.number().int().min(1).max(500).optional(),
    },
  },
  async ({ chatId, limit }) => {
    try {
      const qs = new URLSearchParams()
      if (chatId) qs.set('chatId', chatId)
      if (limit != null) qs.set('limit', String(limit))
      const r = await client.request<unknown>('GET', `/v1/turns${qs.toString() ? `?${qs}` : ''}`)
      return { content: [{ type: 'text', text: JSON.stringify(r) }] }
    } catch (err) {
      return passthroughErrorResult(err, 'diagnostic_turns')
    }
  },
)

server.registerTool(
  'diagnostic_sessions',
  {
    title: 'Live agent sessions',
    description: '【管理员】列出当前缓存的 agent 会话（alias / provider / chat_id / lastUsedAt）。lastUsedAt 很久以前说明该会话可能闲置或卡住。用于判断哪个会话需要释放/重启。',
    inputSchema: {},
  },
  async () => {
    try {
      const r = await client.request<unknown>('GET', '/v1/sessions')
      return { content: [{ type: 'text', text: JSON.stringify(r) }] }
    } catch (err) {
      return passthroughErrorResult(err, 'diagnostic_sessions')
    }
  },
)

server.registerTool(
  'diagnostic_health',
  {
    title: 'Daemon health',
    description: '【管理员】daemon 总体健康：pid、turn 记录存储是否就绪、当前活跃会话数、心跳是否新鲜（heartbeat_fresh=false 表示 daemon 可能卡住/没在服务）。',
    inputSchema: {},
  },
  async () => {
    try {
      const r = await client.request<unknown>('GET', '/v1/health')
      return { content: [{ type: 'text', text: JSON.stringify(r) }] }
    } catch (err) {
      return passthroughErrorResult(err, 'diagnostic_health')
    }
  },
)

// ─── daemon remediation (admin-only, mutating) ────────────────────────────────
// The "fix" half of the self-heal loop. Same admin gating (ToolKind
// 'daemon_remediate', denied for trusted/guest). Each returns a verification
// read-back so the agent can confirm the action took effect before reporting.

server.registerTool(
  'model_get',
  {
    title: 'Current model',
    description: '【管理员】读取当前固定的 agent 模型（provider + model）。改之前/之后用它核对。',
    inputSchema: {},
  },
  async () => {
    try {
      const r = await client.request<unknown>('GET', '/v1/model')
      return { content: [{ type: 'text', text: JSON.stringify(r) }] }
    } catch (err) {
      return passthroughErrorResult(err, 'model_get')
    }
  },
)

server.registerTool(
  'model_set',
  {
    title: 'Switch model',
    description: '【管理员】切换固定的 agent 模型（写入 agent-config.json）。claude 下次 spawn 生效，不用重启；当前在飞的会话要等释放后才换。返回写入后的 model 作为核对。',
    inputSchema: { model: z.string().min(1).describe('完整模型 id，如 claude-opus-4-8 / claude-sonnet-4-6') },
  },
  async ({ model }) => {
    try {
      const r = await client.request<unknown>('POST', '/v1/model', { model })
      return { content: [{ type: 'text', text: JSON.stringify(r) }] }
    } catch (err) {
      return passthroughErrorResult(err, 'model_set')
    }
  },
)

server.registerTool(
  'session_release',
  {
    title: 'Release a wedged session',
    description: '【管理员】强制释放某个卡住/闲置的 agent 会话——该 chat 的下一条消息会重开一个干净子进程。用 diagnostic_sessions 拿到 alias/providerId/chatId。返回 { ok, released, sessions }：released=false 表示没有匹配的活跃会话（key 不对/已经没了），不是真的释放了，要据此判断。',
    inputSchema: {
      alias: z.string(),
      providerId: z.string().describe('claude / codex / cursor'),
      chatId: z.string(),
    },
  },
  async ({ alias, providerId, chatId }) => {
    try {
      const r = await client.request<unknown>('POST', '/v1/sessions/release', { alias, providerId, chatId })
      return { content: [{ type: 'text', text: JSON.stringify(r) }] }
    } catch (err) {
      return passthroughErrorResult(err, 'session_release')
    }
  },
)

server.registerTool(
  'daemon_restart',
  {
    title: 'Restart the daemon',
    description: '【管理员】优雅重启整个 daemon（launchd/systemd 会自动重新拉起）。重启期间会短暂断连、在飞的回合会丢。仅在释放会话仍无法恢复时使用。建议先跟用户确认。返回 { ok, restarting }。',
    inputSchema: {},
  },
  async () => {
    try {
      const r = await client.request<unknown>('POST', '/v1/daemon/restart')
      return { content: [{ type: 'text', text: JSON.stringify(r) }] }
    } catch (err) {
      return passthroughErrorResult(err, 'daemon_restart')
    }
  },
)

} // end if (SESSION_IS_ADMIN)

function passthroughErrorResult(err: unknown, tool: string): { content: Array<{ type: 'text'; text: string }> } {
  // Surface transport-layer failures as `{error: "..."}` JSON in a text
  // block. Keeps the legacy "tool never throws" promise that the
  // in-process versions enforced — agent sees a structured failure
  // result, not an MCP exception.
  //
  // STDERR log gets the short, body-free form (status + endpoint only)
  // — Phase 4 polish. The downstream JSON returned to the agent still
  // carries the full detail; we just don't spam channel-log readers
  // with redacted-feeling response bodies.
  logErr(`${tool} transport failed: ${formatErrorShort(err)}`)
  return { content: [{ type: 'text', text: JSON.stringify({ error: formatError(err) }) }] }
}

function formatError(err: unknown): string {
  if (err instanceof InternalApiError) {
    return `internal-api ${err.status}: ${JSON.stringify(err.body).slice(0, 200)}`
  }
  return err instanceof Error ? err.message : String(err)
}

function formatErrorShort(err: unknown): string {
  // Body-free form for stderr logging — omits response payload so
  // sensitive content doesn't end up in operator log scrollback.
  if (err instanceof InternalApiError) {
    return `internal-api ${err.status} ${err.path}`
  }
  return err instanceof Error ? err.message : String(err)
}

const transport = new StdioServerTransport()
await server.connect(transport)
logErr(`ready (pid=${process.pid}, base=${baseUrl})`)
