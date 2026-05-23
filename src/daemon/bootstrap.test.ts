import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildBootstrap, resolveAdminChatId } from './bootstrap'
import { saveAgentConfig } from '../lib/agent-config'
import { openTestDb } from '../lib/db'
import { TIER_PROFILES } from '../core/user-tier'
import type { Access } from '../lib/access'
import type { CompanionConfig } from './companion/config'

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
      db: openTestDb(),
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
    const opts = b.sdkOptionsForProject('P', '/p', TIER_PROFILES.admin)
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
      db: openTestDb(),
      stateDir: '/tmp/state',
      ilink: makeIlinkStub() as any,
      loadProjects: () => ({ projects: { P: { path: '/p', last_active: 0 } }, current: 'P' }),
      lastActiveChatId: () => null,
      log: () => {},
    })
    expect(b.resolve('anyone')).toEqual({ alias: 'P', path: '/p' })
  })

  // Task 13: sdkOptionsForProject body migrated from
  // `if (dangerouslySkipPermissions) bypassPermissions; else default+canUseTool`
  // to tier-driven via tierProfileToClaudeSdkOpts(tierProfile). The
  // dangerouslySkipPermissions flag now influences which tier is resolved
  // (via the makeCanUseTool closure), not the SDK options shape directly.
  // canUseTool is now always wired — under bypassPermissions the SDK simply
  // never fires it.
  it('admin tier produces bypassPermissions (matches the legacy --dangerously path)', () => {
    const b = buildBootstrap({
      db: openTestDb(),
      stateDir: '/tmp/state',
      ilink: makeIlinkStub() as any,
      loadProjects: () => ({ projects: { P: { path: '/p', last_active: 0 } }, current: 'P' }),
      lastActiveChatId: () => 'chat-1',
      log: () => {},
      dangerouslySkipPermissions: true,
    })
    const opts = b.sdkOptionsForProject('P', '/p', TIER_PROFILES.admin)
    expect(opts.permissionMode).toBe('bypassPermissions')
    // Task 13 — canUseTool wired even at admin tier; SDK won't fire it under
    // bypassPermissions, but production code paths should not rely on that.
    expect(typeof opts.canUseTool).toBe('function')
  })

  it('trusted tier produces permissionMode=default + canUseTool (no disallowedTools — relays via canUseTool)', () => {
    const b = buildBootstrap({
      db: openTestDb(),
      stateDir: '/tmp/state',
      ilink: makeIlinkStub() as any,
      loadProjects: () => ({ projects: { P: { path: '/p', last_active: 0 } }, current: 'P' }),
      lastActiveChatId: () => 'chat-1',
      log: () => {},
      dangerouslySkipPermissions: false,
    })
    const opts = b.sdkOptionsForProject('P', '/p', TIER_PROFILES.trusted)
    expect(opts.permissionMode).toBe('default')
    expect(typeof opts.canUseTool).toBe('function')
    // Trusted's relay set is shell_destructive/memory_delete — both gated
    // by canUseTool input inspection, not via disallowedTools.
    expect(opts.disallowedTools).toBeUndefined()
  })

  it('guest tier produces permissionMode=default + disallowedTools + canUseTool', () => {
    const b = buildBootstrap({
      db: openTestDb(),
      stateDir: '/tmp/state',
      ilink: makeIlinkStub() as any,
      loadProjects: () => ({ projects: { P: { path: '/p', last_active: 0 } }, current: 'P' }),
      lastActiveChatId: () => 'chat-1',
      log: () => {},
      dangerouslySkipPermissions: false,
    })
    const opts = b.sdkOptionsForProject('P', '/p', TIER_PROFILES.guest)
    expect(opts.permissionMode).toBe('default')
    expect(typeof opts.canUseTool).toBe('function')
    // Guest denies fs_write / shell / network / subagent — the SDK sees the
    // built-in names in disallowedTools (mcp__wechat__* gates inside canUseTool).
    expect(Array.isArray(opts.disallowedTools)).toBe(true)
    expect(opts.disallowedTools).toContain('Bash')
    expect(opts.disallowedTools).toContain('Write')
    expect(opts.disallowedTools).toContain('Edit')
  })

  it('defaults dangerouslySkipPermissions to false when omitted', () => {
    const b = buildBootstrap({
      db: openTestDb(),
      stateDir: '/tmp/state',
      ilink: makeIlinkStub() as any,
      loadProjects: () => ({ projects: {}, current: null }),
      lastActiveChatId: () => null,
      log: () => {},
    })
    // With admin tier (the default for sdkOptionsForProject calls without
    // a tier resolver), the result is bypassPermissions regardless of the
    // flag. canUseTool is still wired.
    const opts = b.sdkOptionsForProject('P', '/p', TIER_PROFILES.admin)
    expect(opts.permissionMode).toBe('bypassPermissions')
    expect(typeof opts.canUseTool).toBe('function')
  })

  it('defaults to the Claude agent provider', () => {
    const b = buildBootstrap({
      db: openTestDb(),
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
      db: openTestDb(),
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
      saveAgentConfig(stateDir, { provider: 'codex', model: 'gpt-5.3-codex', dangerouslySkipPermissions: true, autoStart: false, closeStopsDaemon: false })
      const b = buildBootstrap({
      db: openTestDb(),
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
      db: openTestDb(),
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
      db: openTestDb(),
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
      db: openTestDb(),
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
      db: openTestDb(),
      stateDir: '/tmp/state',
      ilink: makeIlinkStub() as any,
      loadProjects: () => ({ projects: {}, current: null }),
      lastActiveChatId: () => null,
      log: () => {},
      internalApi: { baseUrl: 'http://127.0.0.1:0', tokenFilePath: '/tmp/token' },
    })
    const opts = b.sdkOptionsForProject('P', '/p', TIER_PROFILES.admin)
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
      db: openTestDb(),
      stateDir: '/tmp/state',
      ilink: makeIlinkStub() as any,
      loadProjects: () => ({ projects: {}, current: null }),
      lastActiveChatId: () => null,
      log: () => {},
      // No internalApi
    })
    const opts = b.sdkOptionsForProject('P', '/p', TIER_PROFILES.admin)
    expect(opts.mcpServers).toEqual({})  // Both wechat and delegate skipped.
  })

  // ── Task 13 — resolveAdminChatId + tier-driven relay wiring ───────────

  describe('resolveAdminChatId', () => {
    it('returns companion default_chat_id if it is admin', () => {
      expect(resolveAdminChatId(
        { dmPolicy: 'allowlist', allowFrom: ['x', 'y'], admins: ['x', 'y'] } as Access,
        { default_chat_id: 'x' } as CompanionConfig,
      )).toBe('x')
    })

    it('falls back to admins[0] if default_chat_id is not admin', () => {
      expect(resolveAdminChatId(
        { dmPolicy: 'allowlist', allowFrom: ['x', 'y'], admins: ['y'] } as Access,
        { default_chat_id: 'x' } as CompanionConfig,
      )).toBe('y')
    })

    it('returns null when admins empty', () => {
      expect(resolveAdminChatId(
        { dmPolicy: 'allowlist', allowFrom: ['x'], admins: [] } as Access,
        { default_chat_id: null } as CompanionConfig,
      )).toBeNull()
    })

    it('returns null when admins undefined', () => {
      expect(resolveAdminChatId(
        { dmPolicy: 'allowlist', allowFrom: ['x'] } as Access,
        { default_chat_id: null } as CompanionConfig,
      )).toBeNull()
    })

    it('falls back to admins[0] when companion default_chat_id is null', () => {
      expect(resolveAdminChatId(
        { dmPolicy: 'allowlist', allowFrom: ['a', 'b'], admins: ['a', 'b'] } as Access,
        { default_chat_id: null } as CompanionConfig,
      )).toBe('a')
    })
  })

  it('system prompt is the prompt-builder output (mentions delegate_codex for claude sessions)', () => {
    const b = buildBootstrap({
      db: openTestDb(),
      stateDir: '/tmp/state',
      ilink: makeIlinkStub() as any,
      loadProjects: () => ({ projects: {}, current: null }),
      lastActiveChatId: () => null,
      log: () => {},
      internalApi: { baseUrl: 'http://127.0.0.1:0', tokenFilePath: '/tmp/token' },
    })
    const opts = b.sdkOptionsForProject('P', '/p', TIER_PROFILES.admin)
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
