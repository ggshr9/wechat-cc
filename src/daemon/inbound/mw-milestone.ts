import type { Middleware } from './types'

export interface MilestoneMwDeps {
  fireMilestonesFor(chatId: string): Promise<void>
  log: (tag: string, line: string) => void
}

export function makeMwMilestone(deps: MilestoneMwDeps): Middleware {
  return async (ctx, next) => {
    await next()
    if (ctx.consumedBy) return
    deps.fireMilestonesFor(ctx.msg.chatId).catch(err =>
      deps.log('MILESTONE', `detect failed for ${ctx.msg.chatId}: ${err instanceof Error ? err.message : err}`),
    )
  }
}
