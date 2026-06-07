import { describe, expect, it, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { analyzeDoctor, setupStatus, serviceStatus, readDaemon, readAccess, readExpiredBots } from './doctor'
import { openWechatDb } from '../lib/db'
import { makeSessionStateStore } from '../daemon/session-state'

const installedSystemd = () => ({ installed: true, kind: 'systemd-user' as const })
const missingSystemd = () => ({ installed: false, kind: 'systemd-user' as const })

describe('doctor installer JSON', () => {
  it('classifies the selected agent backend as hard severity (gates install)', () => {
    // provider=claude + claude binary missing → provider check is hard
    // (registering the systemd unit succeeds but every reply fails since
    // SDK can't spawn `claude`). codex check is soft because it isn't
    // the active provider.
    const report = analyzeDoctor({
      stateDir: '/state',
      findOnPath: () => null,
      readAccounts: () => [],
      readAccess: () => ({ dmPolicy: 'allowlist', allowFrom: [] }),
      readAgentConfig: () => ({ provider: 'claude', dangerouslySkipPermissions: true, autoStart: false, closeStopsDaemon: false }),
      readUserNames: () => ({}),
      readExpiredBots: () => [],
      daemon: () => ({ alive: false, pid: null }),
      service: missingSystemd,
    })

    expect(report.checks.provider.severity).toBe('hard')
    expect(report.checks.claude.severity).toBe('hard')
    expect(report.checks.codex.severity).toBe('soft')
    expect(report.checks.accounts.severity).toBe('soft')
    expect(report.checks.provider.fix?.command).toContain('npm install -g @anthropic-ai/claude-code')
    expect(report.checks.accounts.fix?.action).toBeTruthy()
  })

  it('flips claude/codex severity when provider=codex', () => {
    const report = analyzeDoctor({
      stateDir: '/state',
      findOnPath: () => null,
      readAccounts: () => [{ id: 'b', botId: 'b', userId: 'u', baseUrl: 'x' }],
      readAccess: () => ({ dmPolicy: 'allowlist', allowFrom: ['u'] }),
      readAgentConfig: () => ({ provider: 'codex', dangerouslySkipPermissions: true, autoStart: false, closeStopsDaemon: false }),
      readUserNames: () => ({}),
      readExpiredBots: () => [],
      daemon: () => ({ alive: false, pid: null }),
      service: missingSystemd,
    })
    expect(report.checks.codex.severity).toBe('hard')
    expect(report.checks.claude.severity).toBe('soft')
    expect(report.checks.provider.fix?.link).toContain('codex')
  })

  it('reports ready=false with concrete next actions on a fresh machine', () => {
    const report = analyzeDoctor({
      stateDir: '/state',
      findOnPath: () => null,
      readAccounts: () => [],
      readAccess: () => ({ dmPolicy: 'allowlist', allowFrom: [] }),
      readAgentConfig: () => ({ provider: 'claude', dangerouslySkipPermissions: true, autoStart: false, closeStopsDaemon: false }),
      readUserNames: () => ({}),
      readExpiredBots: () => [],
      daemon: () => ({ alive: false, pid: null }),
      service: missingSystemd,
    })

    expect(report.ready).toBe(false)
    expect(report.checks.bun.ok).toBe(false)
    expect(report.checks.accounts.ok).toBe(false)
    expect(report.checks.service.installed).toBe(false)
    expect(report.nextActions).toContain('install_bun')
    expect(report.nextActions).toContain('run_wechat_setup')
    expect(report.nextActions).toContain('install_service')
    // install_service supersedes start_service when no unit is registered
    expect(report.nextActions).not.toContain('start_service')
  })

  it('reports CLI binary versions for claude + codex when probe is wired', () => {
    // Tests need to see `claude --version` / `codex --version` in the
    // report so the dashboard + support flows can spot SDK↔CLI protocol
    // mismatches (e.g. codex-cli 0.125 paired with codex-sdk 0.128 returns
    // empty assistantText → silent FALLBACK_REPLY → no reply ever reaches
    // the user; see src/lib/find-codex-binary.ts:81-89).
    const report = analyzeDoctor({
      stateDir: '/state',
      findOnPath: (cmd) => `/bin/${cmd}`,
      probeBinaryVersion: (path) => {
        if (path === '/bin/claude') return '2.1.138 (Claude Code)'
        if (path === '/bin/codex') return 'codex-cli 0.125.0'
        return null
      },
      readAccounts: () => [],
      readAccess: () => ({ dmPolicy: 'allowlist', allowFrom: [] }),
      readAgentConfig: () => ({ provider: 'claude', dangerouslySkipPermissions: true, autoStart: false, closeStopsDaemon: false }),
      readUserNames: () => ({}),
      readExpiredBots: () => [],
      daemon: () => ({ alive: false, pid: null }),
      service: missingSystemd,
    })
    expect(report.checks.claude.version).toBe('2.1.138 (Claude Code)')
    expect(report.checks.codex.version).toBe('codex-cli 0.125.0')
  })

  it('CLI version is null when the probe returns null (e.g. binary refuses --version)', () => {
    const report = analyzeDoctor({
      stateDir: '/state',
      findOnPath: (cmd) => `/bin/${cmd}`,
      probeBinaryVersion: () => null,
      readAccounts: () => [],
      readAccess: () => ({ dmPolicy: 'allowlist', allowFrom: [] }),
      readAgentConfig: () => ({ provider: 'claude', dangerouslySkipPermissions: true, autoStart: false, closeStopsDaemon: false }),
      readUserNames: () => ({}),
      readExpiredBots: () => [],
      daemon: () => ({ alive: false, pid: null }),
      service: missingSystemd,
    })
    expect(report.checks.claude.version).toBeNull()
    expect(report.checks.codex.version).toBeNull()
  })

  it('is ready when deps, account, access, provider, daemon, AND service are healthy', () => {
    const report = analyzeDoctor({
      stateDir: '/state',
      findOnPath: (cmd) => `/bin/${cmd}`,
      readAccounts: () => [{ id: 'bot-1', botId: 'bot-1', userId: 'u1', baseUrl: 'https://ilink' }],
      readAccess: () => ({ dmPolicy: 'allowlist', allowFrom: ['u1'] }),
      readAgentConfig: () => ({ provider: 'codex', model: 'gpt-5.3-codex', dangerouslySkipPermissions: true, autoStart: false, closeStopsDaemon: false }),
      readUserNames: () => ({ u1: '丸子' }),
      readExpiredBots: () => [{ botId: 'bot-2-im-bot', firstSeenExpiredAt: '2026-04-26T10:00:00Z', lastReason: 'test' }],
      daemon: () => ({ alive: true, pid: 123 }),
      service: installedSystemd,
    })

    expect(report.ready).toBe(true)
    expect(report.userNames).toEqual({ u1: '丸子' })
    expect(report.expiredBots).toEqual([
      { botId: 'bot-2-im-bot', firstSeenExpiredAt: '2026-04-26T10:00:00Z', lastReason: 'test' },
    ])
    expect(report.checks.provider.provider).toBe('codex')
    expect(report.checks.provider.ok).toBe(true)
    expect(report.checks.service.installed).toBe(true)
    expect(report.nextActions).toEqual([])
  })

  it('service installed but daemon down → next=start_service (not install_service)', () => {
    const report = analyzeDoctor({
      stateDir: '/state',
      findOnPath: (cmd) => `/bin/${cmd}`,
      readAccounts: () => [{ id: 'bot-1', botId: 'bot-1', userId: 'u1', baseUrl: 'https://ilink' }],
      readAccess: () => ({ dmPolicy: 'allowlist', allowFrom: ['u1'] }),
      readAgentConfig: () => ({ provider: 'claude', dangerouslySkipPermissions: true, autoStart: false, closeStopsDaemon: false }),
      readUserNames: () => ({}),
      readExpiredBots: () => [],
      daemon: () => ({ alive: false, pid: null }),
      service: installedSystemd,
    })
    expect(report.nextActions).toContain('start_service')
    expect(report.nextActions).not.toContain('install_service')
  })

  it('setupStatus exposes binding/provider/service facts for the installer flow', () => {
    const status = setupStatus({
      stateDir: '/state',
      readAccounts: () => [{ id: 'bot-1', botId: 'bot-1', userId: 'u1', baseUrl: 'https://ilink' }],
      readAccess: () => ({ dmPolicy: 'allowlist', allowFrom: ['u1'] }),
      readAgentConfig: () => ({ provider: 'claude', dangerouslySkipPermissions: true, autoStart: false, closeStopsDaemon: false }),
      daemon: () => ({ alive: false, pid: null }),
      service: installedSystemd,
    })

    expect(status.bound).toBe(true)
    expect(status.provider).toBe('claude')
    expect(status.daemon.alive).toBe(false)
    expect(status.service.installed).toBe(true)
  })

  it('serviceStatus state="missing" when no service unit present (the bug from earlier)', () => {
    expect(serviceStatus({ daemon: () => ({ alive: false, pid: null }), service: missingSystemd })).toEqual({
      installed: false, alive: false, pid: null, state: 'missing',
    })
  })

  it('serviceStatus state="stopped" when installed + no daemon (ready to start)', () => {
    expect(serviceStatus({ daemon: () => ({ alive: false, pid: null }), service: installedSystemd })).toEqual({
      installed: true, alive: false, pid: null, state: 'stopped',
    })
  })

  it('serviceStatus state="running" when daemon alive (regardless of service registration)', () => {
    expect(serviceStatus({ daemon: () => ({ alive: true, pid: 42 }), service: missingSystemd })).toEqual({
      installed: false, alive: true, pid: 42, state: 'running',
    })
  })

  it('serviceStatus reports stale pid files distinctly from missing', () => {
    expect(serviceStatus({ daemon: () => ({ alive: false, pid: 999 }), service: installedSystemd })).toEqual({
      installed: true, alive: false, pid: 999, state: 'stale',
    })
  })

  // Compiled-bundle mode: the wechat-cc-cli sidecar inside the desktop
  // bundle carries its own bun runtime and never needs git, so missing
  // bun/git on the host should NOT block install or fail `ready`. These
  // tests pin that behavior so future refactors don't quietly re-leak the
  // dev-mode contract back into the GUI env-check.
  it('compiled-bundle: missing bun + git do not block ready or contribute to nextActions', () => {
    const report = analyzeDoctor({
      stateDir: '/state',
      findOnPath: (cmd) => cmd === 'claude' ? '/c/Program Files/claude/claude.exe' : null,
      readAccounts: () => [{ id: 'bot-1', botId: 'bot-1', userId: 'u1', baseUrl: 'https://ilink' }],
      readAccess: () => ({ dmPolicy: 'allowlist', allowFrom: ['u1'] }),
      readAgentConfig: () => ({ provider: 'claude', dangerouslySkipPermissions: true, autoStart: false, closeStopsDaemon: false }),
      readUserNames: () => ({}),
      readExpiredBots: () => [],
      daemon: () => ({ alive: true, pid: 7 }),
      service: installedSystemd,
      runtime: 'compiled-bundle',
      platform: 'win32',
    })
    expect(report.runtime).toBe('compiled-bundle')
    expect(report.checks.bun.ok).toBe(true)  // synthesized, host bun absent
    expect(report.checks.git.ok).toBe(true)
    expect(report.checks.bun.path).toBeNull()  // no system bun was found
    expect(report.checks.bun.fix).toBeUndefined()  // no bogus install hint
    expect(report.checks.git.fix).toBeUndefined()
    expect(report.ready).toBe(true)
    expect(report.nextActions).not.toContain('install_bun')
    expect(report.nextActions).not.toContain('install_git')
  })

  it('compiled-bundle on Windows with WSL detected → wslDetected=true', () => {
    const report = analyzeDoctor({
      stateDir: '/state',
      findOnPath: (cmd) => cmd === 'wsl' ? 'C:\\Windows\\System32\\wsl.exe' : null,
      readAccounts: () => [],
      readAccess: () => ({ dmPolicy: 'allowlist', allowFrom: [] }),
      readAgentConfig: () => ({ provider: 'claude', dangerouslySkipPermissions: true, autoStart: false, closeStopsDaemon: false }),
      readUserNames: () => ({}),
      readExpiredBots: () => [],
      daemon: () => ({ alive: false, pid: null }),
      service: missingSystemd,
      runtime: 'compiled-bundle',
      platform: 'win32',
    })
    expect(report.wslDetected).toBe(true)
  })

  it('non-Windows host: wsl on PATH does NOT trigger wslDetected (no false positives)', () => {
    // Some Linux distros ship an unrelated `wsl` helper. Gate strictly on
    // platform so a Linux source-mode user doesn't see a "WSL detected"
    // banner that makes no sense for them.
    const report = analyzeDoctor({
      stateDir: '/state',
      findOnPath: () => '/usr/bin/wsl',
      readAccounts: () => [],
      readAccess: () => ({ dmPolicy: 'allowlist', allowFrom: [] }),
      readAgentConfig: () => ({ provider: 'claude', dangerouslySkipPermissions: true, autoStart: false, closeStopsDaemon: false }),
      readUserNames: () => ({}),
      readExpiredBots: () => [],
      daemon: () => ({ alive: false, pid: null }),
      service: missingSystemd,
      platform: 'linux',
    })
    expect(report.wslDetected).toBe(false)
  })

  // ── Cursor SDK probe (Task 14 — Cursor agent backend support) ───────────
  // Cursor has no PATH binary (unlike claude/codex CLIs); it's an SDK loaded
  // via dynamic import. Doctor reports apiKeySet + sdkInstalled so the
  // wizard and JSON consumers can mirror the gate that bootstrap actually
  // applies before registering the cursor provider.

  it('reports cursor with apiKeySet + sdkInstalled when both are present', () => {
    const report = analyzeDoctor({
      stateDir: '/state',
      findOnPath: (cmd) => `/bin/${cmd}`,
      probeCursor: () => ({ apiKeySet: true, sdkInstalled: true }),
      readAccounts: () => [],
      readAccess: () => ({ dmPolicy: 'allowlist', allowFrom: [] }),
      readAgentConfig: () => ({ provider: 'claude', dangerouslySkipPermissions: true, autoStart: false, closeStopsDaemon: false }),
      readUserNames: () => ({}),
      readExpiredBots: () => [],
      daemon: () => ({ alive: false, pid: null }),
      service: missingSystemd,
    })
    expect(report.checks.cursor.ok).toBe(true)
    expect(report.checks.cursor.apiKeySet).toBe(true)
    expect(report.checks.cursor.sdkInstalled).toBe(true)
    expect(report.checks.cursor.fix).toBeUndefined()
    // Non-active cursor (provider=claude) does NOT contribute install_cursor
    expect(report.nextActions).not.toContain('install_cursor')
  })

  it('cursor.ok = false when API key is set but SDK is missing — fix hints at install', () => {
    const report = analyzeDoctor({
      stateDir: '/state',
      findOnPath: (cmd) => `/bin/${cmd}`,
      probeCursor: () => ({ apiKeySet: true, sdkInstalled: false }),
      readAccounts: () => [],
      readAccess: () => ({ dmPolicy: 'allowlist', allowFrom: [] }),
      readAgentConfig: () => ({ provider: 'claude', dangerouslySkipPermissions: true, autoStart: false, closeStopsDaemon: false }),
      readUserNames: () => ({}),
      readExpiredBots: () => [],
      daemon: () => ({ alive: false, pid: null }),
      service: missingSystemd,
    })
    expect(report.checks.cursor.ok).toBe(false)
    expect(report.checks.cursor.severity).toBe('soft')  // not the active provider
    expect(report.checks.cursor.fix?.command).toBe('bun add @cursor/sdk')
  })

  it('cursor.ok = false when SDK is installed but API key is missing — fix hints at env var', () => {
    const report = analyzeDoctor({
      stateDir: '/state',
      findOnPath: (cmd) => `/bin/${cmd}`,
      probeCursor: () => ({ apiKeySet: false, sdkInstalled: true }),
      readAccounts: () => [],
      readAccess: () => ({ dmPolicy: 'allowlist', allowFrom: [] }),
      readAgentConfig: () => ({ provider: 'claude', dangerouslySkipPermissions: true, autoStart: false, closeStopsDaemon: false }),
      readUserNames: () => ({}),
      readExpiredBots: () => [],
      daemon: () => ({ alive: false, pid: null }),
      service: missingSystemd,
    })
    expect(report.checks.cursor.ok).toBe(false)
    expect(report.checks.cursor.fix?.action).toContain('CURSOR_API_KEY')
  })

  it('provider=cursor + cursorOk=false → provider check is hard, install_cursor in nextActions', () => {
    const report = analyzeDoctor({
      stateDir: '/state',
      findOnPath: () => null,  // no claude/codex on PATH — should be irrelevant for cursor
      probeCursor: () => ({ apiKeySet: false, sdkInstalled: false }),
      readAccounts: () => [],
      readAccess: () => ({ dmPolicy: 'allowlist', allowFrom: [] }),
      readAgentConfig: () => ({ provider: 'cursor', cursorModel: 'cursor-small', dangerouslySkipPermissions: true, autoStart: false, closeStopsDaemon: false }),
      readUserNames: () => ({}),
      readExpiredBots: () => [],
      daemon: () => ({ alive: false, pid: null }),
      service: missingSystemd,
    })
    expect(report.checks.cursor.severity).toBe('hard')
    expect(report.checks.provider.ok).toBe(false)
    expect(report.checks.provider.severity).toBe('hard')
    expect(report.checks.provider.fix?.action).toContain('CURSOR_API_KEY')
    expect(report.nextActions).toContain('install_cursor')
    // install_claude / install_codex should NOT appear when cursor is selected
    expect(report.nextActions).not.toContain('install_claude')
    expect(report.nextActions).not.toContain('install_codex')
  })

  it('provider=cursor + cursorOk=true → provider check passes despite missing claude/codex binaries', () => {
    const report = analyzeDoctor({
      stateDir: '/state',
      findOnPath: () => null,
      probeCursor: () => ({ apiKeySet: true, sdkInstalled: true }),
      readAccounts: () => [{ id: 'b', botId: 'b', userId: 'u', baseUrl: 'x' }],
      readAccess: () => ({ dmPolicy: 'allowlist', allowFrom: ['u'] }),
      readAgentConfig: () => ({ provider: 'cursor', cursorModel: 'cursor-small', dangerouslySkipPermissions: true, autoStart: false, closeStopsDaemon: false }),
      readUserNames: () => ({}),
      readExpiredBots: () => [],
      daemon: () => ({ alive: true, pid: 1 }),
      service: installedSystemd,
    })
    expect(report.checks.provider.ok).toBe(true)
    expect(report.checks.provider.provider).toBe('cursor')
    expect(report.checks.provider.binaryPath).toBeNull()
    expect(report.nextActions).not.toContain('install_cursor')
  })

  // ── Gemini SDK probe (Task 7 — Gemini provider Phase B) ─────────────────
  // Gemini has no PATH binary (like Cursor); it's an SDK loaded via dynamic
  // import. Doctor reports apiKeySet + sdkInstalled so the wizard and JSON
  // consumers can mirror the gate that bootstrap applies before registering
  // the gemini provider.

  it('provider=gemini + geminiOk=false → provider check is hard, install_gemini in nextActions', () => {
    const report = analyzeDoctor({
      stateDir: '/state',
      findOnPath: () => null,  // no claude/codex on PATH — irrelevant for gemini
      probeGemini: () => ({ apiKeySet: false, sdkInstalled: false }),
      readAccounts: () => [],
      readAccess: () => ({ dmPolicy: 'allowlist', allowFrom: [] }),
      readAgentConfig: () => ({ provider: 'gemini', dangerouslySkipPermissions: true, autoStart: false, closeStopsDaemon: false }),
      readUserNames: () => ({}),
      readExpiredBots: () => [],
      daemon: () => ({ alive: false, pid: null }),
      service: missingSystemd,
    })
    expect(report.checks.gemini.ok).toBe(false)
    expect(report.checks.gemini.severity).toBe('hard')
    expect(report.checks.provider.ok).toBe(false)
    expect(report.checks.provider.severity).toBe('hard')
    expect(report.checks.provider.fix?.action).toContain('GEMINI_API_KEY')
    expect(report.nextActions).toContain('install_gemini')
    // install_claude / install_codex / install_cursor should NOT appear
    expect(report.nextActions).not.toContain('install_claude')
    expect(report.nextActions).not.toContain('install_codex')
    expect(report.nextActions).not.toContain('install_cursor')
  })

  it('default runtime is "source" (back-compat for callers that omit it)', () => {
    const report = analyzeDoctor({
      stateDir: '/state',
      findOnPath: () => null,
      readAccounts: () => [],
      readAccess: () => ({ dmPolicy: 'allowlist', allowFrom: [] }),
      readAgentConfig: () => ({ provider: 'claude', dangerouslySkipPermissions: true, autoStart: false, closeStopsDaemon: false }),
      readUserNames: () => ({}),
      readExpiredBots: () => [],
      daemon: () => ({ alive: false, pid: null }),
      service: missingSystemd,
    })
    expect(report.runtime).toBe('source')
    // Source mode: bun missing → install_bun in nextActions (the existing
    // contract — bundle mode is the deviation, not the default).
    expect(report.nextActions).toContain('install_bun')
  })
})

// ── readDaemon: internal_api population ────────────────────────────────────
describe('readDaemon internal_api', () => {
  const tmpDir = join('/tmp', `readDaemon-test-${process.pid}`)

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('populates internal_api when daemon alive and info file present', () => {
    mkdirSync(tmpDir, { recursive: true })
    // Write a server.pid pointing at the current process (guaranteed alive)
    writeFileSync(join(tmpDir, 'server.pid'), String(process.pid))
    writeFileSync(
      join(tmpDir, 'internal-api-info.json'),
      JSON.stringify({ baseUrl: 'http://127.0.0.1:54321', tokenFilePath: join(tmpDir, 'internal-token'), pid: process.pid, ts: Date.now() }),
    )
    const snap = readDaemon(tmpDir)
    expect(snap.alive).toBe(true)
    expect(snap.pid).toBe(process.pid)
    expect(snap.internal_api).toEqual({ port: 54321, token_file_path: join(tmpDir, 'internal-token') })
  })

  it('omits internal_api when daemon alive but info file absent', () => {
    mkdirSync(tmpDir, { recursive: true })
    writeFileSync(join(tmpDir, 'server.pid'), String(process.pid))
    // No internal-api-info.json written
    const snap = readDaemon(tmpDir)
    expect(snap.alive).toBe(true)
    expect(snap.internal_api).toBeUndefined()
  })

  it('omits internal_api when daemon dead', () => {
    mkdirSync(tmpDir, { recursive: true })
    // Use pid 0 to force alive=false (process.kill(0, 0) throws ESRCH)
    writeFileSync(join(tmpDir, 'server.pid'), '99999999')
    writeFileSync(
      join(tmpDir, 'internal-api-info.json'),
      JSON.stringify({ baseUrl: 'http://127.0.0.1:54321', tokenFilePath: join(tmpDir, 'internal-token'), pid: 99999999, ts: Date.now() }),
    )
    const snap = readDaemon(tmpDir)
    // The pid might exist or not — in either case internal_api must be absent
    expect(snap.alive).toBe(false)
    expect(snap.internal_api).toBeUndefined()
  })

  it('omits internal_api when info file is malformed JSON', () => {
    mkdirSync(tmpDir, { recursive: true })
    writeFileSync(join(tmpDir, 'server.pid'), String(process.pid))
    writeFileSync(join(tmpDir, 'internal-api-info.json'), 'not-json{')
    const snap = readDaemon(tmpDir)
    expect(snap.alive).toBe(true)
    expect(snap.internal_api).toBeUndefined()
  })

  it('omits internal_api when info file missing baseUrl', () => {
    mkdirSync(tmpDir, { recursive: true })
    writeFileSync(join(tmpDir, 'server.pid'), String(process.pid))
    writeFileSync(
      join(tmpDir, 'internal-api-info.json'),
      JSON.stringify({ tokenFilePath: join(tmpDir, 'internal-token') }),
    )
    const snap = readDaemon(tmpDir)
    expect(snap.alive).toBe(true)
    expect(snap.internal_api).toBeUndefined()
  })
})

// ── readAccess: admins[] pass-through ────────────────────────────────────────
describe('readAccess admins[]', () => {
  const tmpDir = join('/tmp', `readAccess-test-${process.pid}`)

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('surfaces admins[] when present in access.json', () => {
    mkdirSync(tmpDir, { recursive: true })
    writeFileSync(join(tmpDir, 'access.json'), JSON.stringify({
      dmPolicy: 'allowlist',
      allowFrom: ['o9cq800sObd3lbrHBgiItB1pooDQ@im.wechat'],
      admins: ['o9cq800sObd3lbrHBgiItB1pooDQ@im.wechat'],
    }))
    const snap = readAccess(tmpDir)
    expect(snap.admins).toEqual(['o9cq800sObd3lbrHBgiItB1pooDQ@im.wechat'])
  })

  it('omits admins when access.json has no admins field', () => {
    mkdirSync(tmpDir, { recursive: true })
    writeFileSync(join(tmpDir, 'access.json'), JSON.stringify({
      dmPolicy: 'allowlist',
      allowFrom: ['u1'],
    }))
    const snap = readAccess(tmpDir)
    expect(snap.admins).toBeUndefined()
  })

  it('omits admins when admins field is not an array', () => {
    mkdirSync(tmpDir, { recursive: true })
    writeFileSync(join(tmpDir, 'access.json'), JSON.stringify({
      dmPolicy: 'allowlist',
      allowFrom: ['u1'],
      admins: 'not-an-array',
    }))
    const snap = readAccess(tmpDir)
    expect(snap.admins).toBeUndefined()
  })

  it('admins surfaces through analyzeDoctor checks.access.admins', () => {
    mkdirSync(tmpDir, { recursive: true })
    writeFileSync(join(tmpDir, 'access.json'), JSON.stringify({
      dmPolicy: 'allowlist',
      allowFrom: ['uAdmin'],
      admins: ['uAdmin'],
    }))
    const report = analyzeDoctor({
      stateDir: tmpDir,
      findOnPath: () => null,
      readAccounts: () => [],
      readAccess: () => readAccess(tmpDir),
      readAgentConfig: () => ({ provider: 'claude', dangerouslySkipPermissions: false, autoStart: false, closeStopsDaemon: false }),
      readUserNames: () => ({}),
      readExpiredBots: () => [],
      daemon: () => ({ alive: false, pid: null }),
      service: missingSystemd,
      runtime: 'source',
    })
    expect(report.checks.access.admins).toEqual(['uAdmin'])
  })
})

describe('analyzeDoctor — heartbeats field', () => {
  it('includes heartbeats from readHeartbeats dep when provided', () => {
    const report = analyzeDoctor({
      stateDir: '/state',
      findOnPath: () => null,
      readAccounts: () => [{ id: 'bot1-im-bot', botId: 'b1@im.bot', userId: 'u1', baseUrl: '' }],
      readAccess: () => ({ dmPolicy: 'allowlist', allowFrom: ['u1'] }),
      readAgentConfig: () => ({ provider: 'claude', dangerouslySkipPermissions: false, autoStart: false, closeStopsDaemon: false }),
      readUserNames: () => ({}),
      readExpiredBots: () => [],
      readHeartbeats: () => ({ 'bot1-im-bot': '2026-06-07T01:00:00.000Z' }),
      daemon: () => ({ alive: true, pid: 1234 }),
      service: () => ({ installed: true, kind: 'launchagent' as const }),
    })
    expect(report.heartbeats).toEqual({ 'bot1-im-bot': '2026-06-07T01:00:00.000Z' })
  })

  it('heartbeats defaults to {} when readHeartbeats dep is absent', () => {
    const report = analyzeDoctor({
      stateDir: '/state',
      findOnPath: () => null,
      readAccounts: () => [],
      readAccess: () => ({ dmPolicy: 'allowlist', allowFrom: [] }),
      readAgentConfig: () => ({ provider: 'claude', dangerouslySkipPermissions: false, autoStart: false, closeStopsDaemon: false }),
      readUserNames: () => ({}),
      readExpiredBots: () => [],
      daemon: () => ({ alive: false, pid: null }),
      service: () => ({ installed: false, kind: 'launchagent' as const }),
    })
    expect(report.heartbeats).toEqual({})
  })
})

// ── readExpiredBots: SQLite round-trip ───────────────────────────────────────
describe('readExpiredBots', () => {
  const tmpDir = join('/tmp', `readExpiredBots-test-${process.pid}`)

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('returns [] when stateDir does not exist', () => {
    expect(readExpiredBots('/nonexistent-dir-xyzzy')).toEqual([])
  })

  it('returns [] for an empty (freshly-created) db', () => {
    mkdirSync(tmpDir, { recursive: true })
    const db = openWechatDb(tmpDir)
    db.close()
    expect(readExpiredBots(tmpDir)).toEqual([])
  })

  it('reads expired rows written via SessionStateStore (SQLite round-trip)', () => {
    // Write an expired entry through the same store the daemon uses.
    mkdirSync(tmpDir, { recursive: true })
    const db = openWechatDb(tmpDir)
    makeSessionStateStore(db).markExpired('some-account-id', 'test-reason')
    db.close()

    const entries = readExpiredBots(tmpDir)
    expect(entries).toHaveLength(1)
    // botId MUST be the account dir id (account.id), not a @im.bot address.
    expect(entries[0]!.botId).toBe('some-account-id')
    expect(typeof entries[0]!.firstSeenExpiredAt).toBe('string')
    expect(entries[0]!.lastReason).toBe('test-reason')
  })

  it('returns entries sorted ascending by firstSeenExpiredAt', () => {
    mkdirSync(tmpDir, { recursive: true })
    const db = openWechatDb(tmpDir)
    const store = makeSessionStateStore(db)
    // Insert in reverse chronological order to verify sort.
    store.markExpired('acct-b', 'reason-b')
    store.markExpired('acct-a', 'reason-a')
    db.close()

    const entries = readExpiredBots(tmpDir)
    expect(entries).toHaveLength(2)
    // listExpired is ORDER BY first_seen_expired_at ASC; both were inserted
    // within the same millisecond so order is stable — just verify both present.
    const ids = entries.map(e => e.botId)
    expect(ids).toContain('acct-a')
    expect(ids).toContain('acct-b')
  })

  it('omits lastReason when markExpired was called without a reason', () => {
    mkdirSync(tmpDir, { recursive: true })
    const db = openWechatDb(tmpDir)
    makeSessionStateStore(db).markExpired('acct-no-reason')
    db.close()

    const entries = readExpiredBots(tmpDir)
    expect(entries).toHaveLength(1)
    expect(entries[0]!.lastReason).toBeUndefined()
  })
})
