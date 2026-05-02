import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { MemoryFS } from '../daemon/memory/fs-api'

export interface ToolDeps {
  sendReply(chatId: string, text: string): Promise<{ msgId: string; error?: string }>
  sendFile(chatId: string, path: string): Promise<void>
  editMessage(chatId: string, msgId: string, text: string): Promise<void>
  broadcast(text: string, accountId?: string): Promise<{ ok: number; failed: number }>
  sharePage(title: string, content: string, opts?: { needs_approval?: boolean; chat_id?: string; account_id?: string }): Promise<{ url: string; slug: string }>
  resurfacePage(q: { slug?: string; title_fragment?: string }): Promise<{ url: string; slug: string } | null>
  setUserName(chatId: string, name: string): Promise<void>
  memory: MemoryFS
  projects: {
    list(): { alias: string; path: string; current: boolean }[]
    switchTo(alias: string): Promise<{ ok: true; path: string } | { ok: false; reason: string }>
    add(alias: string, path: string): Promise<void>
    remove(alias: string): Promise<void>
  }
  voice: {
    /** Returns {ok, msgId} or {ok:false, reason}. Generates audio, uploads via ilink, returns result. */
    replyVoice(chatId: string, text: string): Promise<
      | { ok: true; msgId: string }
      | { ok: false; reason: string }
    >
    /** Validates input (test synth), then persists. Returns ok + tested_ms on success. */
    saveConfig(input: {
      provider: 'http_tts' | 'qwen'
      base_url?: string
      model?: string
      api_key?: string
      default_voice?: string
    }): Promise<
      | { ok: true; tested_ms: number; provider: string; default_voice: string }
      | { ok: false; reason: string; detail?: string }
    >
    /** Returns current config status (does NOT leak api_key). */
    configStatus():
      | { configured: false }
      | {
          configured: true
          provider: 'http_tts' | 'qwen'
          default_voice: string
          base_url?: string
          model?: string
          saved_at: string
        }
  }
  companion: {
    /** Turn on proactive tick. Idempotent. Scaffolds minimal config on first call. */
    enable(): Promise<
      | {
          ok: true
          state_dir: string
          welcome_message: string
          cost_estimate_note: string
        }
      | { ok: true; already_configured: true }
    >
    disable(): Promise<{ ok: true; enabled: false }>
    /** Minimal status: are proactive ticks on? snoozed until when? */
    status(): {
      enabled: boolean
      timezone: string
      default_chat_id: string | null
      snooze_until: string | null
    }
    snooze(minutes: number): Promise<{ ok: true; until: string }>
  }
}

export interface BuiltWechatMcp {
  config: McpSdkServerConfigWithInstance
  handlers: {
    reply: (args: { chat_id: string; text: string }) => Promise<unknown>
    edit_message: (args: { chat_id: string; msg_id: string; text: string }) => Promise<unknown>
    send_file: (args: { chat_id: string; path: string }) => Promise<unknown>
    broadcast: (args: { text: string; account_id?: string }) => Promise<unknown>
    reply_voice: (args: { chat_id: string; text: string }) => Promise<unknown>
    companion_enable: (args: Record<string, never>) => Promise<unknown>
    companion_disable: (args: Record<string, never>) => Promise<unknown>
    companion_status: (args: Record<string, never>) => Promise<unknown>
    companion_snooze: (args: { minutes: number }) => Promise<unknown>
  }
}

function okText(text: string) {
  return { content: [{ type: 'text' as const, text }] }
}

