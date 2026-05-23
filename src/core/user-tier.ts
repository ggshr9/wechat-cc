/**
 * User-tier policy — single source of truth for "what can this chat do".
 *
 * Three tiers, derived from access.json:
 *   - admin (access.admins): full access
 *   - trusted (access.trusted): full except destructive ops (relay to admin)
 *   - guest (allowed but not admin/trusted): reply + read only
 *
 * The TierProfile is daemon-defined; each provider's
 * `tierProfileToSdkOpts(profile)` is the only place that knows how to
 * translate the profile into its own SDK's permission knobs.
 *
 * See docs/superpowers/specs/2026-05-22-user-tier-permissions-design.md.
 */
import type { Access } from '../lib/access'

export type UserTier = 'admin' | 'trusted' | 'guest'

export type ToolKind =
  | 'reply'
  | 'share_page'
  | 'memory_read'
  | 'memory_write'
  | 'memory_delete'
  | 'observations_read'
  | 'observations_write'
  | 'fs_read'
  | 'fs_write'
  | 'shell'
  | 'shell_destructive'  // virtual — set by classifyToolUse when Bash input matches a destructive pattern
  | 'network'
  | 'subagent'

const ALL_KINDS: ReadonlySet<ToolKind> = new Set([
  'reply', 'share_page', 'memory_read', 'memory_write', 'memory_delete',
  'observations_read', 'observations_write',
  'fs_read', 'fs_write', 'shell', 'shell_destructive', 'network', 'subagent',
])

export interface TierProfile {
  /** Tools directly allowed without further check. */
  allow: ReadonlySet<ToolKind>
  /** Tools that require a permission prompt to the admin chat. */
  relay: ReadonlySet<ToolKind>
  /** Tools the SDK is told (or directed) to refuse outright. */
  deny: ReadonlySet<ToolKind>
}

function difference(a: ReadonlySet<ToolKind>, b: ReadonlySet<ToolKind>): Set<ToolKind> {
  const out = new Set<ToolKind>()
  for (const k of a) if (!b.has(k)) out.add(k)
  return out
}

const TRUSTED_RELAY = new Set<ToolKind>(['shell_destructive', 'memory_delete'])

const GUEST_ALLOW = new Set<ToolKind>(['reply', 'share_page', 'memory_read', 'observations_read'])

export const TIER_PROFILES: Record<UserTier, TierProfile> = {
  admin: {
    allow: ALL_KINDS,
    relay: new Set(),
    deny: new Set(),
  },
  trusted: {
    allow: difference(ALL_KINDS, TRUSTED_RELAY),
    relay: TRUSTED_RELAY,
    deny: new Set(),
  },
  guest: {
    allow: GUEST_ALLOW,
    relay: new Set(),
    deny: difference(ALL_KINDS, GUEST_ALLOW),
  },
}

/**
 * Resolve a chatId's tier from access.json snapshot. Admin > trusted > guest.
 * A chatId not in any list still maps to guest — the assumption is the
 * upstream allowlist gate has already rejected outright-blocked users.
 */
export function resolveTier(chatId: string, access: Access): UserTier {
  if (access.admins?.includes(chatId)) return 'admin'
  if (access.trusted?.includes(chatId)) return 'trusted'
  return 'guest'
}
