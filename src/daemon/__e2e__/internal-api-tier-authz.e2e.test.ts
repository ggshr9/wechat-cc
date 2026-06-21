// End-to-end acceptance test for internal-api per-session tier authorization.
//
// This is the smoke alarm for the server-side authz the feature exists for:
//   real daemon → real loopback HTTP server → token-registry resolve →
//   route-tiers default-deny → tierMeets(caller, route-min)
//
// The threat model (spec §2): a shell-capable TRUSTED agent can read the
// daemon's token file and `curl` the admin-only daemon-control routes
// directly — bypassing the wechat-MCP registration gate and claude's
// canUseTool. The fix enforces the caller's tier at the route layer. The
// daemon's on-disk token (`internal-api-info.json` → tokenFilePath) IS that
// trusted-tier token, so this test reproduces the exact attack and asserts
// the 403.
//
// It drives the actual HTTP surface (fetch over the bound port), not the
// dispatcher in isolation — so it also guards the wiring no unit test sees:
// the info-file discovery, the file-token → trusted registration, and the
// ordered guest<trusted<admin rank check across three real routes.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { startTestDaemon } from './harness'

interface ApiInfo { baseUrl: string; tokenFilePath: string }

function readApiInfo(stateDir: string): ApiInfo {
  const info = JSON.parse(readFileSync(join(stateDir, 'internal-api-info.json'), 'utf8')) as ApiInfo
  return info
}

describe('e2e: internal-api enforces caller tier at the route layer', () => {
  it('rejects unauth (401), denies a trusted token from admin routes (403), allows it on guest+trusted routes', async () => {
    const daemon = await startTestDaemon({ dangerously: false })
    try {
      const { baseUrl, tokenFilePath } = readApiInfo(daemon.stateDir)
      // The on-disk token registers as TRUSTED — the shell-capable agent the
      // feature defends against (it can read this very file and curl routes).
      const trusted = readFileSync(tokenFilePath, 'utf8').trim()
      const auth = (tok: string) => ({ headers: { authorization: `Bearer ${tok}` } })

      // 1. No Authorization header → 401 unauthorized (before any tier check).
      const noAuth = await fetch(`${baseUrl}/v1/health`)
      expect(noAuth.status).toBe(401)
      expect(await noAuth.json()).toEqual({ error: 'unauthorized' })

      // 2. A well-formed-but-unregistered hex token → 401 (resolve miss).
      const ghost = await fetch(`${baseUrl}/v1/health`, auth('deadbeefcafe'))
      expect(ghost.status).toBe(401)

      // 3. A non-hex token fails the Bearer regex → 401 (never reaches resolve).
      const malformed = await fetch(`${baseUrl}/v1/health`, auth('not-a-hex-token'))
      expect(malformed.status).toBe(401)

      // 4. Trusted token on a GUEST-min route → allowed (rank 1 ≥ 0).
      const health = await fetch(`${baseUrl}/v1/health`, auth(trusted))
      expect(health.status).toBe(200)

      // 5. Trusted token on a TRUSTED-min route → allowed (rank 1 ≥ 1).
      const projects = await fetch(`${baseUrl}/v1/projects/list`, auth(trusted))
      expect(projects.status).toBe(200)

      // 6. THE GUARANTEE — trusted token on an ADMIN-min route → 403 forbidden,
      //    with the required tier surfaced. This is the shell-curl attack; the
      //    route layer rejects it even though the agent holds a valid token.
      const turns = await fetch(`${baseUrl}/v1/turns`, auth(trusted))
      expect(turns.status).toBe(403)
      expect(await turns.json()).toEqual({ error: 'forbidden', required: 'admin' })

      // 7. Unknown route with a valid token → 404 (route table is default-deny
      //    on tier, but an absent route is not-found, not forbidden).
      const missing = await fetch(`${baseUrl}/v1/does-not-exist`, auth(trusted))
      expect(missing.status).toBe(404)
    } finally {
      await daemon.stop()
    }
  })
})
