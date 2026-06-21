import type { UserTier } from '../../core/user-tier'

/**
 * route-tiers — the minimum tier each internal-api route requires. The
 * dispatcher resolves the caller's tier from its token (token-registry.ts) and
 * rejects anything below the route's minimum. Anything NOT listed defaults to
 * `admin` via minTierFor (fail-closed: a new route can't ship world-open).
 *
 * Tiers track the corresponding ToolKind's policy in user-tier.ts where one
 * exists; operator/infra routes are assigned explicitly. See
 * docs/superpowers/specs/2026-06-21-internal-api-tier-authz-design.md §5.
 */
export const TIER_RANK: Record<UserTier, number> = { guest: 0, trusted: 1, admin: 2 }

export function tierMeets(have: UserTier, need: UserTier): boolean {
  return TIER_RANK[have] >= TIER_RANK[need]
}

export const ROUTE_MIN_TIER: Record<string, UserTier> = {
  // guest — liveness + read/reply
  'GET /v1/health': 'guest',
  'POST /v1/wechat/reply': 'guest',
  'POST /v1/wechat/reply_voice': 'guest',
  'POST /v1/memory/read': 'guest',
  'GET /v1/memory/list': 'guest',
  'POST /v1/share/page': 'guest',
  'POST /v1/share/resurface': 'guest',
  'GET /v1/companion/status': 'guest',
  // trusted — operator/agent ops (also reachable by the CLI, capped at trusted)
  'POST /v1/wechat/broadcast': 'trusted',
  'POST /v1/wechat/send_file': 'trusted',
  'POST /v1/wechat/edit_message': 'trusted',
  'POST /v1/memory/write': 'trusted',
  'POST /v1/memory/delete': 'trusted',
  'POST /v1/user/set_name': 'trusted',
  'POST /v1/voice/save_config': 'trusted',
  'GET /v1/voice/status': 'trusted',
  'POST /v1/companion/enable': 'trusted',
  'POST /v1/companion/disable': 'trusted',
  'POST /v1/companion/snooze': 'trusted',
  'POST /v1/conversation/set-mode': 'trusted',
  'GET /v1/projects/list': 'trusted',
  'POST /v1/projects/add': 'trusted',
  'POST /v1/projects/remove': 'trusted',
  'POST /v1/projects/switch': 'trusted',
  'GET /v1/a2a/list': 'trusted',
  'GET /v1/a2a/info': 'trusted',
  'GET /v1/a2a/activity': 'trusted',
  'POST /v1/a2a/preview': 'trusted',
  'POST /v1/a2a/install': 'trusted',
  'POST /v1/a2a/remove': 'trusted',
  'POST /v1/a2a/pause': 'trusted',
  'POST /v1/a2a/send': 'trusted',
  'POST /v1/a2a/test': 'trusted',
  'POST /v1/delegate': 'trusted',
  // admin — daemon-control (daemon_introspect / daemon_remediate)
  'GET /v1/turns': 'admin',
  'GET /v1/sessions': 'admin',
  'GET /v1/model': 'admin',
  'POST /v1/sessions/release': 'admin',
  'POST /v1/model': 'admin',
  'POST /v1/daemon/restart': 'admin',
}

export function minTierFor(routeKey: string): UserTier {
  return ROUTE_MIN_TIER[routeKey] ?? 'admin'
}
