// mw-typing.ts
import type { Middleware } from './types'

export interface TypingMwDeps {
  sendTyping(chatId: string, accountId: string): Promise<void>
}

export function makeMwTyping(deps: TypingMwDeps): Middleware {
  return async (ctx, next) => {
    deps.sendTyping(ctx.msg.chatId, ctx.msg.accountId).catch(() => { /* swallow */ })
    await next()
  }
}
