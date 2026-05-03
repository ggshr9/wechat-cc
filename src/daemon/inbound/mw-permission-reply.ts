import type { Middleware } from './types'

export interface PermissionReplyMwDeps {
  handlePermissionReply(text: string): boolean
  log: (tag: string, line: string) => void
}

export function makeMwPermissionReply(deps: PermissionReplyMwDeps): Middleware {
  return async (ctx, next) => {
    if (deps.handlePermissionReply(ctx.msg.text ?? '')) {
      deps.log('PERMISSION', `consumed reply from chat=${ctx.msg.chatId}`)
      ctx.consumedBy = 'permission-reply'
      return
    }
    await next()
  }
}
