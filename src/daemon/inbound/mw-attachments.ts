import type { Middleware, InboundCtx } from './types'

export interface AttachmentsMwDeps {
  materializeAttachments(msg: InboundCtx['msg'], inboxDir: string, log: (tag: string, line: string) => void): Promise<void>
  inboxDir: string
  log: (tag: string, line: string) => void
}

export function makeMwAttachments(deps: AttachmentsMwDeps): Middleware {
  return async (ctx, next) => {
    await deps.materializeAttachments(ctx.msg, deps.inboxDir, deps.log)
    ctx.attachmentsMaterialized = true
    await next()
  }
}
