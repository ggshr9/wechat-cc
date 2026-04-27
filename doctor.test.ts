import { describe, expect, it } from 'vitest'
import { analyzeDoctor, setupStatus, serviceStatus } from './doctor'

describe('doctor installer JSON', () => {
  it('reports ready=false with concrete next actions on a fresh machine', () => {
    const report = analyzeDoctor({
      stateDir: '/state',
      findOnPath: () => null,
      readAccounts: () => [],
      readAccess: () => ({ dmPolicy: 'allowlist', allowFrom: [] }),
      readAgentConfig: () => ({ provider: 'claude', dangerouslySkipPermissions: true }),
      daemon: () => ({ alive: false, pid: null }),
    })

    expect(report.ready).toBe(false)
    expect(report.checks.bun.ok).toBe(false)
    expect(report.checks.accounts.ok).toBe(false)
    expect(report.nextActions).toContain('install_bun')
    expect(report.nextActions).toContain('run_wechat_setup')
  })

  it('is ready when deps, account, access, provider, and daemon are healthy', () => {
    const report = analyzeDoctor({
      stateDir: '/state',
      findOnPath: (cmd) => `/bin/${cmd}`,
      readAccounts: () => [{ id: 'bot-1', botId: 'bot-1', userId: 'u1', baseUrl: 'https://ilink' }],
      readAccess: () => ({ dmPolicy: 'allowlist', allowFrom: ['u1'] }),
      readAgentConfig: () => ({ provider: 'codex', model: 'gpt-5.3-codex', dangerouslySkipPermissions: true }),
      daemon: () => ({ alive: true, pid: 123 }),
    })

    expect(report.ready).toBe(true)
    expect(report.checks.provider.provider).toBe('codex')
    expect(report.checks.provider.ok).toBe(true)
    expect(report.nextActions).toEqual([])
  })

  it('setupStatus exposes only binding/provider/service facts for the installer flow', () => {
    const status = setupStatus({
      stateDir: '/state',
      readAccounts: () => [{ id: 'bot-1', botId: 'bot-1', userId: 'u1', baseUrl: 'https://ilink' }],
      readAccess: () => ({ dmPolicy: 'allowlist', allowFrom: ['u1'] }),
      readAgentConfig: () => ({ provider: 'claude', dangerouslySkipPermissions: true }),
      daemon: () => ({ alive: false, pid: null }),
    })

    expect(status.bound).toBe(true)
    expect(status.provider).toBe('claude')
    expect(status.daemon.alive).toBe(false)
  })

  it('serviceStatus reports stale pid files distinctly', () => {
    expect(serviceStatus({ daemon: () => ({ alive: false, pid: 999 }) })).toEqual({
      installed: false,
      alive: false,
      pid: 999,
      state: 'stale',
    })
  })
})
