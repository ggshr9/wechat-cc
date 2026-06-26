/**
 * wechat-mcp daemon-control tools — admin-only self-diagnosis + remediation
 * (diagnostic_* / model_* / session_release / daemon_restart). Registered ONLY
 * for an admin-tier session; see the SESSION_IS_ADMIN gate in main.ts. Split
 * out of main.ts so the privileged surface lives in one auditable file.
 * Behavior verbatim from the original inline registrations.
 */
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { InternalApiClient } from './client'
import { passthroughErrorResult } from './tool-helpers'

export function registerDaemonTools(server: McpServer, client: InternalApiClient): void {
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
      description: '【管理员】切换固定的 agent 模型（写入 agent-config.json，按当前 provider 写对应字段）。claude 下次 spawn 生效、不用重启；codex/cursor 会持久化但要重启 daemon 才生效。返回写入后的 model 作为核对。传完整带版本号的 id（如 claude-opus-4-8），不要传裸别名（opus/sonnet）。',
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
}
