import { describe, it, expect, vi } from 'vitest'
import { buildBootstrap } from './bootstrap'

function makeIlinkStub() {
  return {
    sendMessage: vi.fn(),
    sendFile: vi.fn(),
    editMessage: vi.fn(),
    broadcast: vi.fn(),
    sharePage: vi.fn(),
    resurfacePage: vi.fn(),
    setUserName: vi.fn(),
    projects: { list: () => [], switchTo: vi.fn(), add: vi.fn(), remove: vi.fn() },
    askUser: vi.fn(),
  }
}

describe('bootstrap', () => {
  it('sdkOptionsForProject returns cwd, wechat mcpServer, canUseTool, systemPrompt', () => {
    const b = buildBootstrap({
      stateDir: '/tmp/state',
      ilink: makeIlinkStub() as any,
      loadProjects: () => ({ projects: { P: { path: '/p', last_active: 0 } }, current: 'P' }),
      lastActiveChatId: () => 'chat-1',
      log: () => {},
    })
    const opts = b.sdkOptionsForProject('P', '/p')
    expect(opts.cwd).toBe('/p')
    expect(opts.mcpServers).toBeDefined()
    const wechatCfg = opts.mcpServers!['wechat']
    expect(wechatCfg).toBeDefined()
    expect(wechatCfg!.type).toBe('sdk')
    expect(typeof opts.canUseTool).toBe('function')
    expect(typeof opts.systemPrompt === 'string' || Array.isArray(opts.systemPrompt)).toBe(true)
  })

  it('resolve uses projects.current', () => {
    const b = buildBootstrap({
      stateDir: '/tmp/state',
      ilink: makeIlinkStub() as any,
      loadProjects: () => ({ projects: { P: { path: '/p', last_active: 0 } }, current: 'P' }),
      lastActiveChatId: () => null,
      log: () => {},
    })
    expect(b.resolve('anyone')).toEqual({ alias: 'P', path: '/p' })
  })

  it('with dangerouslySkipPermissions=true, sdkOptionsForProject uses bypassPermissions and no canUseTool', () => {
    const b = buildBootstrap({
      stateDir: '/tmp/state',
      ilink: makeIlinkStub() as any,
      loadProjects: () => ({ projects: { P: { path: '/p', last_active: 0 } }, current: 'P' }),
      lastActiveChatId: () => 'chat-1',
      log: () => {},
      dangerouslySkipPermissions: true,
    })
    const opts = b.sdkOptionsForProject('P', '/p')
    expect(opts.permissionMode).toBe('bypassPermissions')
    expect(opts.canUseTool).toBeUndefined()
  })

  it('with dangerouslySkipPermissions=false, sdkOptionsForProject keeps Phase 1 default + canUseTool', () => {
    const b = buildBootstrap({
      stateDir: '/tmp/state',
      ilink: makeIlinkStub() as any,
      loadProjects: () => ({ projects: { P: { path: '/p', last_active: 0 } }, current: 'P' }),
      lastActiveChatId: () => 'chat-1',
      log: () => {},
      dangerouslySkipPermissions: false,
    })
    const opts = b.sdkOptionsForProject('P', '/p')
    expect(opts.permissionMode).toBe('default')
    expect(typeof opts.canUseTool).toBe('function')
  })

  it('defaults dangerouslySkipPermissions to false when omitted', () => {
    const b = buildBootstrap({
      stateDir: '/tmp/state',
      ilink: makeIlinkStub() as any,
      loadProjects: () => ({ projects: {}, current: null }),
      lastActiveChatId: () => null,
      log: () => {},
    })
    const opts = b.sdkOptionsForProject('P', '/p')
    expect(opts.permissionMode).toBe('default')
    expect(typeof opts.canUseTool).toBe('function')
  })
})
