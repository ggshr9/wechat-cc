/**
 * bot-name — derive the bot's user-facing self-name from the active
 * conversation mode. Used in onboarding greetings and `/whoami`.
 *
 * Mapping is intentional: `claude` → `cc` (matches the slash command
 * `/cc` and the Claude Code CLI alias most users know). Other provider
 * ids pass through verbatim.
 *
 * Keep this pure (no registry / network) so it's trivially testable
 * and safe to call from anywhere in the request hot path.
 */
import type { Mode } from '../core/conversation'

export function botNameForMode(mode: Mode): string {
  const nameOf = (id: string): string => (id === 'claude' ? 'cc' : id)
  switch (mode.kind) {
    case 'solo':         return nameOf(mode.provider)
    case 'primary_tool': return nameOf(mode.primary)
    case 'parallel':
    case 'chatroom':     return 'cc + codex'
  }
}
