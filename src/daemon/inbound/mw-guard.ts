import type { Middleware } from './types'

export interface GuardMwDeps {
  guardEnabled(): boolean
  guardState(): { reachable: boolean; ip: string | null }
  sendMessage(chatId: string, text: string): Promise<{ msgId: string }>
  log: (tag: string, line: string) => void
}

export function makeMwGuard(deps: GuardMwDeps): Middleware {
  return async (ctx, next) => {
    const enabled = deps.guardEnabled()
    const state = deps.guardState()
    if (enabled && !state.reachable && state.ip) {
      deps.log('GUARD', `dropping inbound chat=${ctx.msg.chatId} — network DOWN ip=${state.ip}`)
      await deps.sendMessage(ctx.msg.chatId, `🛑 出口 IP ${state.ip} → 网络探测失败。VPN 掉了？修好再发。`)
      ctx.consumedBy = 'guard'
      return
    }
    await next()
  }
}
