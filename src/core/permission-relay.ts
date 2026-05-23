import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import type { Mode, ProviderId } from './conversation'
import { lookup, type Capability, type PermissionMode } from './capability-matrix'
import { classifyToolUse, TIER_PROFILES, type TierProfile, type ToolKind, type UserTier } from './user-tier'

/**
 * Combine the capability-matrix base policy with the tier profile into a
 * single allow/relay/deny decision for one tool call.
 *
 * Precedence:
 *   1. tier.deny  → deny (tier forbids this kind outright)
 *   2. tier.relay → relay (tier requires admin approval for this kind)
 *   3. otherwise → defer to matrix base.askUser:
 *      - 'per-tool' → relay (matrix dictates per-tool prompt)
 *      - 'never'    → allow (matrix says no prompt needed)
 */
export function effectivePolicy(
  base: Capability,
  tp: TierProfile,
  kind: ToolKind,
): 'allow' | 'relay' | 'deny' {
  if (tp.deny.has(kind)) return 'deny'
  if (tp.relay.has(kind)) return 'relay'
  return base.askUser === 'per-tool' ? 'relay' : 'allow'
}

export interface PermissionRelayDeps {
  askUser: (chatId: string, prompt: string, hash: string, timeoutMs: number) => Promise<'allow' | 'deny' | 'timeout'>
  /**
   * chatId of the chat that initiated this dispatch (for routing context
   * only — NOT the prompt target). Kept for log correlation; relay
   * prompts always go to `adminChatId`.
   */
  initiatingChatId: () => string | null
  /** chatId of an admin to receive prompts. May be null if no admins configured. */
  adminChatId: () => string | null
  /** Returns the tier of the initiating chat — used by effectivePolicy. */
  resolveTier: () => UserTier
  log: (tag: string, line: string) => void
  /**
   * Resolve the chat's CURRENT mode at the moment of the tool call.
   * Previously a static value captured at boot time which always read
   * 'solo' even for chats actually in chatroom/parallel/primary_tool —
   * caused the capability-matrix lookup to consult the wrong row and
   * could let through (or wrongly deny) tools depending on which mode
   * the chat was actually in. Callback shape lets bootstrap wire it
   * to `conversationStore.get(chatId)?.mode.kind`.
   */
  mode: () => Mode['kind']
  provider: ProviderId
  permissionMode: PermissionMode
}

const DEFAULT_TIMEOUT_MS = 10 * 60_000

export function makeCanUseTool(deps: PermissionRelayDeps): CanUseTool {
  return async (toolName, input, opts) => {
    const tier = deps.resolveTier()
    const tp = TIER_PROFILES[tier]
    const kind = classifyToolUse(toolName, input as Record<string, unknown>)
    const base = lookup(deps.mode(), deps.provider, deps.permissionMode)
    const decision = effectivePolicy(base, tp, kind)

    if (decision === 'allow') return { behavior: 'allow' } satisfies PermissionResult
    if (decision === 'deny') {
      deps.log('PERMISSION', `deny: tool=${toolName} kind=${kind} tier=${tier}`)
      return {
        behavior: 'deny',
        message: `Tool '${toolName}' (${kind}) not available to tier '${tier}'`,
      } satisfies PermissionResult
    }
    // relay
    const target = deps.adminChatId()
    if (!target) {
      deps.log('PERMISSION', `relay-but-no-admin: tool=${toolName} kind=${kind} — denying`)
      return {
        behavior: 'deny',
        message: 'no admin configured to approve permission requests',
      } satisfies PermissionResult
    }
    const hash = shortHash(opts.toolUseID ?? '')
    const prompt = opts.title ?? `Claude wants to run ${toolName} ${compactInput(input)}`
    const answer = await deps.askUser(target, prompt, hash, DEFAULT_TIMEOUT_MS)
    if (answer === 'allow') return { behavior: 'allow' } satisfies PermissionResult
    deps.log('PERMISSION', `${answer}: tool=${toolName} hash=${hash}`)
    return {
      behavior: 'deny',
      message: answer === 'timeout' ? 'User did not reply in time; request denied' : 'User denied the request',
    } satisfies PermissionResult
  }
}

function shortHash(s: string): string {
  let h = 0
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36).slice(0, 5)
}

function compactInput(input: Record<string, unknown>): string {
  const keys = Object.keys(input)
  if (keys.length === 0) return ''
  const first = keys[0]
  if (!first) return ''
  const v = input[first]
  return `${first}=${typeof v === 'string' ? v.slice(0, 40) : typeof v}`
}
