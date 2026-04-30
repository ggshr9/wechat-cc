import { describe, expect, it } from 'vitest'
import { analyzeDoctor, setupStatus, serviceStatus } from './doctor'

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
      readAgentConfig: () => ({ provider: 'claude', dangerouslySkipPermissions: true, autoStart: false }),
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
      readAgentConfig: () => ({ provider: 'codex', dangerouslySkipPermissions: true, autoStart: false }),
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
      readAgentConfig: () => ({ provider: 'claude', dangerouslySkipPermissions: true, autoStart: false }),
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

  it('is ready when deps, account, access, provider, daemon, AND service are healthy', () => {
    const report = analyzeDoctor({
      stateDir: '/state',
      findOnPath: (cmd) => `/bin/${cmd}`,
      readAccounts: () => [{ id: 'bot-1', botId: 'bot-1', userId: 'u1', baseUrl: 'https://ilink' }],
      readAccess: () => ({ dmPolicy: 'allowlist', allowFrom: ['u1'] }),
      readAgentConfig: () => ({ provider: 'codex', model: 'gpt-5.3-codex', dangerouslySkipPermissions: true, autoStart: false }),
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
      readAgentConfig: () => ({ provider: 'claude', dangerouslySkipPermissions: true, autoStart: false }),
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
      readAgentConfig: () => ({ provider: 'claude', dangerouslySkipPermissions: true, autoStart: false }),
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
})
