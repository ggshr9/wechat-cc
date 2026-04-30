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
  const assistantTexts = result?.assistantText ?? []
  const replyToolCalled = result?.replyToolCalled ?? false
  // Only forward raw assistant text when Claude did NOT call a reply-family
  // tool this turn. The system prompt tells Claude to always use `reply`,
  // but it forgets — most commonly when analyzing an image with `Read` and
  // describing it as plain text. Without this fallback the user gets
  // silence; with it they get the description, and we log it loudly so
  // we can see how often Claude misroutes.
  if (replyToolCalled || assistantTexts.length === 0) return
  deps.log('FALLBACK_REPLY', `chat=${msg.chatId} project=${proj.alias} chunks=${assistantTexts.length} preview=${JSON.stringify(assistantTexts[0]?.slice(0, 80) ?? '')}`)
  for (const assistantText of assistantTexts) {
    await deps.sendAssistantText?.(msg.chatId, assistantText)
  }
}
