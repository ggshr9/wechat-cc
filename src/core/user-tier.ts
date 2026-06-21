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
import type { PermissionMode } from './permission-mode'

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
  | 'a2a_send'
  | 'daemon_introspect'  // admin-only read-only self-diagnosis (turns / sessions / health)

const ALL_KINDS: ReadonlySet<ToolKind> = new Set([
  'reply', 'share_page', 'memory_read', 'memory_write', 'memory_delete',
  'observations_read', 'observations_write',
  'fs_read', 'fs_write', 'shell', 'shell_destructive', 'network', 'subagent',
  'a2a_send', 'daemon_introspect',
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

// Admin tier still gets prompted in strict mode for genuinely
// destructive ops — they're admins, but accidents happen. The relay
// prompt goes to the admin themselves (per the sweep#6 fix in
// resolveAdminChatId), giving a "are you sure?" gate without
// inconveniencing day-to-day use. Operators who want zero prompts
// launch with `--dangerously`.
const ADMIN_RELAY = new Set<ToolKind>(['shell_destructive', 'memory_delete'])

const TRUSTED_RELAY = new Set<ToolKind>(['shell_destructive', 'memory_delete', 'a2a_send'])

const GUEST_ALLOW = new Set<ToolKind>(['reply', 'share_page', 'memory_read', 'observations_read'])

// Admin-exclusive tools — the operator can ask the bot to inspect its own
// daemon (turn outcomes / live sessions / health). Denied for trusted and
// guest: daemon internals are an operator concern, and the later remediation
// tools (release session / restart) that build on this must never be reachable
// from a non-admin chat. guest already denies it via difference below; trusted
// would otherwise auto-allow (it's not destructive), so deny it explicitly.
const ADMIN_ONLY = new Set<ToolKind>(['daemon_introspect'])

export const TIER_PROFILES: Record<UserTier, TierProfile> = {
  admin: {
    allow: difference(ALL_KINDS, ADMIN_RELAY),
    relay: ADMIN_RELAY,
    deny: new Set(),
  },
  trusted: {
    allow: difference(difference(ALL_KINDS, TRUSTED_RELAY), ADMIN_ONLY),
    relay: TRUSTED_RELAY,
    deny: ADMIN_ONLY,
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

/**
 * Effective tier, honoring the daemon-wide `--dangerously` flag. When the
 * operator launched with `--dangerously` (`permissionMode === 'dangerously'`)
 * every chat is treated as admin — matching the pre-v0.6 behavior where
 * the dangerously flag uniformly bypassed sandbox / approval / canUseTool
 * for ALL chats. Without this override the per-tier sandbox/approval
 * derivation (codex guest → read-only + untrusted; claude trusted →
 * default+canUseTool) silently overrode the operator's intent on every
 * non-admin chat.
 */
export function resolveEffectiveTier(
  chatId: string,
  access: Access,
  permissionMode: PermissionMode,
): UserTier {
  if (permissionMode === 'dangerously') return 'admin'
  return resolveTier(chatId, access)
}

/**
 * Regex set for destructive Bash commands. Best-effort — a determined
 * adversary can `eval` or obfuscate. The intent is preventing
 * accidents and surface-level prompt injection, not stopping malice.
 *
 * Pattern guidelines:
 *   - Anchor to word boundaries so we don't over-fire on "rm" inside a path
 *     ("/var/farm/...").
 *   - Quote chars (`'` / `"`) ARE in the trigger class — `bash -c "rm -rf"`
 *     is a real attack/accident path (AI agents routinely chain commands
 *     via `bash -c "..."`). This means `echo "rm is dangerous"` also
 *     classifies as destructive; for a relay prompt that's an acceptable
 *     false positive — the doc-string above commits us to err on the
 *     side of triggering.
 *   - `\s+` between args so `rm  -rf` (multiple spaces) still matches.
 *
 * Extend by adding patterns; document the rationale next to each.
 */
const TRIGGER = String.raw`(?:^|[;&|\`$()\s'"])`
const DESTRUCTIVE_BASH_PATTERNS: ReadonlyArray<RegExp> = [
  new RegExp(`${TRIGGER}rm(?:\\s+-[a-zA-Z]*)*\\s+`),     // rm, rm -rf, rm -f, etc.
  new RegExp(`${TRIGGER}git\\s+reset\\s+--hard`),        // git reset --hard
  new RegExp(`${TRIGGER}git\\s+push\\b[^|]*--force`),    // git push --force / --force-with-lease
  new RegExp(`${TRIGGER}git\\s+branch\\s+-D\\b`),        // git branch -D
  new RegExp(`${TRIGGER}dd\\s+(?:if|of)=`),              // dd if=… of=…
]

function isDestructiveBash(command: string): boolean {
  return DESTRUCTIVE_BASH_PATTERNS.some(re => re.test(command))
}

/**
 * Map (toolName, input) to a daemon ToolKind. Unknown tools collapse to
 * 'subagent' (the most-restricted bucket) so adding a new tool without
 * a classifier update fails safe.
 */
export function classifyToolUse(toolName: string, input: Record<string, unknown>): ToolKind {
  // MCP-prefixed wechat tools
  if (toolName.startsWith('mcp__wechat__')) {
    const sub = toolName.slice('mcp__wechat__'.length)
    if (sub === 'reply') return 'reply'
    if (sub === 'share_page') return 'share_page'
    if (sub === 'memory_list' || sub === 'memory_read') return 'memory_read'
    if (sub === 'memory_write' || sub === 'memory_edit') return 'memory_write'
    if (sub === 'memory_delete') return 'memory_delete'
    if (sub === 'observations_list' || sub === 'observations_read') return 'observations_read'
    if (sub === 'observations_write' || sub === 'observations_archive') return 'observations_write'
    if (sub === 'a2a_send') return 'a2a_send'
    if (sub === 'diagnostic_turns' || sub === 'diagnostic_sessions' || sub === 'diagnostic_health') return 'daemon_introspect'
    // Other wechat tools: classify as fs_read (safest non-reply default
    // for new wechat MCP tools — they tend to be query-like).
    return 'fs_read'
  }

  // Built-in Claude Code tools
  if (toolName === 'Read' || toolName === 'Glob' || toolName === 'Grep' || toolName === 'LS') return 'fs_read'
  if (toolName === 'Write' || toolName === 'Edit' || toolName === 'NotebookEdit') return 'fs_write'
  if (toolName === 'Bash') {
    const cmd = typeof input.command === 'string' ? input.command : ''
    return isDestructiveBash(cmd) ? 'shell_destructive' : 'shell'
  }
  if (toolName === 'KillShell') return 'shell'
  if (toolName === 'WebFetch' || toolName === 'WebSearch') return 'network'
  if (toolName === 'Task') return 'subagent'

  // Unknown — fail safe. Subagent is in `guest.deny`, so guests can't
  // call a tool we haven't classified yet.
  return 'subagent'
}
