import { describe, it, expect } from 'vitest'
import { ROUTE_MIN_TIER, tierMeets } from '../daemon/internal-api/route-tiers'

// The internal-api /v1 routes the operator CLI calls (keep in sync with
// src/cli/*.ts). The CLI authenticates with the daemon-wide FILE token, which
// the route layer grants `trusted` — so every CLI route must be reachable at
// trusted. An admin-only CLI route would silently 403 in the field.
const CLI_ROUTES = [
  'POST /v1/a2a/send',
]

describe('CLI is capped at trusted', () => {
  it('every CLI internal-api route is reachable at trusted tier', () => {
    for (const r of CLI_ROUTES) {
      const need = ROUTE_MIN_TIER[r] ?? 'admin'
      expect(tierMeets('trusted', need), `${r} requires ${need} but the CLI is trusted`).toBe(true)
    }
  })
})
