import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

export interface ToolDeps {
  sendReply(chatId: string, text: string): Promise<{ msgId: string }>
  sendFile(chatId: string, path: string): Promise<void>
  editMessage(chatId: string, msgId: string, text: string): Promise<void>
  broadcast(text: string, accountId?: string): Promise<{ ok: number; failed: number }>
  sharePage(title: string, content: string): Promise<{ url: string; slug: string }>
  resurfacePage(q: { slug?: string; title_fragment?: string }): Promise<{ url: string; slug: string } | null>
  setUserName(chatId: string, name: string): Promise<void>
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
    /** On first call: scaffold profile.md + personas/*.md + config.json. Returns welcome message + cost estimate. Idempotent on subsequent calls. */
    enable(): Promise<
      | {
          ok: true
          state_dir: string
          personas_scaffolded: string[]
          welcome_message: string
          cost_estimate_note: string
        }
      | { ok: true; already_configured: true }
    >
    disable(): Promise<{ ok: true; enabled: false }>
    /** Consolidated status — replaces separate persona_list / trigger_list tools. */
    status(): {
      enabled: boolean
      timezone: string
      per_project_persona: Record<string, string>
      personas_available: { name: string; display_name: string }[]
      triggers: {
        id: string
        project: string
        schedule: string
        personas: string[]
        next_fire_at: string | null
        last_run_at?: string | null
        last_pushed_at?: string | null
      }[]
      snooze_until: string | null
      pushes_last_24h: number
      runs_last_24h: number
    }
    snooze(minutes: number): Promise<{ ok: true; until: string }>
    personaSwitch(params: { persona: string; project?: string }): Promise<
      | { ok: true; project: string; persona: string }
      | { ok: false; reason: string }
    >
    triggerAdd(params: {
      id: string
      project: string
      schedule: string
      task: string
      personas?: string[]
      on_failure?: 'silent' | 'notify-user' | 'retry-once'
    }): Promise<
      | { ok: true; next_fire_at: string }
      | { ok: false; reason: string }
    >
    triggerRemove(id: string): Promise<
      | { ok: true }
      | { ok: false; reason: string }
    >
    triggerPause(id: string, minutes?: number): Promise<
      | { ok: true; paused_until: string | null }
      | { ok: false; reason: string }
    >
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
    share_page: (args: { title: string; content: string }) => Promise<unknown>
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
    persona_switch: (args: { persona: string; project?: string }) => Promise<unknown>
    trigger_add: (args: {
      id: string
      project: string
      schedule: string
      task: string
      personas?: string[]
      on_failure?: 'silent' | 'notify-user' | 'retry-once'
    }) => Promise<unknown>
    trigger_remove: (args: { id: string }) => Promise<unknown>
    trigger_pause: (args: { id: string; minutes?: number }) => Promise<unknown>
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
      const { msgId } = await deps.sendReply(chat_id, text)
      return okText(JSON.stringify({ ok: true, msg_id: msgId }))
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
    '把 Markdown 内容发布为一次性 URL。返回 {url, slug}。',
    { title: z.string(), content: z.string() },
    async ({ title, content }) => {
      const r = await deps.sharePage(title, content)
      return okText(JSON.stringify(r))
    },
  )
  handlers.share_page = async (a) => (await shareDef.handler(a, undefined)) as unknown

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
    '开启 Companion 主动推送功能。第一次调用会自动创建 profile.md + personas/assistant.md + personas/companion.md + config.json，并返回欢迎消息和成本提示。后续调用是幂等的。',
    {},
    async () => okText(JSON.stringify(await deps.companion.enable())),
  )
  handlers.companion_enable = async (a) => (await companionEnableDef.handler(a, undefined)) as unknown

  const companionDisableDef = tool(
    'companion_disable',
    '关闭 Companion 主动推送。scheduler 在下一次 tick 停止。',
    {},
    async () => okText(JSON.stringify(await deps.companion.disable())),
  )
  handlers.companion_disable = async (a) => (await companionDisableDef.handler(a, undefined)) as unknown

  const companionStatusDef = tool(
    'companion_status',
    '查询 Companion 状态：是否开启、当前时区、每个项目的人格、已安装人格、已注册触发器（及下次触发时间）、snooze 状态、最近 24 小时推送/评估次数。',
    {},
    async () => okText(JSON.stringify(deps.companion.status())),
  )
  handlers.companion_status = async (a) => (await companionStatusDef.handler(a, undefined)) as unknown

  const companionSnoozeDef = tool(
    'companion_snooze',
    '暂停所有主动推送若干分钟。用户说 "别烦我"/"停"/"snooze N 小时"/"shut up" 等时调用。默认 180 分钟（3 小时）。',
    { minutes: z.number().int().min(1).max(24 * 60) },
    async ({ minutes }) => okText(JSON.stringify(await deps.companion.snooze(minutes))),
  )
  handlers.companion_snooze = async (a) => (await companionSnoozeDef.handler(a as any, undefined)) as unknown

  const personaSwitchDef = tool(
    'persona_switch',
    '切换指定项目的人格。project 可选（不传时使用当前 session 的 project 或 _default）。返回 ok + 实际生效的 project/persona。',
    { persona: z.string(), project: z.string().optional() },
    async ({ persona, project }) => okText(JSON.stringify(await deps.companion.personaSwitch({ persona, project }))),
  )
  handlers.persona_switch = async (a) => (await personaSwitchDef.handler(a as any, undefined)) as unknown

  const triggerAddDef = tool(
    'trigger_add',
    '注册一个新的主动触发器。schedule 是标准 5 字段 cron 表达式；task 是 Claude prompt（不是 shell 命令——描述要评估的事）。personas 不填默认 []（任何人格都会触发）。',
    {
      id: z.string(),
      project: z.string(),
      schedule: z.string(),
      task: z.string(),
      personas: z.array(z.string()).optional(),
      on_failure: z.enum(['silent', 'notify-user', 'retry-once']).optional(),
    },
    async (args) => okText(JSON.stringify(await deps.companion.triggerAdd(args))),
  )
  handlers.trigger_add = async (a) => (await triggerAddDef.handler(a as any, undefined)) as unknown

  const triggerRemoveDef = tool(
    'trigger_remove',
    '移除一个已注册的触发器。',
    { id: z.string() },
    async ({ id }) => okText(JSON.stringify(await deps.companion.triggerRemove(id))),
  )
  handlers.trigger_remove = async (a) => (await triggerRemoveDef.handler(a as any, undefined)) as unknown

  const triggerPauseDef = tool(
    'trigger_pause',
    '暂停一个触发器若干分钟；不传 minutes 则无限期暂停。',
    { id: z.string(), minutes: z.number().int().min(1).max(7 * 24 * 60).optional() },
    async ({ id, minutes }) => okText(JSON.stringify(await deps.companion.triggerPause(id, minutes))),
  )
  handlers.trigger_pause = async (a) => (await triggerPauseDef.handler(a as any, undefined)) as unknown

  const config = createSdkMcpServer({
    name: 'wechat',
    version: '1.0.0',
    tools: [
      replyDef, editDef, setNameDef, sendFileDef, broadcastDef,
      shareDef, resurfaceDef,
      listProjectsDef, switchProjectDef, addProjectDef, removeProjectDef,
      replyVoiceDef, saveVoiceConfigDef, voiceConfigStatusDef,
      companionEnableDef, companionDisableDef, companionStatusDef, companionSnoozeDef,
      personaSwitchDef, triggerAddDef, triggerRemoveDef, triggerPauseDef,
    ],
  })

  return { config, handlers }
}
