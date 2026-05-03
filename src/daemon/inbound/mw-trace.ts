import type { Middleware } from './types'

export interface TraceMwDeps {
  log: (tag: string, line: string, fields?: Record<string, unknown>) => void
}

function errMsg(err: unknown): string { return err instanceof Error ? err.message : String(err) }

export function makeMwTrace(deps: TraceMwDeps): Middleware {
  return async (ctx, next) => {
    const start = Date.now()
    try {
      await next()
    } catch (err) {
      deps.log('INBOUND_ERROR', `req=${ctx.requestId} chat=${ctx.msg.chatId} threw: ${errMsg(err)}`, {
        event: 'inbound_uncaught',
        request_id: ctx.requestId,
        chat_id: ctx.msg.chatId,
        error: errMsg(err),
      })
      // 不 rethrow —— 保 polling loop 活
    } finally {
      deps.log('INBOUND',
        `req=${ctx.requestId} chat=${ctx.msg.chatId} consumed=${ctx.consumedBy ?? 'dispatched'} ms=${Date.now() - start}`)
    }
  }
}
