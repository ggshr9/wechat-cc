import type { Middleware } from './types'

export interface WelcomeMwDeps {
  maybeWriteWelcomeObservation(chatId: string): Promise<void>
  log: (tag: string, line: string) => void
}

export function makeMwWelcome(deps: WelcomeMwDeps): Middleware {
  return async (ctx, next) => {
    await next()
    if (ctx.consumedBy) return
    deps.maybeWriteWelcomeObservation(ctx.msg.chatId).catch(err =>
      deps.log('OBSERVE', `welcome write failed for ${ctx.msg.chatId}: ${err instanceof Error ? err.message : err}`),
    )
  }
}
