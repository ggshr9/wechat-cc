import type { SessionManager } from './session-manager'
import type { InboundMsg } from './prompt-format'

export type { InboundMsg } from './prompt-format'

export interface RouterDeps {
  resolveProject(chatId: string): { alias: string; path: string } | null
  manager: Pick<SessionManager, 'acquire'>
  format: (msg: InboundMsg) => string
  sendAssistantText?: (chatId: string, text: string) => Promise<void>
  log: (tag: string, line: string) => void
}

export async function routeInbound(deps: RouterDeps, msg: InboundMsg): Promise<void> {
  const proj = deps.resolveProject(msg.chatId)
  if (!proj) {
    deps.log('ROUTER', `drop: no project for chat=${msg.chatId}`)
    return
  }
  deps.log('ROUTER', `route chat=${msg.chatId} → project=${proj.alias} path=${proj.path}`)
  const handle = await deps.manager.acquire(proj.alias, proj.path)
  const text = deps.format(msg)
  const result = await handle.dispatch(text)
  for (const assistantText of result?.assistantText ?? []) {
    await deps.sendAssistantText?.(msg.chatId, assistantText)
  }
}
