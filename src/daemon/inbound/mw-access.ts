/**
 * mw-access — enforces the access.json allowlist gate.
 *
 * The README promises "everyone else is blocked by default" but the gate
 * was previously not wired into the inbound pipeline (gate() in
 * src/lib/access.ts had no production callers). This middleware closes
 * that gap by dropping inbounds from senders not in `access.allowFrom`
 * (or all inbounds when `dmPolicy === 'disabled'`).
 *
 * Sits early in the pipeline — after mw-trace + mw-identity (so the
 * trace records the drop and chatId is already normalized) but before
 * mw-typing / mw-admin / mw-onboarding / mw-welcome. Non-allowlisted
 * senders never trigger downstream side effects (no typing indicator,
 * no welcome message, no API tokens spent).
 */
import type { Middleware } from './types'
import type { Access } from '../../lib/access'

export interface AccessMwDeps {
  loadAccess: () => Access
  log: (tag: string, line: string, fields?: Record<string, unknown>) => void
}

export function makeMwAccess(deps: AccessMwDeps): Middleware {
  return async (ctx, next) => {
    const access = deps.loadAccess()
    // Mirror gate()'s logic but inline so we can log per-decision detail.
    if (access.dmPolicy === 'disabled') {
      deps.log('ACCESS', `drop chat=${ctx.msg.chatId} reason=dm_policy_disabled`)
      ctx.consumedBy = 'access'
      return
    }
    // '*' is a match-all wildcard — used by the e2e harness's default
    // allowFrom and by operators who explicitly want an open daemon.
    // Default access from disk is { allowFrom: [] } (no wildcard), so the
    // README's "everyone else is blocked by default" promise is preserved.
    const allowed = access.allowFrom.includes('*') || access.allowFrom.includes(ctx.msg.chatId)
    if (!allowed) {
      deps.log(
        'ACCESS',
        `drop chat=${ctx.msg.chatId} reason=not_in_allowlist allowFrom_count=${access.allowFrom.length}`,
      )
      ctx.consumedBy = 'access'
      return
    }
    await next()
  }
}
