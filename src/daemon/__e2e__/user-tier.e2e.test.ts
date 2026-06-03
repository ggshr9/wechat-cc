// End-to-end acceptance test for the 3-tier permission feature.
//
// This is the smoke alarm for the whole chain:
//   inbound  → coordinator → resolveTier → manager.acquire →
//   provider.spawn → tierProfileToClaudeSdkOpts → SDK options
//
// If any of those links is broken (tier resolver picks the wrong bucket,
// provider drops tierProfile, bootstrap stops calling
// tierProfileToClaudeSdkOpts, etc.) this test fails — guarding against
// silent regressions where guests would have admin-level Bash access or
// admins would have a locked-down `default` permission mode.
//
// Two scenarios — both run inside a single `it()` against ONE daemon so
// the access.ts module's STATE_DIR (frozen at first import) stays valid
// for the whole test. Running them in separate `it()` blocks would
// require either resetting the module graph between tests (invasive) or
// touching production code to make STATE_DIR re-readable; both larger
// than this feature warrants.
//
// Scenario A — tier maps to SDK options:
//   Two chats on the same daemon — one in `admins`, one not — produce
//   different SDK option snapshots at spawn time. Under strict mode
//   (dangerously=false) BOTH spawn in `default` permissionMode; the tier
//   distinction now lives in `disallowedTools` — admin has none (empty
//   deny set), guest's includes `Bash`/`Write`/`Edit`. Post-RFC-05,
//   `bypassPermissions` is `--dangerously`-only (regardless of tier);
//   admin's destructive ops relay via canUseTool instead.
//
// Scenario B — tier demotion invalidates live sessions:
//   Rewriting access.json to remove a chat from `admins` triggers the
//   access reader's invalidator → sessionManager.shutdown() → the next
//   inbound respawns under the new (guest) tier — verified by the
//   recorder seeing a third snapshot whose shape matches guest, not
//   admin.
//
// The harness `recordClaudeSpawnOptions` hook (added alongside this test)
// captures the SDK options passed to every streaming `query()` — i.e.
// every AgentSession spawn, not cheapEval/moderator paths.
//
// NOTE on imports: access.ts is imported lazily inside the test body
// because its module-level STATE_DIR constant is frozen at first import.
// A top-level static import would pin it to whatever WECHAT_STATE_DIR
// was at test-file load time (typically unset → user's real home), not
// the per-test tmp stateDir the harness configures.
import { describe, it, expect } from 'vitest'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { startTestDaemon } from './harness'

interface SpawnRecord {
  permissionMode: 'default' | 'bypassPermissions' | string
  disallowedTools?: ReadonlyArray<string>
}

function asSpawnRecord(opts: Record<string, unknown>): SpawnRecord {
  return {
    permissionMode: String(opts.permissionMode ?? ''),
    ...(Array.isArray(opts.disallowedTools) ? { disallowedTools: opts.disallowedTools as string[] } : {}),
  }
}

