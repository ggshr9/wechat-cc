// End-to-end acceptance test for the self-heal "switch my model" remediation.
//
// The AI-native-self-healing story: an admin tells the bot to change its
// model, the bot curls POST /v1/model, and the change takes effect on the
// NEXT session spawn — no daemon restart. That hinges on the mtime+size
// cached config reader (bootstrap's currentClaudeModel) re-reading agent-
// config.json after the route rewrites it. Unit tests cover the reader and
// the route in isolation; only an e2e proves the whole loop end-to-end:
//   admin token → POST /v1/model → file rewrite → cache invalidation →
//   next spawn's SDK options carry the new model.
//
// It also exercises the authz path for real — the POST is an admin-min route,
// driven with an admin-tier token recovered from a live spawn's MCP env.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { startTestDaemon } from './harness'

function readBaseUrl(stateDir: string): string {
  return (JSON.parse(readFileSync(join(stateDir, 'internal-api-info.json'), 'utf8')) as { baseUrl: string }).baseUrl
}

/** Token the daemon baked into a spawn's wechat MCP child env. */
function tokenOf(opts: Record<string, unknown>): string | undefined {
  const mcp = opts.mcpServers as Record<string, { env?: Record<string, string> }> | undefined
  return mcp?.wechat?.env?.WECHAT_SESSION_TOKEN
}

const modelOf = (opts: Record<string, unknown>): string | undefined =>
  typeof opts.model === 'string' ? opts.model : undefined

async function pollUntil<T>(fn: () => T | undefined, timeoutMs = 8000): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const v = fn()
    if (v !== undefined) return v
    await new Promise(r => setTimeout(r, 25))
  }
  return undefined
}

describe('e2e: POST /v1/model takes effect on the next spawn (self-heal, no restart)', () => {
  it('an admin switches the model and a later chat spawns with the new one', async () => {
    const spawns: Record<string, unknown>[] = []
    const daemon = await startTestDaemon({
      // Two admin chats so the second cold-starts AFTER the switch — reusing
      // the first chat's live session would keep its original model (in-flight
      // sessions are pinned until released).
      access: { allowFrom: ['*'], admins: ['admin1', 'admin2'] },
      knownUsers: { admin1: 'u1', admin2: 'u2' },
      agentConfig: { provider: 'claude', model: 'claude-opus-4-8' },
      claudeScript: { async onDispatch() { return { toolCalls: [], finalText: 'ok' } } },
      recordClaudeSpawnOptions: o => { spawns.push(o) },
    })
    try {
      const baseUrl = readBaseUrl(daemon.stateDir)

      // 1. First admin chat spawns under the seeded model — capture its
      //    admin-tier token (for the POST) and confirm the starting model.
      daemon.sendText('admin1', 'hi')
      const first = await pollUntil(() => (spawns.length >= 1 ? spawns[0] : undefined))
      expect(first, 'first admin chat should spawn a session').toBeTruthy()
      expect(modelOf(first!)).toBe('claude-opus-4-8')
      const adminToken = tokenOf(first!)
      expect(adminToken, 'spawn must carry an admin session token').toBeTruthy()

      // 2. Admin curls the remediation route to switch the pinned model.
      const res = await fetch(`${baseUrl}/v1/model`, {
        method: 'POST',
        headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude-sonnet-4-6' }),
      })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true, provider: 'claude', model: 'claude-sonnet-4-6' })

      // 3. A DIFFERENT chat dispatches → cold spawn → its SDK options must
      //    carry the NEW model, proving the cached reader saw the file rewrite
      //    live (no restart between the switch and this spawn).
      daemon.sendText('admin2', 'hi')
      const second = await pollUntil(() => (spawns.length >= 2 ? spawns[1] : undefined))
      expect(second, 'second admin chat should spawn a session').toBeTruthy()
      expect(modelOf(second!)).toBe('claude-sonnet-4-6')
    } finally {
      await daemon.stop()
    }
  })
})
