import { randomBytes } from 'node:crypto'
import type { UserTier } from '../../core/user-tier'

/**
 * token-registry — maps an internal-api bearer token to the tier and origin
 * it grants. Replaces the old single-token check so the route layer can
 * enforce the *caller's* tier (see route-tiers.ts).
 *
 * Security model (see docs/superpowers/specs/2026-06-21-internal-api-tier-authz-design.md):
 *   - The daemon-wide FILE token is registered as `trusted` — a shell-readable
 *     credential can't be trusted above the least-trusted process that can read
 *     it (a `trusted` agent has shell access as the same OS user).
 *   - SESSION tokens are minted env-only per spawn and carry that session's
 *     actual tier; admin therefore only originates from a daemon-minted
 *     admin-session token, never a file.
 */
export type TokenInfo = { tier: UserTier; origin: 'file' | 'session'; sessionKey?: string }

export interface TokenRegistry {
  registerFileToken(tokenHex: string): void
  mint(tier: UserTier, sessionKey: string): string
  resolve(tokenHex: string): TokenInfo | null
  invalidateSession(sessionKey: string): void
}

export function makeTokenRegistry(randomHex: () => string = () => randomBytes(32).toString('hex')): TokenRegistry {
  // Keyed on the full high-entropy hex secret: a Map.get leaks no useful
  // timing oracle (an attacker must already hold a complete valid token to
  // get a hit). This replaces the old timingSafeEqual-against-one-token check,
  // which doesn't scale to N tokens.
  const map = new Map<string, TokenInfo>()
  return {
    registerFileToken(tokenHex) {
      map.set(tokenHex, { tier: 'trusted', origin: 'file' })
    },
    mint(tier, sessionKey) {
      const tok = randomHex()
      map.set(tok, { tier, origin: 'session', sessionKey })
      return tok
    },
    resolve(tokenHex) {
      return map.get(tokenHex) ?? null
    },
    invalidateSession(sessionKey) {
      for (const [tok, info] of map) {
        if (info.origin === 'session' && info.sessionKey === sessionKey) map.delete(tok)
      }
    },
  }
}
