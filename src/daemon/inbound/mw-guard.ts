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
    if (enabled && !state.reachable) {
      // ip=null means the probe couldn't even determine the outbound IP —
      // worse than known-IP-unreachable, not a reason to silently pass.
      const ipLabel = state.ip ?? '未知'
      deps.log('GUARD', `dropping inbound chat=${ctx.msg.chatId} — network DOWN ip=${ipLabel}`)
      await deps.sendMessage(ctx.msg.chatId, `🛑 出口 IP ${ipLabel} → 网络探测失败。VPN 掉了？修好再发。`)
      ctx.consumedBy = 'guard'
      return
    }
    await next()
  }
}
