// src/daemon/inbound/compose.ts
import type { Middleware, PipelineRun, InboundCtx } from './types'

export function compose(mws: ReadonlyArray<Middleware>): PipelineRun {
  return function run(ctx: InboundCtx): Promise<void> {
    let lastIndex = -1
    function dispatch(i: number): Promise<void> {
      if (i <= lastIndex) {
        return Promise.reject(new Error('next() called multiple times in same middleware'))
      }
      lastIndex = i
      const fn = mws[i]
      if (!fn) return Promise.resolve()
      try {
        return Promise.resolve(fn(ctx, () => dispatch(i + 1)))
      } catch (err) {
        return Promise.reject(err)
      }
    }
    return dispatch(0)
  }
}
