// End-to-end acceptance test for the 3-tier permission feature — cursor side.
//
// Symmetric to user-tier-codex.e2e.test.ts (which covers the codex side)
// and user-tier.e2e.test.ts (claude side):
//   inbound  → coordinator → resolveTier → manager.acquire →
//   cursor.spawn → tierProfileToCursorSdkOpts → Agent.create options
//
// The unit test in core/cursor-agent-provider.test.ts already verifies the
// pure tierProfileToCursorSdkOpts function — what this catches is the
// wiring around it. If session-manager stops threading tierProfile into
// cursor.spawn, if the coordinator routes to claude/codex instead of
// cursor when mode says cursor, or if cursor provider's spawnOpts
// contract drifts, this test fails.
//
// Scenario — strict mode sandboxes every cursor tier:
//   Two chats on the same daemon, same alias, both pinned to solo+cursor
//   — one in `admins`, one not — both spawn with
//   `local.sandboxOptions.enabled: true` on `Agent.create()`. Cursor has
//   only one knob (sandbox on/off) and no canUseTool relay, so post-RFC-05
//   the safe default under strict mode is "sandboxed for every tier";
//   `enabled: false` (full access) is reachable only via `--dangerously`.
//   Per-tier separation for cursor guests is a documented limitation —
//   route guests to Claude when strict separation is required. What this
//   still guards: the wiring (session-manager threads tierProfile into
//   cursor.spawn; coordinator routes solo+cursor to the cursor provider)
//   and that no cursor chat is left unsandboxed under strict mode.
//
// The per-chat isolation comes from the user-tier session-manager refactor
// keying sessions by `(alias, provider, chat_id)` — so two chats on the
// same alias spawn two separate cursor agents = two Agent.create calls
// = two snapshots.
//
// The harness `recordCursorSpawnOptions` hook (added in Task 11) captures
// the options object passed to every `Agent.create()` / `Agent.resume()`
// call. Cursor has no cheap-eval path, so all Agent.create invocations
// reflect a real per-chat spawn.
import { afterEach, describe, expect, it } from 'vitest'
import { startTestDaemon, type DaemonHandle } from './harness'

interface CursorSpawnRecord {
  enabled: boolean
  cwd?: string
}

function asCursorSpawnRecord(opts: Record<string, unknown>): CursorSpawnRecord {
  const local = (opts.local ?? {}) as Record<string, unknown>
  const sandboxOptions = (local.sandboxOptions ?? {}) as Record<string, unknown>
  return {
    enabled: Boolean(sandboxOptions.enabled),
    ...(typeof local.cwd === 'string' ? { cwd: local.cwd } : {}),
  }
}

describe('e2e: user-tier permissions (cursor)', () => {
  let daemon: DaemonHandle | null = null
  let prevCursorApiKey: string | undefined

  afterEach(async () => {
    if (daemon) {
      await daemon.stop()
      daemon = null
    }
    if (prevCursorApiKey === undefined) delete process.env.CURSOR_API_KEY
    else process.env.CURSOR_API_KEY = prevCursorApiKey
  })

  it('strict mode sandboxes every cursor tier at Agent.create', async () => {
    // CURSOR_API_KEY must be present at boot — bootstrap reads it
    // synchronously to decide whether to register the cursor provider.
    // (The harness has no `env` option, so we mutate process.env directly
    // and restore in afterEach.)
    prevCursorApiKey = process.env.CURSOR_API_KEY
    process.env.CURSOR_API_KEY = 'test-cursor-key'

    const spawns: CursorSpawnRecord[] = []
    daemon = await startTestDaemon({
      // dangerously=false so resolveTier honors access.json rather than
      // forcing everyone to admin tier.
      dangerously: false,
      access: {
        allowFrom: ['admin_chat', 'guest_chat'],
        admins: ['admin_chat'],
      },
      knownUsers: { admin_chat: 'admin_user', guest_chat: 'guest_user' },
      // cursorModel required — bootstrap refuses to register cursor without it.
      agentConfig: { provider: 'cursor', cursorModel: 'composer-2' },
      // Pin both chats to solo+cursor so the coordinator routes them
      // through the cursor provider's spawn path (not claude or codex).
      modes: {
        admin_chat: { kind: 'solo', provider: 'cursor' },
        guest_chat: { kind: 'solo', provider: 'cursor' },
      },
      cursorScript: {
        async onDispatch(_text) {
          // Empty body — we only need the spawn to happen. The recorder
          // fires inside Agent.create before any onDispatch logic runs.
          return { toolCalls: [], finalText: 'ok' }
        },
      },
      recordCursorSpawnOptions: opts => {
        spawns.push(asCursorSpawnRecord(opts))
      },
    })

    // Send from admin first, wait for dispatch to finish, then from guest.
    // Sequencing avoids races over the shared recorder array.
    daemon.sendText('admin_chat', 'hi from admin')
    await daemon.waitForReplyTo('admin_chat', 8000)

    daemon.sendText('guest_chat', 'hi from guest')
    await daemon.waitForReplyTo('guest_chat', 8000)

    // Two spawns — one per chatId. Session keying is
    // (alias, provider, chat_id), so two chats on the same alias produce
    // two distinct sessions = two Agent.create calls.
    expect(spawns.length).toBe(2)

    // Post-RFC-05, cursor sandbox no longer varies by tier in strict mode:
    // the only knob is sandbox on/off and there's no canUseTool relay, so
    // the safe default is "sandboxed unless --dangerously". Both admin and
    // guest therefore spawn with sandboxOptions.enabled=true. The
    // security-relevant guarantee held here: no cursor chat runs unsandboxed
    // under strict mode. (admin sent first ⇒ spawns[0]=admin, spawns[1]=guest.)
    expect(spawns.map(s => s.enabled)).toEqual([true, true])
  })
})
