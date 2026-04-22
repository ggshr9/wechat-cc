import { SessionManager } from '../core/session-manager'
import { makeResolver } from '../core/project-resolver'
import { makeCanUseTool } from '../core/permission-relay'
import { formatInbound } from '../core/prompt-format'
import { buildWechatMcpServer, type ToolDeps } from '../features/tools'
import type { IlinkAdapter } from './ilink-glue'
import type { Options } from '@anthropic-ai/claude-agent-sdk'

export interface BootstrapDeps {
  stateDir: string
  ilink: {
    sendMessage: (chatId: string, text: string) => Promise<{ msgId: string }>
    sendFile: (chatId: string, path: string) => Promise<void>
    editMessage: (chatId: string, msgId: string, text: string) => Promise<void>
    broadcast: (text: string, accountId?: string) => Promise<{ ok: number; failed: number }>
    sharePage: (title: string, content: string) => Promise<{ url: string; slug: string }>
    resurfacePage: (q: { slug?: string; title_fragment?: string }) => Promise<{ url: string; slug: string } | null>
    setUserName: (chatId: string, name: string) => Promise<void>
    projects: ToolDeps['projects']
    voice: IlinkAdapter['voice']
    companion: IlinkAdapter['companion']
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
}

export interface Bootstrap {
  sessionManager: SessionManager
  resolve: (chatId: string) => { alias: string; path: string } | null
  formatInbound: typeof formatInbound
  sdkOptionsForProject: (alias: string, path: string) => Options
}

function buildChannelSystemPrompt(companionEnabled: boolean, currentPersona: string | null): string {
  const base = `你在 wechat-cc 的消息通道里接收来自作者个人微信的消息。规则：
- 每条入站消息用 <wechat chat_id="..." user="..." account="..." msg_type="..." ts="...">...</wechat> 包裹。回复时用 reply 工具（不要直接生成文本）。
- chat_id 是路由键；多条连续对话可能来自同一个 chat_id。
- 媒体附件以 [image:/abs/path] [file:/abs/path] [voice:/abs/path] 行内标注，用 Read/Bash 等工具打开或分析它们。
- /project 相关意图可以调 list_projects / switch_project / add_project / remove_project。
- 用户是个人开发者，偏好简短直接的中文回复。
- reply_voice 仅在用户明确要求语音回复时使用（消息中含 "语音回复" / "念一下" / "speak it" / "say it aloud" 等）。其他情况一律用 reply 回复文本。reply_voice 不适合代码块、URL、长列表。
- 如果用户第一次要求语音但未配置：先调 voice_config_status 检查；未配置则调 reply 引导用户发 API 配置（例如 VoxCPM2 的 base_url http://<mac>:8000/v1/audio/speech + model openbmb/VoxCPM2），再调 save_voice_config 保存。`

  if (!companionEnabled) return base

  return base + `

---
Companion 功能已开启。当前项目默认人格：${currentPersona ?? 'assistant'}。

可用工具（companion 层）：
- companion_snooze: 用户说"别烦我"/"停"/"snooze N 小时" 时调用
- companion_disable: 用户明确要关闭推送时调用
- companion_status: 用户问"当前怎么样"/"都有什么提醒"时调用
- persona_switch: 用户说"切到陪伴"/"换回小助手" 时调用
- trigger_add / trigger_remove / trigger_pause: 用户说"加个 X 监控"/"删掉 X"/"暂停 X" 时调用

反应式对话由你自然判断语气。Companion 的人格只影响主动推送的角色；此刻你是 Claude 本人。`
}

export function buildBootstrap(deps: BootstrapDeps): Bootstrap {
  const resolve = makeResolver({
    loadProjects: deps.loadProjects,
    fallback: deps.fallbackProject,
  })
  const toolDeps: ToolDeps = {
    sendReply: deps.ilink.sendMessage,
    sendFile: deps.ilink.sendFile,
    editMessage: deps.ilink.editMessage,
    broadcast: deps.ilink.broadcast,
    sharePage: deps.ilink.sharePage,
    resurfacePage: deps.ilink.resurfacePage,
    setUserName: deps.ilink.setUserName,
    projects: deps.ilink.projects,
    voice: deps.ilink.voice,
    companion: deps.ilink.companion,
  }
  const mcp = buildWechatMcpServer(toolDeps)
  const canUseTool = makeCanUseTool({
    askUser: deps.ilink.askUser,
    defaultChatId: () => deps.lastActiveChatId(),
    log: deps.log,
  })

  const sdkOptionsForProject = (_alias: string, path: string): Options => {
    const cstatus = deps.ilink.companion.status()
    const currentPersona = cstatus.per_project_persona[_alias] ?? cstatus.per_project_persona['_default'] ?? null
    const systemPrompt = buildChannelSystemPrompt(cstatus.enabled, currentPersona)
    const common: Options = {
      cwd: path,
      mcpServers: { wechat: mcp.config },
      systemPrompt,
      settingSources: ['user', 'project', 'local'],
    }
    if (deps.dangerouslySkipPermissions) {
      return { ...common, permissionMode: 'bypassPermissions' }
    }
    return { ...common, permissionMode: 'default', canUseTool }
  }

  const sessionManager = new SessionManager({
    maxConcurrent: 6,
    idleEvictMs: 30 * 60_000,
    sdkOptionsForProject,
  })

  return {
    sessionManager,
    resolve,
    formatInbound,
    sdkOptionsForProject,
  }
}
