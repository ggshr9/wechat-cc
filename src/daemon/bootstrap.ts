import { SessionManager } from '../core/session-manager'
import { makeResolver } from '../core/project-resolver'
import { makeCanUseTool } from '../core/permission-relay'
import { formatInbound } from '../core/prompt-format'
import { buildWechatMcpServer, type ToolDeps } from '../features/tools'
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
}

export interface Bootstrap {
  sessionManager: SessionManager
  resolve: (chatId: string) => { alias: string; path: string } | null
  formatInbound: typeof formatInbound
  sdkOptionsForProject: (alias: string, path: string) => Options
}

const CHANNEL_SYSTEM_PROMPT = `你在 wechat-cc 的消息通道里接收来自作者个人微信的消息。规则：
- 每条入站消息用 <wechat chat_id="..." user="..." account="..." msg_type="..." ts="...">...</wechat> 包裹。回复时用 reply 工具（不要直接生成文本）。
- chat_id 是路由键；多条连续对话可能来自同一个 chat_id。
- 媒体附件以 [image:/abs/path] [file:/abs/path] [voice:/abs/path] 行内标注，用 Read/Bash 等工具打开或分析它们。
- /project 相关意图可以调 list_projects / switch_project / add_project / remove_project。
- 用户是个人开发者，偏好简短直接的中文回复。`

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
  }
  const mcp = buildWechatMcpServer(toolDeps)
  const canUseTool = makeCanUseTool({
    askUser: deps.ilink.askUser,
    defaultChatId: () => deps.lastActiveChatId(),
    log: deps.log,
  })

  const sdkOptionsForProject = (_alias: string, path: string): Options => ({
    cwd: path,
    permissionMode: 'default',
    canUseTool,
    mcpServers: { wechat: mcp.config },
    systemPrompt: CHANNEL_SYSTEM_PROMPT,
    settingSources: ['user', 'project', 'local'],
  })

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
