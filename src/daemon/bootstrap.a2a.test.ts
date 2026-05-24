/**
 * Bootstrap A2A integration tests — verify that A2A server wiring
 * in buildBootstrap behaves correctly based on a2a_listen config.
 *
 * These tests are focused on the A2A subset of bootstrap:
 *   - a2aServer is null when a2a_listen is not configured
 *   - a2aServer starts and /.well-known/agent.json is reachable when configured
 *   - a2aDeps are always present (for outbound /v1/a2a/send even without listener)
 */
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildBootstrap } from './bootstrap'
import { openTestDb } from '../lib/db'

function makeIlinkStub() {
  return {
    sendMessage: vi.fn().mockResolvedValue({ msgId: 'msg-1' }),
    sendFile: vi.fn(),
    editMessage: vi.fn(),
    broadcast: vi.fn(),
    sharePage: vi.fn(),
    resurfacePage: vi.fn(),
    setUserName: vi.fn(),
    projects: { list: () => [], switchTo: vi.fn(), add: vi.fn(), remove: vi.fn() },
    companion: {
      enable: vi.fn(),
      disable: vi.fn(),
      status: () => ({
        enabled: false,
        timezone: 'Asia/Shanghai',
        per_project_persona: {},
        personas_available: [],
        triggers: [],
        snooze_until: null,
        pushes_last_24h: 0,
        runs_last_24h: 0,
      }),
      snooze: vi.fn(),
      personaSwitch: vi.fn(),
      triggerAdd: vi.fn(),
      triggerRemove: vi.fn(),
      triggerPause: vi.fn(),
    },
    askUser: vi.fn(),
  }
}

describe('bootstrap A2A wiring', () => {
  it('a2aServer is null when a2a_listen is not configured', async () => {
    const boot = await buildBootstrap({
      db: openTestDb(),
      stateDir: '/tmp/state',
      ilink: makeIlinkStub() as any,
      loadProjects: () => ({ projects: {}, current: null }),
      lastActiveChatId: () => null,
      log: () => {},
    })
    expect(boot.a2aServer).toBeNull()
  })

  it('a2aDeps is always present (registry, client, recordEvent)', async () => {
    const boot = await buildBootstrap({
      db: openTestDb(),
      stateDir: '/tmp/state',
      ilink: makeIlinkStub() as any,
      loadProjects: () => ({ projects: {}, current: null }),
      lastActiveChatId: () => null,
      log: () => {},
    })
    expect(boot.a2aDeps).toBeDefined()
    expect(boot.a2aDeps.registry).toBeDefined()
    expect(boot.a2aDeps.client).toBeDefined()
    expect(typeof boot.a2aDeps.recordEvent).toBe('function')
  })

  it('a2aServer starts and /.well-known/agent.json is reachable when a2a_listen is configured', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'bootstrap-a2a-'))
    // Write agent-config.json with a2a_listen on a random port (port=0 not
    // supported by Bun.serve; use a fixed high ephemeral port for the test).
    // Pick a port in the dynamic range that's unlikely to collide.
    const port = 19876
    writeFileSync(
      join(stateDir, 'agent-config.json'),
      JSON.stringify({
        provider: 'claude',
        dangerouslySkipPermissions: false,
        autoStart: false,
        closeStopsDaemon: false,
        a2a_listen: { host: '127.0.0.1', port },
      }),
    )
    let boot: Awaited<ReturnType<typeof buildBootstrap>> | null = null
    try {
      boot = await buildBootstrap({
        db: openTestDb(),
        stateDir,
        ilink: makeIlinkStub() as any,
        loadProjects: () => ({ projects: {}, current: null }),
        lastActiveChatId: () => null,
        log: () => {},
      })
      expect(boot.a2aServer).not.toBeNull()
      const url = `http://127.0.0.1:${port}/.well-known/agent.json`
      const res = await fetch(url)
      expect(res.status).toBe(200)
      const card = await res.json() as { name: string; version: string }
      expect(card.name).toBe('wechat-cc')
      expect(typeof card.version).toBe('string')
    } finally {
      await boot?.a2aServer?.stop()
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('writes a2a-info.json with enabled=true + base_url when server starts', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'wechat-cc-a2a-test-'))
    const port = 19887
    writeFileSync(
      join(stateDir, 'agent-config.json'),
      JSON.stringify({
        provider: 'claude',
        dangerouslySkipPermissions: false,
        autoStart: false,
        closeStopsDaemon: false,
        a2a_listen: { host: '127.0.0.1', port },
      }),
    )
    let boot: Awaited<ReturnType<typeof buildBootstrap>> | null = null
    try {
      boot = await buildBootstrap({
        db: openTestDb(),
        stateDir,
        ilink: makeIlinkStub() as any,
        loadProjects: () => ({ projects: {}, current: null }),
        lastActiveChatId: () => null,
        log: () => {},
      })
      const { readFileSync } = await import('node:fs')
      const info = JSON.parse(readFileSync(join(stateDir, 'a2a-info.json'), 'utf8'))
      expect(info.enabled).toBe(true)
      expect(info.base_url).toBe(`http://127.0.0.1:${port}`)
      expect(info.host).toBe('127.0.0.1')
      expect(info.port).toBe(port)
      expect(typeof info.pid).toBe('number')
    } finally {
      await boot?.a2aServer?.stop()
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('writes a2a-info.json with enabled=false when a2a_listen unset', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'wechat-cc-a2a-test-'))
    writeFileSync(
      join(stateDir, 'agent-config.json'),
      JSON.stringify({
        provider: 'claude',
        dangerouslySkipPermissions: false,
        autoStart: false,
        closeStopsDaemon: false,
      }),
    )
    let boot: Awaited<ReturnType<typeof buildBootstrap>> | null = null
    try {
      boot = await buildBootstrap({
        db: openTestDb(),
        stateDir,
        ilink: makeIlinkStub() as any,
        loadProjects: () => ({ projects: {}, current: null }),
        lastActiveChatId: () => null,
        log: () => {},
      })
      const { readFileSync } = await import('node:fs')
      const info = JSON.parse(readFileSync(join(stateDir, 'a2a-info.json'), 'utf8'))
      expect(info.enabled).toBe(false)
      expect(info.base_url).toBeNull()
      expect(info.host).toBeNull()
      expect(info.port).toBeNull()
    } finally {
      await boot?.a2aServer?.stop()
      rmSync(stateDir, { recursive: true, force: true })
    }
  })
})
