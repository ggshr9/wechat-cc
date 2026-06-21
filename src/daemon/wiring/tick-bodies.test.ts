import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildTickBodies, buildPushTickText, type TickDeps } from './tick-bodies'
import { TIER_PROFILES } from '../../core/user-tier'
import type { Access } from '../../lib/access'

describe('buildPushTickText', () => {
  it('formats a push tick envelope with the supplied nowIso + chatId + intention', () => {
    const out = buildPushTickText({
      nowIso: '2026-05-13T01:30:00.000Z',
      defaultChatId: 'chat_test_1',
      intention: '跟进健身计划进展',
    })
    expect(out).toContain('<companion_tick ts="2026-05-13T01:30:00.000Z" default_chat_id="chat_test_1" />')
    expect(out).toContain('有一条到点的跟进：「跟进健身计划进展」')
    expect(out).toContain('不调用 reply')
    expect(out).toContain('memory_read')
    expect(out).toContain('不算过期')
    expect(out).toContain('晚了几天也照常发')
  })
})

// Minimal pushTick test — verifies the PR D guard that companion ticks
// skip when the same (alias, providerId) session has an in-flight user
// dispatch. We mock only the surface tick-bodies touches.

function makeStateDir(cfg: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'tick-bodies-test-'))
  mkdirSync(join(dir, 'companion'), { recursive: true })
  writeFileSync(join(dir, 'companion', 'config.json'), JSON.stringify(cfg))
  return dir
}

interface Setup {
  stateDir: string
  acquire: ReturnType<typeof vi.fn>
  isInFlight: ReturnType<typeof vi.fn>
  dispatch: ReturnType<typeof vi.fn>
  logs: string[]
  deps: TickDeps
}

function setupDeps(opts: {
  defaultChatId: string | null
  inFlight: boolean
  /** Optional Access stub. Defaults to admin tier for the configured chatId
   * so existing PR D tests keep their original expectations. */
  access?: Access
  /** Optional agenda.md content written to memory/<chatId>/agenda.md so the
   * agenda gate passes. Without this the tick returns early (no due items). */
  agendaMd?: string
  /** Daemon-wide default provider (agent-config.provider). Defaults to claude. */
  defaultProviderId?: string
  /** The chat's persisted Mode, returned by coordinator.getMode. Defaults to
   * solo on defaultProviderId — i.e. the chat answers under the daemon default. */
  mode?: { kind: 'solo'; provider: string } | { kind: 'primary_tool'; primary: string } | { kind: 'parallel'; participants?: string[] } | { kind: 'chatroom'; participants?: string[] }
}): Setup {
  const stateDir = makeStateDir({
    enabled: true,
    ...(opts.defaultChatId ? { default_chat_id: opts.defaultChatId } : {}),
  })
  if (opts.agendaMd !== undefined && opts.defaultChatId) {
    const memDir = join(stateDir, 'memory', opts.defaultChatId)
    mkdirSync(memDir, { recursive: true })
    writeFileSync(join(memDir, 'agenda.md'), opts.agendaMd)
  }
  const logs: string[] = []
  // dispatch returns AsyncIterable<AgentEvent>, not a Promise — the real
  // contract. Mocking as `Promise<void>` would mask the bug that pushTick
  // was awaiting the iterable directly without iterating (PR D fix).
  const dispatch = vi.fn(() => ({
    async *[Symbol.asyncIterator]() { /* empty turn — no events */ },
  }))
  const acquire = vi.fn(async () => ({
    alias: 'a', path: '/p', providerId: 'claude', lastUsedAt: 0,
    dispatch, close: async () => {},
  }))
  const isInFlight = vi.fn(() => opts.inFlight)
  const defaultProviderId = opts.defaultProviderId ?? 'claude'
  const mode = opts.mode ?? { kind: 'solo' as const, provider: defaultProviderId }
  const getMode = vi.fn(() => mode)
  const defaultAccess: Access = {
    dmPolicy: 'allowlist',
    allowFrom: opts.defaultChatId ? [opts.defaultChatId] : [],
    ...(opts.defaultChatId ? { admins: [opts.defaultChatId] } : {}),
  }
  const access = opts.access ?? defaultAccess
  const deps: TickDeps = {
    stateDir,
    db: {} as never,
    ilink: {
      loadProjects: () => ({ projects: {}, current: null }),
    } as never,
    boot: {
      sessionManager: { acquire, isInFlight } as never,
      defaultProviderId: defaultProviderId as never,
      coordinator: { getMode } as never,
      // Default: no provider has cheapEval. Introspect-specific tests
      // override via deps.boot.registry directly.
      registry: { getCheapEval: () => null } as never,
    } as never,
    loadAccess: () => access,
    permissionMode: 'strict',
    log: (tag, line) => { logs.push(`${tag}|${line}`) },
  }
  return { stateDir, acquire, isInFlight, dispatch, logs, deps }
}

