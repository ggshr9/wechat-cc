import type { Middleware, InboundCtx } from './types'

export interface DispatchMwDeps {
  coordinator: {
    dispatch(msg: InboundCtx['msg']): Promise<void>
  }
}

export function makeMwDispatch(deps: DispatchMwDeps): Middleware {
  return async (ctx, _next) => {
    await deps.coordinator.dispatch(ctx.msg)
    // terminal — never calls next()
  }
}
