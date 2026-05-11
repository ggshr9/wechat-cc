#!/usr/bin/env bun
/**
 * Manual-acceptance harness for the P0/P1/P1.5/P1.6 changes on the
 * fix/p0-auth-fail-detection-and-idle-reset branch. Runs four end-to-end
 * shims:
 *
 *   #1 claude provider intercepts "Please run /login" sentinel and the
 *      coordinator's fallback-reply path is suppressed (raw text never
 *      reaches sendAssistantText)
 *   #2 coordinator calls sessionManager.release on auth_failed so the
 *      next dispatch self-heals
 *   #3 /reset and /health ai admin commands fire against the real
 *      bootstrap wiring
 *   #4 bootstrap refuses to register codex when CLI --version mismatches
 *      the bundled SDK's expected version (this is live on the host:
 *      installed codex is 0.125, SDK expects 0.128)
 *
 * Run: bun scripts/acceptance-p0p1.ts
 *
 * Cleans up its temp state dir on exit. Does not touch the production
 * daemon at PID 97989 or its state at ~/.claude/channels/wechat.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import { buildBootstrap } from '../src/daemon/bootstrap'
import { openTestDb } from '../src/lib/db'
import { makeAdminCommands } from '../src/daemon/admin-commands'
import { isAdmin } from '../src/lib/access'

function makeIlinkStub() {
  return {
    sendMessage: vi.fn().mockResolvedValue({ msgId: 'stub' }),
    sendFile: vi.fn(),
    editMessage: vi.fn(),
    broadcast: vi.fn(),
    sharePage: vi.fn().mockResolvedValue({ url: '', slug: '' }),
    resurfacePage: vi.fn(),
    setUserName: vi.fn(),
    sendTyping: vi.fn(),
    sessionState: { listExpired: () => [], markExpired: () => true, clear: () => {}, isExpired: () => false } as never,
    markChatActive: vi.fn(),
    captureContextToken: vi.fn(),
    handlePermissionReply: vi.fn(),
    resolveUserName: () => undefined,
    projects: { list: () => [], switchTo: vi.fn(), add: vi.fn(), remove: vi.fn() },
    companion: {
      enable: vi.fn(), disable: vi.fn(),
      status: () => ({ enabled: false, timezone: 'Asia/Shanghai', per_project_persona: {}, personas_available: [], triggers: [], snooze_until: null, pushes_last_24h: 0, runs_last_24h: 0 }),
      snooze: vi.fn(), personaSwitch: vi.fn(), triggerAdd: vi.fn(), triggerRemove: vi.fn(), triggerPause: vi.fn(),
    },
    askUser: vi.fn(),
  }
}

function header(s: string) {
  console.log(`\n${'='.repeat(60)}\n${s}\n${'='.repeat(60)}`)
}
function pass(s: string) { console.log(`✅ ${s}`) }
function fail(s: string, detail?: unknown) {
  console.log(`❌ ${s}`)
  if (detail !== undefined) console.log(`   ${JSON.stringify(detail).slice(0, 300)}`)
  process.exitCode = 1
}

const stateDir = mkdtempSync(join(tmpdir(), 'wechat-cc-acceptance-'))
const cleanup: Array<() => void | Promise<void>> = [() => rmSync(stateDir, { recursive: true, force: true })]
process.on('exit', () => { for (const c of cleanup) try { Promise.resolve(c()).catch(() => {}) } catch {} })

;(async () => {
  const logs: Array<{ tag: string; line: string; fields?: Record<string, unknown> }> = []
  const log = (tag: string, line: string, fields?: Record<string, unknown>) => {
    logs.push({ tag, line, ...(fields ? { fields } : {}) })
  }
  const ilink = makeIlinkStub() as never

  header('Booting an isolated daemon')
  const db = openTestDb()
  cleanup.push(() => db.close())
  const boot = buildBootstrap({
    db,
    stateDir,
    ilink,
    loadProjects: () => ({ projects: { P: { path: process.cwd(), last_active: 0 } }, current: 'P' }),
    lastActiveChatId: () => null,
    log,
    dangerouslySkipPermissions: true,
  })
  console.log(`(state dir: ${stateDir})`)

  // ───────────────────────────────────────────────────────────────
  // #4 codex version mismatch refusal at boot
  // ───────────────────────────────────────────────────────────────
  header('#4 codex CLI version mismatch — boot refuses to register')
  const bootLines = logs.filter(l => l.tag === 'BOOT')
  console.log(bootLines.map(l => `  [BOOT] ${l.line}`).join('\n'))
  const refusal = bootLines.find(l => l.line.includes('codex provider NOT registered'))
  if (refusal && /actual=0\.125\.0/.test(refusal.line) && /expected=0\.128\.0/.test(refusal.line)) {
    pass('boot log includes loud "codex provider NOT registered" with both versions')
  } else if (refusal) {
    fail('codex refusal logged but actual/expected versions missing', refusal.line)
  } else {
    fail('boot log does NOT include a codex refusal — either codex was registered (false-accept) or no codex found', bootLines.map(l => l.line))
  }
  const codexRegistered = boot.registry.has('codex')
  if (!codexRegistered) pass('boot.registry does NOT contain codex provider (consistent with refusal)')
  else fail('boot.registry DOES contain codex even though version mismatched (regression)')

  // ───────────────────────────────────────────────────────────────
  // #1 + #2 claude auth-fail sentinel intercepted, session auto-released
  // ───────────────────────────────────────────────────────────────
  header('#1 + #2 auth_failed: no leakage + auto release + throttled notice')
  // We don't have a live broken claude here, so we go through the
  // coordinator with a stubbed acquire that returns a session whose
  // dispatch emits the structured auth_failed event (exactly what the
  // real claude provider's interceptor produces under the hood).
  const sendAssistantText = vi.fn(async (_chatId: string, _text: string) => {})
  const releaseSpy = vi.fn(async () => {})
  const fakeAcquire = vi.fn(async (alias: string, _path: string, providerId: string) => {
    return {
      alias, path: '/p', providerId, lastUsedAt: Date.now(),
      async *dispatch() {
        yield { kind: 'error' as const, code: 'auth_failed', message: 'claude reports not logged in: Not logged in · Please run /login' }
        yield { kind: 'result' as const, sessionId: 'sid', numTurns: 1, durationMs: 0 }
      },
      close: async () => {},
    }
  })
  // Re-use the real coordinator construction by shimming the deps.
  const { createConversationCoordinator } = await import('../src/core/conversation-coordinator')
  const coord = createConversationCoordinator({
    resolveProject: () => ({ alias: 'P', path: process.cwd() }),
    manager: { acquire: fakeAcquire, release: releaseSpy },
    conversationStore: { get: () => null, set: () => {} } as never,
    registry: boot.registry,
    defaultProviderId: 'claude',
    format: () => 'inbound text',
    sendAssistantText,
    permissionMode: 'dangerously',
    log,
  })

  await coord.dispatch({ chatId: 'demo-chat', userId: 'demo-chat', text: 'hi', msgType: 'text', createTimeMs: Date.now(), accountId: 'acct' })

  // ── #1 verifications
  const sentTexts = sendAssistantText.mock.calls.map(c => c[1] as string)
  if (sentTexts.length === 1) pass('exactly one outbound message after auth_failed (throttled)')
  else fail(`expected 1 outbound, got ${sentTexts.length}`, sentTexts)
  const leak = sentTexts.find(t => /Please run \/login|Not logged in/.test(t))
  if (!leak) pass('the raw "Not logged in / Please run /login" string did NOT leak to sendAssistantText')
  else fail('LEAK: raw auth-fail text reached the wechat reply path', leak)
  const userFacing = sentTexts[0] ?? ''
  if (/AI.*不可用|wechat-cc/i.test(userFacing)) pass(`user-facing notice is the neutral one: ${JSON.stringify(userFacing.slice(0, 80))}`)
  else fail('user-facing notice text does not match the neutral one', userFacing)

  // ── #2 verifications
  if (releaseSpy.mock.calls.length >= 1) pass(`sessionManager.release was called (${releaseSpy.mock.calls.length}×) — busy chats self-heal on next dispatch`)
  else fail('sessionManager.release was NOT called on auth_failed — busy chats would stay broken')
  const authFailedLog = logs.find(l => l.tag === 'AUTH_FAILED')
  if (authFailedLog) pass(`structured [AUTH_FAILED] log emitted: ${authFailedLog.line.slice(0, 100)}`)
  else fail('no [AUTH_FAILED] log line found')

  // ── #1.5 verify throttle: second auth_failed within the window stays silent
  await coord.dispatch({ chatId: 'demo-chat', userId: 'demo-chat', text: 'still broken?', msgType: 'text', createTimeMs: Date.now(), accountId: 'acct' })
  if (sendAssistantText.mock.calls.length === 1) pass('second auth_failed in the throttle window stayed silent (no spam)')
  else fail(`throttle leaked: ${sendAssistantText.mock.calls.length} outbound after two dispatches`)
  if (releaseSpy.mock.calls.length === 2) pass('release still fires per turn (each new dispatch tries to start clean)')
  else fail(`expected 2 release calls, got ${releaseSpy.mock.calls.length}`)

  // ───────────────────────────────────────────────────────────────
  // #3 admin /reset and /health ai against real bootstrap deps
  // ───────────────────────────────────────────────────────────────
  header('#3 admin commands /reset and /health ai (wired against real bootstrap)')
  const adminSends: Array<[string, string]> = []
  const admin = makeAdminCommands({
    stateDir,
    isAdmin: () => true,
    sessionState: ilink.sessionState,
    pollHandle: { stopAccount: () => {}, running: () => [] },
    resolveUserName: () => undefined,
    sendMessage: async (cid, text) => { adminSends.push([cid, text]); return { msgId: 'm' } },
    log,
    startedAt: new Date().toISOString(),
    resolveProject: boot.resolve,
    registry: boot.registry,
    sessionManager: boot.sessionManager,
    sessionStore: boot.sessionStore,
  })

  // Seed a stored session for the chat so /health ai has something to render.
  boot.sessionStore.set('P', 'sid-test', 'claude')

  // /health ai
  await admin.handle({ chatId: 'admin', userId: 'admin', text: '/health ai', msgType: 'text', createTimeMs: Date.now(), accountId: 'acct' })
  const healthOut = adminSends.find(([, t]) => t.includes('AI 会话状态'))
  if (healthOut && healthOut[1].includes('claude')) pass(`/health ai renders: ${JSON.stringify(healthOut[1].slice(0, 120))}`)
  else fail('/health ai output missing or malformed', adminSends)

  // /reset
  adminSends.length = 0
  await admin.handle({ chatId: 'admin', userId: 'admin', text: '/reset', msgType: 'text', createTimeMs: Date.now(), accountId: 'acct' })
  const resetOut = adminSends.find(([, t]) => /已重置|重置/.test(t))
  if (resetOut) pass(`/reset confirms: ${JSON.stringify(resetOut[1].slice(0, 120))}`)
  else fail('/reset did not send confirmation', adminSends)
  // sessionStore should now be empty for that alias
  const afterReset = boot.sessionStore.get('P', 'claude')
  if (afterReset === null) pass('sessionStore row for the chat was cleared by /reset')
  else fail('sessionStore still has a row after /reset', afterReset)

  // /重置 alias
  adminSends.length = 0
  boot.sessionStore.set('P', 'sid-test2', 'claude')
  await admin.handle({ chatId: 'admin', userId: 'admin', text: '/重置', msgType: 'text', createTimeMs: Date.now(), accountId: 'acct' })
  if (boot.sessionStore.get('P', 'claude') === null) pass('/重置 (Chinese alias) also clears sessionStore')
  else fail('/重置 did not clear the sessionStore row')

  console.log('\n' + (process.exitCode ? '✗ some checks failed' : '✓ all acceptance checks passed'))
})().catch(err => {
  console.error('acceptance harness threw:', err)
  process.exitCode = 1
})