describe('buildTickBodies / pushTick — companion isolation (PR D)', () => {
  let cleanup: string[]
  beforeEach(() => { cleanup = [] })
  afterEach(() => {
    for (const d of cleanup) {
      try { rmSync(d, { recursive: true, force: true }) } catch { /* best effort */ }
    }
  })

  it('skips the tick when the resolved session has an in-flight dispatch', async () => {
    const s = setupDeps({
      defaultChatId: 'chat-1',
      inFlight: true,
      agendaMd: '- [ ] due:2026-05-13 check in on project',
    })
    cleanup.push(s.stateDir)
    const { pushTick } = buildTickBodies(s.deps)
    await pushTick({ nowIso: '2026-05-13T10:00:00.000Z' })
    expect(s.isInFlight).toHaveBeenCalledWith({ alias: '_default', providerId: 'claude', chatId: 'chat-1' })
    expect(s.acquire).not.toHaveBeenCalled()
    expect(s.dispatch).not.toHaveBeenCalled()
    expect(s.logs.some(l => l.includes('skipping push tick: user session in-flight'))).toBe(true)
  })

  it('proceeds when no in-flight dispatch on the session', async () => {
    const s = setupDeps({
      defaultChatId: 'chat-1',
      inFlight: false,
      agendaMd: '- [ ] due:2026-05-13 check in on project',
    })
    cleanup.push(s.stateDir)
    const { pushTick } = buildTickBodies(s.deps)
    await pushTick({ nowIso: '2026-05-13T10:00:00.000Z' })
    expect(s.isInFlight).toHaveBeenCalledWith({ alias: '_default', providerId: 'claude', chatId: 'chat-1' })
    expect(s.acquire).toHaveBeenCalledOnce()
    expect(s.dispatch).toHaveBeenCalledOnce()
  })

  it('dispatches on the chat\'s own mode provider, not the daemon default', async () => {
    // Daemon default is codex, but THIS chat is solo-claude (user runs /cc).
    // The proactive push must follow the chat's mode, else it dispatches to a
    // provider the chat never uses (the real bug: codex hung, nothing delivered).
    const s = setupDeps({
      defaultChatId: 'chat-1',
      inFlight: false,
      agendaMd: '- [ ] due:2026-05-13 check in on project',
      defaultProviderId: 'codex',
      mode: { kind: 'solo', provider: 'claude' },
    })
    cleanup.push(s.stateDir)
    const { pushTick } = buildTickBodies(s.deps)
    await pushTick({ nowIso: '2026-05-13T10:00:00.000Z' })
    expect(s.isInFlight).toHaveBeenCalledWith({ alias: '_default', providerId: 'claude', chatId: 'chat-1' })
    expect(s.acquire).toHaveBeenCalledOnce()
    expect(s.acquire.mock.calls[0]![0]).toMatchObject({ providerId: 'claude' })
  })

  it('primary_tool chat dispatches on its primary provider', async () => {
    const s = setupDeps({
      defaultChatId: 'chat-1',
      inFlight: false,
      agendaMd: '- [ ] due:2026-05-13 check in on project',
      defaultProviderId: 'codex',
      mode: { kind: 'primary_tool', primary: 'claude' },
    })
    cleanup.push(s.stateDir)
    const { pushTick } = buildTickBodies(s.deps)
    await pushTick({ nowIso: '2026-05-13T10:00:00.000Z' })
    expect(s.acquire.mock.calls[0]![0]).toMatchObject({ providerId: 'claude' })
  })

  it('skips before checking in-flight when default_chat_id is unset', async () => {
    const s = setupDeps({ defaultChatId: null, inFlight: false })
    cleanup.push(s.stateDir)
    const { pushTick } = buildTickBodies(s.deps)
    await pushTick()
    expect(s.isInFlight).not.toHaveBeenCalled()
    expect(s.acquire).not.toHaveBeenCalled()
  })

  it('returns silently without an LLM call when no agenda.md exists', async () => {
    // No agendaMd supplied → no agenda.md file → no due items → silent gate.
    const s = setupDeps({ defaultChatId: 'chat-1', inFlight: false })
    cleanup.push(s.stateDir)
    const { pushTick } = buildTickBodies(s.deps)
    await pushTick({ nowIso: '2026-05-13T10:00:00.000Z' })
    expect(s.isInFlight).not.toHaveBeenCalled()
    expect(s.acquire).not.toHaveBeenCalled()
    expect(s.dispatch).not.toHaveBeenCalled()
    expect(s.logs.some(l => l.includes('no due intentions'))).toBe(true)
  })

  it('returns silently when agenda.md has only future items', async () => {
    const s = setupDeps({
      defaultChatId: 'chat-1',
      inFlight: false,
      agendaMd: '- [ ] due:2026-12-31 far future item',
    })
    cleanup.push(s.stateDir)
    const { pushTick } = buildTickBodies(s.deps)
    await pushTick({ nowIso: '2026-05-13T10:00:00.000Z' })
    expect(s.isInFlight).not.toHaveBeenCalled()
    expect(s.acquire).not.toHaveBeenCalled()
    expect(s.logs.some(l => l.includes('no due intentions'))).toBe(true)
  })
})

