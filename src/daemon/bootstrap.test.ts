import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildBootstrap } from './bootstrap'
import { saveAgentConfig } from '../lib/agent-config'

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

describe('bootstrap', () => {
  it('sdkOptionsForProject returns cwd, wechat stdio mcpServer, canUseTool, systemPrompt', () => {
    const b = buildBootstrap({
      stateDir: '/tmp/state',
      ilink: makeIlinkStub() as any,
      loadProjects: () => ({ projects: { P: { path: '/p', last_active: 0 } }, current: 'P' }),
      lastActiveChatId: () => 'chat-1',
      log: () => {},
      // After RFC 03 P1.B B1, wechat MCP is exclusively the stdio server
      // wired via internalApi. Without internalApi the daemon would never
      // expose any wechat tools — that's not a real production code path.
      internalApi: { baseUrl: 'http://127.0.0.1:0', tokenFilePath: '/tmp/token' },
    })
    const opts = b.sdkOptionsForProject('P', '/p')
    expect(opts.cwd).toBe('/p')
    expect(opts.mcpServers).toBeDefined()
    const wechatCfg = opts.mcpServers!['wechat']
    expect(wechatCfg).toBeDefined()
    // Stdio MCP server (renamed from wechat_ipc back to wechat in B1
    // when the legacy in-process server was deleted).
    expect(wechatCfg!.type).toBe('stdio')
    expect(typeof opts.canUseTool).toBe('function')
    // systemPrompt is now the preset+append form (we switched from raw string
    // to avoid SDK ToolSearch deferring MCP tools). Accept string OR preset object.
    const sp = opts.systemPrompt
    const ok = typeof sp === 'string'
      || Array.isArray(sp)
      || (typeof sp === 'object' && sp !== null && (sp as { type?: string }).type === 'preset')
    expect(ok).toBe(true)
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

  it('defaults to the Claude agent provider', () => {
    const b = buildBootstrap({
      stateDir: '/tmp/state',
      ilink: makeIlinkStub() as any,
      loadProjects: () => ({ projects: {}, current: null }),
      lastActiveChatId: () => null,
      log: () => {},
    })
    expect(b.agentProviderKind).toBe('claude')
  })

  it('can select the Codex agent provider explicitly', () => {
    const b = buildBootstrap({
      stateDir: '/tmp/state',
      ilink: makeIlinkStub() as any,
      loadProjects: () => ({ projects: {}, current: null }),
      lastActiveChatId: () => null,
      log: () => {},
      agentProviderKind: 'codex',
    })
    expect(b.agentProviderKind).toBe('codex')
  })

  it('reads provider selection from agent-config.json', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'wechat-bootstrap-'))
    try {
      saveAgentConfig(stateDir, { provider: 'codex', model: 'gpt-5.3-codex', dangerouslySkipPermissions: true, autoStart: false })
      const b = buildBootstrap({
        stateDir,
        ilink: makeIlinkStub() as any,
        loadProjects: () => ({ projects: {}, current: null }),
        lastActiveChatId: () => null,
        log: () => {},
      })
      expect(b.agentProviderKind).toBe('codex')
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  // ── RFC 03 review #12 — registry / coordinator wiring coverage ────────

  it('registers BOTH claude and codex providers regardless of default (RFC 03 P2)', () => {
    const b = buildBootstrap({
      stateDir: '/tmp/state',
      ilink: makeIlinkStub() as any,
      loadProjects: () => ({ projects: {}, current: null }),
      lastActiveChatId: () => null,
      log: () => {},
      agentProviderKind: 'claude',
    })
    // P2 design: even when default is claude, codex is also registered
    // so /codex slash command works without daemon restart.
    expect(b.registry.list().sort()).toEqual(['claude', 'codex'])
    expect(b.registry.has('claude')).toBe(true)
    expect(b.registry.has('codex')).toBe(true)
  })

  it('exposes the conversation coordinator and dispatchDelegate', () => {
    const b = buildBootstrap({
      stateDir: '/tmp/state',
      ilink: makeIlinkStub() as any,
      loadProjects: () => ({ projects: {}, current: null }),
      lastActiveChatId: () => null,
      log: () => {},
    })
    expect(b.coordinator).toBeDefined()
    expect(typeof b.coordinator.dispatch).toBe('function')
    expect(typeof b.coordinator.getMode).toBe('function')
    expect(typeof b.coordinator.setMode).toBe('function')
    expect(typeof b.coordinator.cancel).toBe('function')
    // P4 — dispatchDelegate function present + accepts (peer, prompt, cwd?)
    expect(typeof b.dispatchDelegate).toBe('function')
    expect(b.dispatchDelegate.length).toBeGreaterThanOrEqual(2)
  })

  it('default mode for any chat is solo + agentProviderKind', () => {
    const b = buildBootstrap({
      stateDir: '/tmp/state',
      ilink: makeIlinkStub() as any,
      loadProjects: () => ({ projects: {}, current: null }),
      lastActiveChatId: () => null,
      log: () => {},
      agentProviderKind: 'codex',
    })
    expect(b.coordinator.getMode('any-new-chat')).toEqual({ kind: 'solo', provider: 'codex' })
  })

  it('sdkOptionsForProject wires BOTH wechat AND delegate stdio servers (RFC 03 P4)', () => {
    const b = buildBootstrap({
      stateDir: '/tmp/state',
      ilink: makeIlinkStub() as any,
      loadProjects: () => ({ projects: {}, current: null }),
      lastActiveChatId: () => null,
      log: () => {},
      internalApi: { baseUrl: 'http://127.0.0.1:0', tokenFilePath: '/tmp/token' },
    })
    const opts = b.sdkOptionsForProject('P', '/p')
    expect(opts.mcpServers!['wechat']).toBeDefined()
    expect(opts.mcpServers!['delegate']).toBeDefined()
    // Delegate child env declares peer=codex (since this is the claude session config).
    const delegate = opts.mcpServers!['delegate'] as { type: string; env?: Record<string, string> }
    expect(delegate.env?.WECHAT_DELEGATE_PEER).toBe('codex')
    expect(delegate.env?.WECHAT_INTERNAL_API).toBe('http://127.0.0.1:0')
    expect(delegate.env?.WECHAT_INTERNAL_TOKEN_FILE).toBe('/tmp/token')
  })

  it('omits stdio mcpServers entirely when internalApi is not wired (no leaks)', () => {
    const b = buildBootstrap({
      stateDir: '/tmp/state',
      ilink: makeIlinkStub() as any,
      loadProjects: () => ({ projects: {}, current: null }),
      lastActiveChatId: () => null,
      log: () => {},
      // No internalApi
    })
    const opts = b.sdkOptionsForProject('P', '/p')
    expect(opts.mcpServers).toEqual({})  // Both wechat and delegate skipped.
  })

  it('system prompt is the prompt-builder output (mentions delegate_codex for claude sessions)', () => {
    const b = buildBootstrap({
      stateDir: '/tmp/state',
      ilink: makeIlinkStub() as any,
      loadProjects: () => ({ projects: {}, current: null }),
      lastActiveChatId: () => null,
      log: () => {},
      internalApi: { baseUrl: 'http://127.0.0.1:0', tokenFilePath: '/tmp/token' },
    })
    const opts = b.sdkOptionsForProject('P', '/p')
    const sp = opts.systemPrompt as { type: 'preset'; preset: string; append?: string } | string
    if (typeof sp === 'string') throw new Error('expected preset+append form')
    expect(sp.type).toBe('preset')
    expect(sp.append).toBeDefined()
    // The big things the v0.x prompt missed — verify they're now in.
    expect(sp.append).toContain('delegate_codex')
    expect(sp.append).toContain('share_page')
    expect(sp.append).toContain('broadcast')
    expect(sp.append).toContain('chatroom_round')
  })
})
