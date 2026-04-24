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
    set_user_name: (args: { chat_id: string; name: string }) => Promise<unknown>
    send_file: (args: { chat_id: string; path: string }) => Promise<unknown>
    broadcast: (args: { text: string; account_id?: string }) => Promise<unknown>
    share_page: (args: { title: string; content: string; needs_approval?: boolean; chat_id?: string; account_id?: string }) => Promise<unknown>
    resurface_page: (args: { slug?: string; title_fragment?: string }) => Promise<unknown>
    list_projects: (args: Record<string, never>) => Promise<unknown>
    switch_project: (args: { alias: string }) => Promise<unknown>
    add_project: (args: { alias: string; path: string }) => Promise<unknown>
    remove_project: (args: { alias: string }) => Promise<unknown>
    reply_voice: (args: { chat_id: string; text: string }) => Promise<unknown>
    save_voice_config: (args: {
      provider: 'http_tts' | 'qwen'
      base_url?: string
      model?: string
      api_key?: string
      default_voice?: string
    }) => Promise<unknown>
    voice_config_status: (args: Record<string, never>) => Promise<unknown>
    companion_enable: (args: Record<string, never>) => Promise<unknown>
    companion_disable: (args: Record<string, never>) => Promise<unknown>
    companion_status: (args: Record<string, never>) => Promise<unknown>
    companion_snooze: (args: { minutes: number }) => Promise<unknown>
    memory_read: (args: { path: string }) => Promise<unknown>
    memory_write: (args: { path: string; content: string }) => Promise<unknown>
    memory_list: (args: { dir?: string }) => Promise<unknown>
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

  const setNameDef = tool(
    'set_user_name',
    '记住新用户的显示名称。',
    { chat_id: z.string(), name: z.string() },
    async ({ chat_id, name }) => {
      await deps.setUserName(chat_id, name)
      return okText(JSON.stringify({ ok: true }))
    },
  )
  handlers.set_user_name = async (a) => (await setNameDef.handler(a, undefined)) as unknown

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

  const shareDef = tool(
    'share_page',
    '把 Markdown 内容发布为一次性 URL。返回 {url, slug}。needs_approval=true 时页面会渲染 ✓ Approve 按钮（默认 false，纯内容文档不带按钮）。chat_id 传入后页脚会出现"📄 发 PDF 到微信"按钮，点击会把 PDF 推到该 chat。',
    { title: z.string(), content: z.string(), needs_approval: z.boolean().optional(), chat_id: z.string().optional(), account_id: z.string().optional() },
    async ({ title, content, needs_approval, chat_id, account_id }) => {
      const opts: { needs_approval?: boolean; chat_id?: string; account_id?: string } = {}
      if (needs_approval) opts.needs_approval = true
      if (chat_id) opts.chat_id = chat_id
      if (account_id) opts.account_id = account_id
      const r = await deps.sharePage(title, content, Object.keys(opts).length ? opts : undefined)
      return okText(JSON.stringify(r))
    },
  )
  handlers.share_page = async (a) => (await shareDef.handler(a as any, undefined)) as unknown

  const resurfaceDef = tool(
    'resurface_page',
    '根据 slug 或标题片段重新生成一个有效 URL。',
    { slug: z.string().optional(), title_fragment: z.string().optional() },
    async ({ slug, title_fragment }) => {
      const r = await deps.resurfacePage({ slug: slug ?? undefined, title_fragment: title_fragment ?? undefined })
      return okText(JSON.stringify(r ?? { ok: false, reason: 'not found' }))
    },
  )
  handlers.resurface_page = async (a) => (await resurfaceDef.handler(a as any, undefined)) as unknown

  const listProjectsDef = tool(
    'list_projects',
    '列出已注册的项目及当前项目。',
    {},
    async () => okText(JSON.stringify(deps.projects.list())),
  )
  handlers.list_projects = async (a) => (await listProjectsDef.handler(a, undefined)) as unknown

  const switchProjectDef = tool(
    'switch_project',
    '切换到指定项目别名。',
    { alias: z.string() },
    async ({ alias }) => okText(JSON.stringify(await deps.projects.switchTo(alias))),
  )
  handlers.switch_project = async (a) => (await switchProjectDef.handler(a, undefined)) as unknown

  const addProjectDef = tool(
    'add_project',
    '注册一个新项目（别名 + 绝对路径）。',
    { alias: z.string(), path: z.string() },
    async ({ alias, path }) => {
      await deps.projects.add(alias, path)
      return okText(JSON.stringify({ ok: true }))
    },
  )
  handlers.add_project = async (a) => (await addProjectDef.handler(a, undefined)) as unknown

  const removeProjectDef = tool(
    'remove_project',
    '移除一个已注册的项目。',
    { alias: z.string() },
    async ({ alias }) => {
      await deps.projects.remove(alias)
      return okText(JSON.stringify({ ok: true }))
    },
  )
  handlers.remove_project = async (a) => (await removeProjectDef.handler(a, undefined)) as unknown

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

  const saveVoiceConfigDef = tool(
    'save_voice_config',
    '保存 TTS 配置。provider=http_tts 时必须提供 base_url + model（常见：VoxCPM2 通过本地 vllm serve --omni 部署）；provider=qwen 时必须提供 api_key。保存前会做一次 1 秒测试合成验证。',
    {
      provider: z.enum(['http_tts', 'qwen']),
      base_url: z.string().url().optional(),
      model: z.string().optional(),
      api_key: z.string().optional(),
      default_voice: z.string().optional(),
    },
    async (args) => {
      const r = await deps.voice.saveConfig(args)
      return okText(JSON.stringify(r))
    },
  )
  handlers.save_voice_config = async (a) => (await saveVoiceConfigDef.handler(a as any, undefined)) as unknown

  const voiceConfigStatusDef = tool(
    'voice_config_status',
    '查询当前 TTS 配置状态。不返回 api_key，只返回 provider、默认音色、base_url/model（如果是 http_tts）、saved_at。',
    {},
    async () => okText(JSON.stringify(deps.voice.configStatus())),
  )
  handlers.voice_config_status = async (a) => (await voiceConfigStatusDef.handler(a, undefined)) as unknown

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

  // ── Memory: Claude's long-term persistent notes (Companion v2 "wings") ──
  //
  // Sandboxed to ~/.claude/channels/wechat/memory/. Only .md files. Claude
  // decides file layout, naming, and when to consolidate. The three tools
  // are deliberately minimal: read / write / list. No schema, no helpers.
  // See docs/specs/2026-04-24-companion-memory.md for philosophy.

  const memoryReadDef = tool(
    'memory_read',
    '读 memory/ 下的一个文件。不存在返回 exists:false。相对路径，只允许 .md。',
    { path: z.string() },
    async ({ path }) => {
      try {
        const content = deps.memory.read(path)
        return okText(JSON.stringify(content === null
          ? { exists: false }
          : { exists: true, content }))
      } catch (err) {
        return okText(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
      }
    },
  )
  handlers.memory_read = async (a) => (await memoryReadDef.handler(a as any, undefined)) as unknown

  const memoryWriteDef = tool(
    'memory_write',
    '写 memory/ 下的一个文件（atomic, 覆盖）。相对路径，只允许 .md。单文件 100KB 上限。父目录自动创建。',
    { path: z.string(), content: z.string() },
    async ({ path, content }) => {
      try {
        deps.memory.write(path, content)
        return okText(JSON.stringify({ ok: true }))
      } catch (err) {
        return okText(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }))
      }
    },
  )
  handlers.memory_write = async (a) => (await memoryWriteDef.handler(a as any, undefined)) as unknown

  const memoryListDef = tool(
    'memory_list',
    '列 memory/ 下所有 .md 文件（递归）。传 dir 只列该子目录。返回相对路径数组。',
    { dir: z.string().optional() },
    async ({ dir }) => {
      try {
        return okText(JSON.stringify({ files: deps.memory.list(dir) }))
      } catch (err) {
        return okText(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
      }
    },
  )
  handlers.memory_list = async (a) => (await memoryListDef.handler(a as any, undefined)) as unknown

  const config = createSdkMcpServer({
    name: 'wechat',
    version: '1.0.0',
    tools: [
      replyDef, editDef, setNameDef, sendFileDef, broadcastDef,
      shareDef, resurfaceDef,
      listProjectsDef, switchProjectDef, addProjectDef, removeProjectDef,
      replyVoiceDef, saveVoiceConfigDef, voiceConfigStatusDef,
      companionEnableDef, companionDisableDef, companionStatusDef, companionSnoozeDef,
      memoryReadDef, memoryWriteDef, memoryListDef,
    ],
  })

  return { config, handlers }
}