describe('buildTickBodies / pushTick — companion default_chat_id + tier (Task 11)', () => {
  let cleanup: string[]
  beforeEach(() => { cleanup = [] })
  afterEach(() => {
    for (const d of cleanup) {
      try { rmSync(d, { recursive: true, force: true }) } catch { /* best effort */ }
    }
  })

  it('pushTick acquires with companion default_chat_id and admin tier resolved from access.json', async () => {
    const access: Access = {
      dmPolicy: 'allowlist',
      allowFrom: ['ownerChat'],
      admins: ['ownerChat'],
    }
    const s = setupDeps({
      defaultChatId: 'ownerChat',
      inFlight: false,
      access,
      agendaMd: '- [ ] due:2026-05-13 check in on project',
    })
    cleanup.push(s.stateDir)
    const { pushTick } = buildTickBodies(s.deps)
    await pushTick({ nowIso: '2026-05-13T10:00:00.000Z' })
    expect(s.acquire).toHaveBeenCalledOnce()
    const req = s.acquire.mock.calls[0]?.[0] as { chatId: string; tierProfile: unknown }
    expect(req.chatId).toBe('ownerChat')
    expect(req.tierProfile).toBe(TIER_PROFILES.admin)
    // Admin path: no COMPANION warning should fire.
    expect(s.logs.some(l => l.startsWith('COMPANION|'))).toBe(false)
  })

  it('pushTick with non-admin default_chat_id resolves to guest tier and logs a COMPANION warning', async () => {
    const access: Access = {
      dmPolicy: 'allowlist',
      allowFrom: ['nonadmin'],
      admins: ['someone-else'],
    }
    const s = setupDeps({
      defaultChatId: 'nonadmin',
      inFlight: false,
      access,
      agendaMd: '- [ ] due:2026-05-13 check in on project',
    })
    cleanup.push(s.stateDir)
    const { pushTick } = buildTickBodies(s.deps)
    await pushTick({ nowIso: '2026-05-13T10:00:00.000Z' })
    expect(s.acquire).toHaveBeenCalledOnce()
    const req = s.acquire.mock.calls[0]?.[0] as { chatId: string; tierProfile: unknown }
    expect(req.chatId).toBe('nonadmin')
    expect(req.tierProfile).toBe(TIER_PROFILES.guest)
    // Non-admin tier surfaces a single COMPANION log line — a real
    // operator-misconfiguration signal that the tick fires under reduced
    // capabilities.
    expect(s.logs.some(l => l.startsWith('COMPANION|') && l.includes('non-admin') && l.includes('guest'))).toBe(true)
  })

  it('pushTick with trusted default_chat_id resolves to trusted tier and logs a COMPANION warning', async () => {
    const access: Access = {
      dmPolicy: 'allowlist',
      allowFrom: ['trustyChat'],
      trusted: ['trustyChat'],
    }
    const s = setupDeps({
      defaultChatId: 'trustyChat',
      inFlight: false,
      access,
      agendaMd: '- [ ] due:2026-05-13 check in on project',
    })
    cleanup.push(s.stateDir)
    const { pushTick } = buildTickBodies(s.deps)
    await pushTick({ nowIso: '2026-05-13T10:00:00.000Z' })
    expect(s.acquire).toHaveBeenCalledOnce()
    const req = s.acquire.mock.calls[0]?.[0] as { chatId: string; tierProfile: unknown }
    expect(req.tierProfile).toBe(TIER_PROFILES.trusted)
    expect(s.logs.some(l => l.startsWith('COMPANION|') && l.includes('trusted'))).toBe(true)
  })
})

describe('buildTickBodies / introspectTick — provider-agnostic cheap eval (PR F)', () => {
  let cleanup: string[]
  beforeEach(() => { cleanup = [] })
  afterEach(() => {
    for (const d of cleanup) {
      try { rmSync(d, { recursive: true, force: true }) } catch { /* best effort */ }
    }
  })

  it('skips the tick when no registered provider implements cheapEval', async () => {
    const s = setupDeps({ defaultChatId: 'chat-1', inFlight: false })
    cleanup.push(s.stateDir)
    // setupDeps already wires registry.getCheapEval to return null.
    const { introspectTick } = buildTickBodies(s.deps)
    await introspectTick()
    expect(s.logs.some(l => l.includes('skip tick — no registered provider implements cheapEval'))).toBe(true)
  })

  it('resolves cheapEval via registry per-tick (proves no hardcoded Claude SDK call)', async () => {
    // Spy on getCheapEval to verify introspect goes through the
    // provider-agnostic registry path. Returning null causes the tick
    // to skip immediately — we don't need a real db just to assert
    // resolver invocation.
    const getCheapEval = vi.fn(() => null)
    const s = setupDeps({ defaultChatId: 'chat-introspect', inFlight: false })
    cleanup.push(s.stateDir)
    s.deps.boot = {
      ...s.deps.boot,
      registry: { getCheapEval } as never,
    }
    const { introspectTick } = buildTickBodies(s.deps)
    await introspectTick()
    expect(getCheapEval).toHaveBeenCalledTimes(1)
  })
})
