/**
 * Static provider display-name map (RFC 03 P3).
 *
 * Lives outside the registry because internal-api needs to resolve
 * names BEFORE the registry is constructed (registry construction
 * depends on internalApi having a port; chicken-and-egg). Adding a new
 * provider means adding an entry here AND registering with the
 * ProviderRegistry — both small.
 *
 * Falls back to a Title-cased version of the id when the provider isn't
 * known here. Keeps things working for one-off / experimental providers
 * registered in tests without a corresponding edit to this file.
 */
import type { ProviderId } from '../core/conversation'

const KNOWN_NAMES: Readonly<Record<string, string>> = Object.freeze({
  claude: 'Claude',
  codex: 'Codex',
})

export function providerDisplayName(id: ProviderId): string {
  if (KNOWN_NAMES[id]) return KNOWN_NAMES[id]!
  // Generic fallback: capitalize the first character so unknown ids
  // come out readable (`gemini` → `Gemini`).
  if (id.length === 0) return id
  return id.charAt(0).toUpperCase() + id.slice(1)
}
