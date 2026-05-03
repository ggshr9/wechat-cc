import type { Middleware } from './types'

export interface CaptureCtxMwDeps {
  markChatActive(chatId: string, accountId: string): void
  captureContextToken(chatId: string, token: string): void
}

export function makeMwCaptureCtx(deps: CaptureCtxMwDeps): Middleware {
  return async (ctx, next) => {
    deps.markChatActive(ctx.msg.chatId, ctx.msg.accountId)
    if (ctx.msg.contextToken) deps.captureContextToken(ctx.msg.chatId, ctx.msg.contextToken)
    await next()
  }
}
