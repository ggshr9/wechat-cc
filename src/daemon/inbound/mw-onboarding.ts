import type { Middleware, InboundCtx } from './types'

export interface OnboardingHandler {
  handle(msg: InboundCtx['msg']): Promise<boolean>
}

export interface OnboardingMwDeps {
  onboardingHandler: OnboardingHandler
}

export function makeMwOnboarding(deps: OnboardingMwDeps): Middleware {
  return async (ctx, next) => {
    if (await deps.onboardingHandler.handle(ctx.msg)) {
      ctx.consumedBy = 'onboarding'
      return
    }
    await next()
  }
}
