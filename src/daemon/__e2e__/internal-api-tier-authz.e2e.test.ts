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

/** Recover the per-session token + tier the daemon baked into a spawn's wechat
 *  MCP child env (the env-only secret each provider injects at spawn time). */
function sessionAuthOf(opts: Record<string, unknown>): { token?: string; tier?: string } {
  const mcp = opts.mcpServers as Record<string, { env?: Record<string, string> }> | undefined
  const env = mcp?.wechat?.env
  return { token: env?.WECHAT_SESSION_TOKEN, tier: env?.WECHAT_SESSION_TIER }
}

describe('e2e: internal-api enforces caller tier at the route layer', () => {
  it('rejects unauth (401), denies trusted from admin routes (403), allows trusted on guest+trusted, admin on admin', async () => {
    // One daemon for the whole matrix — access.ts freezes STATE_DIR at first
    // import, so a second it()+daemon would read the wrong stateDir. An admin
    // chat (the harness default `admins: ['testadmin']`) lets us recover a
    // real admin-tier token from its spawn's MCP env.
    const spawns: Record<string, unknown>[] = []
    const daemon = await startTestDaemon({
      dangerously: false,
      // Mark testadmin as a known user so its first message dispatches (spawns
      // a session) instead of being consumed by the onboarding flow.
      knownUsers: { testadmin: 'admin_user' },
      claudeScript: { async onDispatch() { return { toolCalls: [], finalText: 'ok' } } },
      recordClaudeSpawnOptions: o => { spawns.push(o) },
    })
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

      // 8. THE POSITIVE HALF — an ADMIN token DOES reach the same admin route.
      //    Drive an admin chat so the daemon mints an admin-tier token and
      //    bakes it into that session's wechat MCP env; recover it and prove
      //    /v1/turns returns 200 for admin where trusted got 403 above. This
      //    closes the rank matrix end-to-end: mint → inject → authorize.
      daemon.sendText('testadmin', 'hi')
      // Poll the recorder directly — waiting on a reply would race the harness's
      // startup-notify outbound to the same admin chat (it resolves before the
      // dispatch spawn records).
      let adminAuth: { token?: string; tier?: string } | undefined
      const deadline = Date.now() + 8000
      while (Date.now() < deadline) {
        adminAuth = spawns.map(sessionAuthOf).find(s => s.tier === 'admin')
        if (adminAuth?.token) break
        await new Promise(r => setTimeout(r, 25))
      }
      expect(adminAuth?.token, 'admin chat spawn must carry an admin session token').toBeTruthy()

      const adminTurns = await fetch(`${baseUrl}/v1/turns`, auth(adminAuth!.token!))
      expect(adminTurns.status).toBe(200)
    } finally {
      await daemon.stop()
    }
  })
})