export function buildWechatMcpServer(deps: ToolDeps): BuiltWechatMcp {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handlers = {} as BuiltWechatMcp['handlers']

  const replyDef = tool(
    'reply',
    '给当前微信用户回复文本。chat_id 必填。长文本会自动分段。',
    { chat_id: z.string(), text: z.string() },
    async ({ chat_id, text }) => {
      const r = await deps.sendReply(chat_id, text)
      if (r.error) {
        return okText(JSON.stringify({ ok: false, error: r.error }))
      }
      return okText(JSON.stringify({ ok: true, msg_id: r.msgId }))
    },
  )
  handlers.reply = async (a) => (await replyDef.handler(a, undefined)) as unknown

  const editDef = tool(
    'edit_message',
    '编辑已发送的消息（需要 msg_id）。',
    { chat_id: z.string(), msg_id: z.string(), text: z.string() },
    async ({ chat_id, msg_id, text }) => {
      await deps.editMessage(chat_id, msg_id, text)
      return okText(JSON.stringify({ ok: true }))
    },
  )
  handlers.edit_message = async (a) => (await editDef.handler(a, undefined)) as unknown

  // set_user_name moved to wechat-mcp stdio server in P1.B B3.
  // See src/mcp-servers/wechat/main.ts and src/daemon/internal-api.ts.

  const sendFileDef = tool(
    'send_file',
    '给当前用户发送文件（本地绝对路径）。',
    { chat_id: z.string(), path: z.string() },
    async ({ chat_id, path }) => {
      await deps.sendFile(chat_id, path)
      return okText(JSON.stringify({ ok: true }))
    },
  )
  handlers.send_file = async (a) => (await sendFileDef.handler(a, undefined)) as unknown

  const broadcastDef = tool(
    'broadcast',
    '向所有在线用户群发文本。account_id 可选（不填则默认主账号）。',
    { text: z.string(), account_id: z.string().optional() },
    async ({ text, account_id }) => {
      const r = await deps.broadcast(text, account_id ?? undefined)
      return okText(JSON.stringify(r))
    },
  )
  handlers.broadcast = async (a) => (await broadcastDef.handler(a as any, undefined)) as unknown

  // share_page / resurface_page moved to wechat-mcp stdio server in
  // P1.B B5. list_projects / switch_project / add_project /
  // remove_project moved in P1.B B3.

  const replyVoiceDef = tool(
    'reply_voice',
    '用语音回复用户。仅在用户明确要求语音回复时使用（"念一下"/"语音回复"/"speak it" 等）。文本 ≤ 500 字；不适合代码块、长 URL、结构化列表。',
    { chat_id: z.string(), text: z.string() },
    async ({ chat_id, text }) => {
      if (text.length > 500) {
        return okText(JSON.stringify({ ok: false, reason: 'too_long', limit: 500 }))
      }
      const r = await deps.voice.replyVoice(chat_id, text)
      return okText(JSON.stringify(r))
    },
  )
  handlers.reply_voice = async (a) => (await replyVoiceDef.handler(a, undefined)) as unknown

  // save_voice_config / voice_config_status moved to wechat-mcp stdio
  // server in P1.B B4. reply_voice (also voice-related) stays here until
  // B1 because it crosses ilink to actually send a message.

  const companionEnableDef = tool(
    'companion_enable',
    '开启 Companion 主动推送（定时 tick）。第一次调用会创建 config.json 并返回欢迎消息。幂等。',
    {},
    async () => okText(JSON.stringify(await deps.companion.enable())),
  )
  handlers.companion_enable = async (a) => (await companionEnableDef.handler(a, undefined)) as unknown

  const companionDisableDef = tool(
    'companion_disable',
    '关闭 Companion 主动推送。下一次 scheduler tick 不再触发。',
    {},
    async () => okText(JSON.stringify(await deps.companion.disable())),
  )
  handlers.companion_disable = async (a) => (await companionDisableDef.handler(a, undefined)) as unknown

  const companionStatusDef = tool(
    'companion_status',
    '查询 Companion 状态：是否开启、时区、默认 chat_id、snooze 截止时间。人格 / 触发器等历史详情请从 memory/ 读。',
    {},
    async () => okText(JSON.stringify(deps.companion.status())),
  )
  handlers.companion_status = async (a) => (await companionStatusDef.handler(a, undefined)) as unknown

  const companionSnoozeDef = tool(
    'companion_snooze',
    '暂停所有主动推送若干分钟。用户说 "别烦我"/"停"/"snooze N 小时"/"shut up" 等时调用。',
    { minutes: z.number().int().min(1).max(24 * 60) },
    async ({ minutes }) => okText(JSON.stringify(await deps.companion.snooze(minutes))),
  )
  handlers.companion_snooze = async (a) => (await companionSnoozeDef.handler(a as any, undefined)) as unknown

  // memory_read / memory_write / memory_list moved to the standalone
  // wechat-mcp stdio server in P1.B B2 (commit history). See
  // src/mcp-servers/wechat/main.ts for the new tool registration and
  // src/daemon/internal-api.ts for the route handlers. The MemoryFS
  // instance is shared across both paths via the daemon's bootstrap.

  const config = createSdkMcpServer({
    name: 'wechat',
    version: '1.0.0',
    tools: [
      replyDef, editDef, sendFileDef, broadcastDef,
      replyVoiceDef,
      companionEnableDef, companionDisableDef, companionStatusDef, companionSnoozeDef,
    ],
  })

  return { config, handlers }
}
