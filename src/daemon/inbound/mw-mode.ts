import type { Middleware, InboundCtx } from './types'

export interface ModeHandler {
  handle(msg: InboundCtx['msg']): Promise<boolean>
}

export interface ModeMwDeps {
  modeHandler: ModeHandler
}

export function makeMwMode(deps: ModeMwDeps): Middleware {
  return async (ctx, next) => {
    if (await deps.modeHandler.handle(ctx.msg)) {
      ctx.consumedBy = 'mode'
      return
    }
    await next()
  }
}
