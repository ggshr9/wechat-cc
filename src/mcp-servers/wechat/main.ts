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
    inputSchema: { dir: z.string().optional() },
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

function passthroughErrorResult(err: unknown, tool: string): { content: Array<{ type: 'text'; text: string }> } {
  // Surface transport-layer failures as `{error: "..."}` JSON in a text
  // block. Keeps the legacy "tool never throws" promise that the
  // in-process versions enforced — agent sees a structured failure
  // result, not an MCP exception.
  const detail = formatError(err)
  logErr(`${tool} transport failed: ${detail}`)
  return { content: [{ type: 'text', text: JSON.stringify({ error: detail }) }] }
}

function formatError(err: unknown): string {
  if (err instanceof InternalApiError) {
    return `internal-api ${err.status}: ${JSON.stringify(err.body).slice(0, 200)}`
  }
  return err instanceof Error ? err.message : String(err)
}

const transport = new StdioServerTransport()
await server.connect(transport)
logErr(`ready (pid=${process.pid}, base=${baseUrl})`)
