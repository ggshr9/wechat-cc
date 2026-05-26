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
  it('sdkOptionsForProject returns cwd, wechat stdio mcpServer, canUseTool, systemPrompt', async () => {
    const b = await buildBootstrap({
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
    const opts = b.sdkOptionsForProject('P', '/p', TIER_PROFILES.admin, '_test')
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

  it('resolve uses projects.current', async () => {
    const b = await buildBootstrap({
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
  it('admin tier produces bypassPermissions (matches the legacy --dangerously path)', async () => {
    const b = await buildBootstrap({
      db: openTestDb(),
      stateDir: '/tmp/state',
      ilink: makeIlinkStub() as any,
      loadProjects: () => ({ projects: { P: { path: '/p', last_active: 0 } }, current: 'P' }),
      lastActiveChatId: () => 'chat-1',
      log: () => {},
      dangerouslySkipPermissions: true,
    })
    const opts = b.sdkOptionsForProject('P', '/p', TIER_PROFILES.admin, '_test')
    expect(opts.permissionMode).toBe('bypassPermissions')
    // Task 13 — canUseTool wired even at admin tier; SDK won't fire it under
    // bypassPermissions, but production code paths should not rely on that.
    expect(typeof opts.canUseTool).toBe('function')
  })

  it('trusted tier produces permissionMode=default + canUseTool (no disallowedTools — relays via canUseTool)', async () => {
    const b = await buildBootstrap({
      db: openTestDb(),
      stateDir: '/tmp/state',
      ilink: makeIlinkStub() as any,
      loadProjects: () => ({ projects: { P: { path: '/p', last_active: 0 } }, current: 'P' }),
      lastActiveChatId: () => 'chat-1',
      log: () => {},
      dangerouslySkipPermissions: false,
    })
    const opts = b.sdkOptionsForProject('P', '/p', TIER_PROFILES.trusted, '_test')
    expect(opts.permissionMode).toBe('default')
    expect(typeof opts.canUseTool).toBe('function')
    // Trusted's relay set is shell_destructive/memory_delete — both gated
    // by canUseTool input inspection, not via disallowedTools.
    expect(opts.disallowedTools).toBeUndefined()
  })

  it('guest tier produces permissionMode=default + disallowedTools + canUseTool', async () => {
    const b = await buildBootstrap({
      db: openTestDb(),
      stateDir: '/tmp/state',
      ilink: makeIlinkStub() as any,
      loadProjects: () => ({ projects: { P: { path: '/p', last_active: 0 } }, current: 'P' }),
      lastActiveChatId: () => 'chat-1',
      log: () => {},
      dangerouslySkipPermissions: false,
    })
    const opts = b.sdkOptionsForProject('P', '/p', TIER_PROFILES.guest, '_test')
    expect(opts.permissionMode).toBe('default')
    expect(typeof opts.canUseTool).toBe('function')
    // Guest denies fs_write / shell / network / subagent — the SDK sees the
    // built-in names in disallowedTools (mcp__wechat__* gates inside canUseTool).
    expect(Array.isArray(opts.disallowedTools)).toBe(true)
    expect(opts.disallowedTools).toContain('Bash')
    expect(opts.disallowedTools).toContain('Write')
    expect(opts.disallowedTools).toContain('Edit')
  })

  it('defaults dangerouslySkipPermissions to false when omitted (strict mode → default+canUseTool)', async () => {
    const b = await buildBootstrap({
      db: openTestDb(),
      stateDir: '/tmp/state',
      ilink: makeIlinkStub() as any,
      loadProjects: () => ({ projects: {}, current: null }),
      lastActiveChatId: () => null,
      log: () => {},
    })
    // RFC 05: when daemon was NOT launched --dangerously, sdkOptionsForProject
    // returns `default + canUseTool` regardless of tier — destructive ops
    // get gated via the relay inside canUseTool, not by SDK-level bypass.
    const opts = b.sdkOptionsForProject('P', '/p', TIER_PROFILES.admin, '_test')
    expect(opts.permissionMode).toBe('default')
    expect(typeof opts.canUseTool).toBe('function')
  })

  it('defaults to the Claude agent provider', async () => {
    const b = await buildBootstrap({
      db: openTestDb(),
      stateDir: '/tmp/state',
      ilink: makeIlinkStub() as any,
      loadProjects: () => ({ projects: {}, current: null }),
      lastActiveChatId: () => null,
      log: () => {},
    })
    expect(b.agentProviderKind).toBe('claude')
  })

  it('can select the Codex agent provider explicitly', async () => {
    const b = await buildBootstrap({
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

  it('reads provider selection from agent-config.json', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'wechat-bootstrap-'))
    try {
      saveAgentConfig(stateDir, { provider: 'codex', model: 'gpt-5.3-codex', dangerouslySkipPermissions: true, autoStart: false, closeStopsDaemon: false })
      const b = await buildBootstrap({
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

  it('registers BOTH claude and codex providers regardless of default (RFC 03 P2)', async () => {
    const b = await buildBootstrap({
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
    // Cursor only registers when CURSOR_API_KEY is set + @cursor/sdk
    // imports; in this test env CURSOR_API_KEY is unset so the list
    // remains ['claude', 'codex'].
    expect(b.registry.list().sort()).toEqual(['claude', 'codex'])
    expect(b.registry.has('claude')).toBe(true)
    expect(b.registry.has('codex')).toBe(true)
  })

  // Cursor registration is gated on CURSOR_API_KEY + the @cursor/sdk
  // dynamic import succeeding. Both must hold; either missing → silent
  // skip with [BOOT] log entry. See bootstrap/index.ts cursor block.
  it('registers cursor provider when CURSOR_API_KEY is set + cursorModel configured + @cursor/sdk available', async () => {
    const prevKey = process.env.CURSOR_API_KEY
    process.env.CURSOR_API_KEY = 'test-cursor-key'
    const stateDir = mkdtempSync(join(tmpdir(), 'bootstrap-cursor-'))
    saveAgentConfig(stateDir, {
      provider: 'cursor',
      cursorModel: 'composer-2',
      dangerouslySkipPermissions: false,
      autoStart: false,
      closeStopsDaemon: false,
    })
    try {
      const b = await buildBootstrap({
        db: openTestDb(),
        stateDir,
        ilink: makeIlinkStub() as any,
        loadProjects: () => ({ projects: {}, current: null }),
        lastActiveChatId: () => null,
        log: () => {},
      })
      expect(b.registry.list()).toContain('cursor')
      expect(b.registry.has('cursor')).toBe(true)
    } finally {
      if (prevKey === undefined) delete process.env.CURSOR_API_KEY
      else process.env.CURSOR_API_KEY = prevKey
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('does NOT register cursor when CURSOR_API_KEY is set but cursorModel is missing — Cursor SDK requires model for local agents', async () => {
    const prevKey = process.env.CURSOR_API_KEY
    process.env.CURSOR_API_KEY = 'test-cursor-key'
    const logEntries: Array<{ tag: string; line: string }> = []
    try {
      const b = await buildBootstrap({
        db: openTestDb(),
        stateDir: '/tmp/state',  // no agent-config.json → cursorModel undefined
        ilink: makeIlinkStub() as any,
        loadProjects: () => ({ projects: {}, current: null }),
        lastActiveChatId: () => null,
        log: (tag, line) => { logEntries.push({ tag, line }) },
      })
      expect(b.registry.list()).not.toContain('cursor')
      const boot = logEntries.filter(e => e.tag === 'BOOT' && e.line.includes('cursor'))
      expect(boot.some(e => e.line.includes('cursorModel is not configured'))).toBe(true)
    } finally {
      if (prevKey === undefined) delete process.env.CURSOR_API_KEY
      else process.env.CURSOR_API_KEY = prevKey
    }
  })

  it('skips cursor registration when CURSOR_API_KEY is unset', async () => {
    const prevKey = process.env.CURSOR_API_KEY
    delete process.env.CURSOR_API_KEY
    try {
      const b = await buildBootstrap({
        db: openTestDb(),
        stateDir: '/tmp/state',
        ilink: makeIlinkStub() as any,
        loadProjects: () => ({ projects: {}, current: null }),
        lastActiveChatId: () => null,
        log: () => {},
      })
      expect(b.registry.list()).not.toContain('cursor')
    } finally {
      if (prevKey !== undefined) process.env.CURSOR_API_KEY = prevKey
    }
  })

  it('exposes the conversation coordinator and dispatchDelegate', async () => {
    const b = await buildBootstrap({
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

  it('default mode for any chat is solo + agentProviderKind', async () => {
    const b = await buildBootstrap({
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

  it('sdkOptionsForProject wires BOTH wechat AND delegate stdio servers (RFC 03 P4)', async () => {
    const b = await buildBootstrap({
      db: openTestDb(),
      stateDir: '/tmp/state',
      ilink: makeIlinkStub() as any,
      loadProjects: () => ({ projects: {}, current: null }),
      lastActiveChatId: () => null,
      log: () => {},
      internalApi: { baseUrl: 'http://127.0.0.1:0', tokenFilePath: '/tmp/token' },
    })
    const opts = b.sdkOptionsForProject('P', '/p', TIER_PROFILES.admin, '_test')
    expect(opts.mcpServers!['wechat']).toBeDefined()
    expect(opts.mcpServers!['delegate']).toBeDefined()
    // Delegate child env declares peer=codex (since this is the claude session config).
    const delegate = opts.mcpServers!['delegate'] as { type: string; env?: Record<string, string> }
    expect(delegate.env?.WECHAT_DELEGATE_PEER).toBe('codex')
    expect(delegate.env?.WECHAT_INTERNAL_API).toBe('http://127.0.0.1:0')
    expect(delegate.env?.WECHAT_INTERNAL_TOKEN_FILE).toBe('/tmp/token')
  })

  it('omits stdio mcpServers entirely when internalApi is not wired (no leaks)', async () => {
    const b = await buildBootstrap({
      db: openTestDb(),
      stateDir: '/tmp/state',
      ilink: makeIlinkStub() as any,
      loadProjects: () => ({ projects: {}, current: null }),
      lastActiveChatId: () => null,
      log: () => {},
      // No internalApi
    })
    const opts = b.sdkOptionsForProject('P', '/p', TIER_PROFILES.admin, '_test')
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

    it('prefers the initiating chat when it is itself an admin (multi-admin)', () => {
      // Multi-admin install: prompt goes to whichever admin triggered the
      // tool call. Closes the "admins[1+] never see prompts" gap without
      // reintroducing the guest self-approval hole (only admins are
      // allowed to self-approve).
      const access = {
        dmPolicy: 'allowlist',
        allowFrom: ['admin-a', 'admin-b', 'admin-c'],
        admins: ['admin-a', 'admin-b', 'admin-c'],
      } as Access
      const companion = { default_chat_id: null } as CompanionConfig
      expect(resolveAdminChatId(access, companion, 'admin-b')).toBe('admin-b')
      expect(resolveAdminChatId(access, companion, 'admin-c')).toBe('admin-c')
    })

    it('routes non-admin initiator to default_chat_id / admins[0]', () => {
      // Guest/trusted initiating chat MUST NOT self-approve. Falls
      // through to companion.default_chat_id (if admin) or admins[0].
      const access = {
        dmPolicy: 'allowlist',
        allowFrom: ['guest-x', 'admin-a', 'admin-b'],
        admins: ['admin-a', 'admin-b'],
      } as Access
      expect(resolveAdminChatId(
        access,
        { default_chat_id: 'admin-b' } as CompanionConfig,
        'guest-x',
      )).toBe('admin-b')
      expect(resolveAdminChatId(
        access,
        { default_chat_id: null } as CompanionConfig,
        'guest-x',
      )).toBe('admin-a')
    })
  })

  it('system prompt is the prompt-builder output (mentions delegate_codex for claude sessions)', async () => {
    const b = await buildBootstrap({
      db: openTestDb(),
      stateDir: '/tmp/state',
      ilink: makeIlinkStub() as any,
      loadProjects: () => ({ projects: {}, current: null }),
      lastActiveChatId: () => null,
      log: () => {},
      internalApi: { baseUrl: 'http://127.0.0.1:0', tokenFilePath: '/tmp/token' },
    })
    const opts = b.sdkOptionsForProject('P', '/p', TIER_PROFILES.admin, '_test')
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

  // ── Per-session canUseTool (concurrent-dispatch tier hazard) ─────────
  //
  // Before this fix, the canUseTool closure was built ONCE at bootstrap
  // and read `deps.lastActiveChatId()` per call — a process-wide ref
  // updated by mw-capture-ctx on every inbound. Under concurrent
  // dispatch (chat A mid-turn while chat B sends an inbound), the
  // lastActiveChatId could flip to B's id between when A initiated a
  // tool call and when canUseTool fired — cross-resolving A's tier as
  // B's. The fix threads chatId through sdkOptionsForProject so each
  // spawn builds its own canUseTool with chatId baked in.
  //
  // We can't easily exercise the SDK's canUseTool callback without a
  // full Options-execution harness, so the test verifies closure
  // identity + invokes the canUseTool functions directly.
  it('per-session canUseTool: each chatId gets its own closure (no shared identity)', async () => {
    const b = await buildBootstrap({
      db: openTestDb(),
      stateDir: '/tmp/state',
      ilink: makeIlinkStub() as any,
      loadProjects: () => ({ projects: { P: { path: '/p', last_active: 0 } }, current: 'P' }),
      lastActiveChatId: () => null,
      log: () => {},
      dangerouslySkipPermissions: false,
    })

    const optsA = b.sdkOptionsForProject('P', '/p', TIER_PROFILES.admin, 'chatA')
    const optsB = b.sdkOptionsForProject('P', '/p', TIER_PROFILES.guest, 'chatB')

    // Each spawn gets its OWN canUseTool — not the same instance. Pre-fix
    // it was a single bootstrap-time closure shared across all sessions;
    // post-fix sdkOptionsForProject builds one per call so the chatId
    // bound into resolveTier/mode is per-session.
    expect(optsA.canUseTool).toBeDefined()
    expect(optsB.canUseTool).toBeDefined()
    expect(optsA.canUseTool).not.toBe(optsB.canUseTool)
  })

  it('per-session canUseTool: guest chatId resolves guest tier even when lastActiveChatId flips to admin', async () => {
    // The hazard scenario, demonstrated:
    //   1. Daemon spawns canUseTool for chatB (guest)
    //   2. Process-wide lastActiveChatId flips to chatA (admin) — happens
    //      whenever any inbound arrives on chatA mid-turn
    //   3. chatB's canUseTool fires; pre-fix it would read
    //      lastActiveChatId → chatA → resolve as admin → would have
    //      auto-allowed a destructive tool the guest matrix forbids
    //
    // Post-fix the chatId is baked in at spawn time, so step 3 still
    // sees chatB and resolves guest tier (Bash → deny per TIER_PROFILES.guest.deny).
    let lastActive: string | null = 'chatB'
    const b = await buildBootstrap({
      db: openTestDb(),
      stateDir: '/tmp/state',
      ilink: makeIlinkStub() as any,
      loadProjects: () => ({ projects: { P: { path: '/p', last_active: 0 } }, current: 'P' }),
      lastActiveChatId: () => lastActive,
      log: () => {},
      dangerouslySkipPermissions: false,
    })

    const optsB = b.sdkOptionsForProject('P', '/p', TIER_PROFILES.guest, 'chatB')

    // Simulate the race: chatA's inbound flips lastActiveChatId mid-turn.
    lastActive = 'chatA'

    const ctl = new AbortController()
    const result = await optsB.canUseTool!('Bash', { command: 'rm -rf /' }, {
      signal: ctl.signal,
      suggestions: [],
      toolUseID: 't1',
    } as any)

    // The only way result.behavior could be 'allow' here is if chatB's
    // closure read lastActiveChatId (= chatA) and resolved admin instead
    // of being bound to its own chatId. The deny proves the binding holds.
    expect(result.behavior).toBe('deny')
  })
})