describe('e2e: user-tier permissions', () => {
  it('admin/guest get tier-specific SDK options; access edit invalidates live sessions', async () => {
    const spawns: SpawnRecord[] = []
    const daemon = await startTestDaemon({
      // dangerously=false so resolveTier honors access.json rather than
      // forcing everyone to admin tier.
      dangerously: false,
      access: {
        allowFrom: ['admin_chat', 'guest_chat'],
        admins: ['admin_chat'],
      },
      // Both chats need to skip onboarding so the inbound reaches the
      // coordinator and spawns a session.
      knownUsers: { admin_chat: 'admin_user', guest_chat: 'guest_user' },
      claudeScript: {
        async onDispatch(_text) {
          // Empty body is fine — we only need the spawn to happen, not
          // a real outbound. The recorder fires before any onDispatch.
          return { toolCalls: [], finalText: 'ok' }
        },
      },
      recordClaudeSpawnOptions: opts => {
        spawns.push(asSpawnRecord(opts))
      },
    })
    try {
      // ── Scenario A — tier-specific spawn options ─────────────────────
      // Send from admin first, wait for reply (proves dispatch finished),
      // then from guest. Sequencing avoids races over the shared
      // recorder array.
      daemon.sendText('admin_chat', 'hi from admin')
      await daemon.waitForReplyTo('admin_chat', 8000)

      daemon.sendText('guest_chat', 'hi from guest')
      await daemon.waitForReplyTo('guest_chat', 8000)

      // Two spawns so far — one per chatId. The recorder is wired to the
      // streaming path only, so cheapEval/moderator won't add records.
      expect(spawns.length).toBe(2)

      // Under strict mode both tiers spawn in `default` permissionMode —
      // post-RFC-05, admin no longer gets a bypassPermissions SDK spawn (its
      // destructive ops relay via canUseTool instead). The tier distinction
      // is in `disallowedTools`, not `permissionMode`. Admin sent first and
      // we awaited its reply before guest, so spawns[0]=admin, spawns[1]=guest.
      const adminSpawn = spawns[0]
      const guestSpawn = spawns[1]

      expect(adminSpawn?.permissionMode, 'admin spawns in default mode under strict').toBe('default')
      // Admin profile has empty deny set → disallowedTools absent
      // (the bootstrap drops the key when the array is empty via the
      // conditional-spread).
      expect(adminSpawn?.disallowedTools ?? []).toEqual([])

      expect(guestSpawn?.permissionMode, 'guest spawns in default mode').toBe('default')
      expect(guestSpawn?.disallowedTools, 'guest must have disallowedTools populated').toBeTruthy()
      // The headline guarantee: a chat that can DM the bot but isn't
      // an admin can't pop a Bash shell.
      expect(guestSpawn?.disallowedTools ?? []).toContain('Bash')
      // Sanity: a couple of other built-ins guest profile denies.
      expect(guestSpawn?.disallowedTools ?? []).toContain('Write')
      expect(guestSpawn?.disallowedTools ?? []).toContain('Edit')

      // ── Scenario B — tier demotion invalidates the live session ──────
      // Rewrite access.json so admin_chat is no longer in `admins`.
      // Both chats stay in allowFrom so inbounds aren't dropped.
      writeFileSync(
        join(daemon.stateDir, 'access.json'),
        JSON.stringify({ allowFrom: ['admin_chat', 'guest_chat'], admins: [] }, null, 2),
      )
      // Dynamic import — see the note at the top of the file on why
      // access.ts can't be static-imported here. By now the daemon has
      // already loaded it via the import chain, so STATE_DIR is bound
      // to daemon.stateDir.
      const access = await import('../../lib/access')
      // Clear the 5s in-memory TTL cache so the next loadAccess() reads
      // the fresh access.json from disk → snapshot diff fires the
      // session invalidator.
      access._clearCache()
      // Trigger the access read explicitly — the next loadAccess() in
      // the daemon's inbound pipeline would do this anyway, but firing
      // it here lets us await shutdown completion before sending the
      // new inbound, eliminating the race where acquire() returns the
      // still-live session.
      access.loadAccess()
      // session-manager's shutdown awaits release() on each in-flight
      // session — local ops, so 200ms is generous.
      await new Promise(r => setTimeout(r, 200))

      // Send from admin_chat AGAIN. With the old (admin) session killed,
      // acquire() will spawn fresh — under the new (guest) tier — and
      // the recorder picks it up as spawn #3.
      daemon.sendText('admin_chat', 'second ping (now demoted)')
      await daemon.waitForReplyTo('admin_chat', 8000)

      // Poll briefly for the spawn record — the recorder fires once
      // query() starts iterating, which is one microtask later than
      // dispatch() resolution.
      const start = Date.now()
      while (spawns.length < 3 && Date.now() - start < 3000) {
        await new Promise(r => setTimeout(r, 50))
      }

      expect(spawns.length).toBeGreaterThanOrEqual(3)
      const reSpawn = spawns[2]
      // permissionMode is always `default` under strict mode, so the
      // meaningful demotion signal is that the respawn now carries guest's
      // `disallowedTools` — the chat lost its Bash access.
      expect(reSpawn?.permissionMode, 'strict-mode spawns are always default').toBe('default')
      expect(reSpawn?.disallowedTools ?? [], 'demoted chat must lose Bash').toContain('Bash')
    } finally {
      // Belt-and-braces — module-level access cache + invalidator are
      // process-global. Reset so a sibling e2e test (or a subsequent
      // re-run with hot module cache) isn't influenced by our writes.
      try {
        const access = await import('../../lib/access')
        access._clearCache()
        access._resetSnapshotForTest()
      } catch { /* module not yet imported — nothing to reset */ }
      await daemon.stop()
    }
  })
})
