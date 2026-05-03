import type { Middleware } from './types'

export interface ActivityMwDeps {
  recordInbound(chatId: string, when: Date): Promise<void>
  log: (tag: string, line: string) => void
}

export function makeMwActivity(deps: ActivityMwDeps): Middleware {
  return async (ctx, next) => {
    await next()
    if (ctx.consumedBy) return
    const when = new Date(ctx.msg.createTimeMs ?? ctx.receivedAtMs)
    deps.recordInbound(ctx.msg.chatId, when).catch(err =>
      deps.log('ACTIVITY', `record failed for ${ctx.msg.chatId}: ${err instanceof Error ? err.message : err}`),
    )
  }
}
