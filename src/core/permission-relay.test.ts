import { describe, it, expect, vi } from 'vitest'
import { makeCanUseTool, effectivePolicy } from './permission-relay'
import { CAPABILITY_MATRIX, type Capability } from './capability-matrix'
import { TIER_PROFILES } from './user-tier'

const baseMode = {
  mode: () => 'solo' as const,
  provider: 'claude' as const,
  permissionMode: 'strict' as const,
}

describe('makeCanUseTool', () => {
  // Post-RFC-05: admin tier auto-allows safe tools and only relays
  // destructive ones (shell_destructive / memory_delete). Tests use
  // destructive Bash (`rm -rf`) to trigger the relay path.
  it('returns allow when admin user replies allow', async () => {
    const ask = vi.fn().mockResolvedValue('allow')
    const fn = makeCanUseTool({
      askUser: ask,
      resolveTier: () => 'admin',
      adminChatId: () => 'admin-chat',
      initiatingChatId: () => 'admin-chat',
      log: () => {},
      ...baseMode,
    })
    // admin tier relays shell_destructive — Bash `rm -rf` triggers the relay path.
    const res = await fn('Bash', { command: 'rm -rf /tmp/x' }, { signal: new AbortController().signal, toolUseID: 't1' } as any)
    expect(res.behavior).toBe('allow')
    expect(ask).toHaveBeenCalledWith('admin-chat', expect.stringContaining('Bash'), expect.any(String), expect.any(Number))
  })

  it('returns deny when admin user replies deny', async () => {
    const fn = makeCanUseTool({
      askUser: async () => 'deny',
      resolveTier: () => 'admin',
      adminChatId: () => 'admin-chat',
      initiatingChatId: () => 'admin-chat',
      log: () => {},
      ...baseMode,
    })
    const res = await fn('Bash', { command: 'rm -rf /tmp/x' }, { signal: new AbortController().signal, toolUseID: 't1' } as any)
    expect(res.behavior).toBe('deny')
    if (res.behavior === 'deny') expect(res.message).toMatch(/denied/i)
  })

  it('returns deny on timeout', async () => {
    const fn = makeCanUseTool({
      askUser: async () => 'timeout',
      resolveTier: () => 'admin',
      adminChatId: () => 'admin-chat',
      initiatingChatId: () => 'admin-chat',
      log: () => {},
      ...baseMode,
    })
    const res = await fn('Bash', { command: 'rm -rf /tmp/x' }, { signal: new AbortController().signal, toolUseID: 't' } as any)
    expect(res.behavior).toBe('deny')
  })

  it('admin auto-allows safe tools without prompting (post-RFC-05)', async () => {
    // Strict mode no longer means "prompt every tool" — admin tier's
    // explicit `allow` set short-circuits the matrix's per-tool ask
    // for non-destructive tools.
    const ask = vi.fn()
    const fn = makeCanUseTool({
      askUser: ask,
      resolveTier: () => 'admin',
      adminChatId: () => 'admin-chat',
      initiatingChatId: () => 'admin-chat',
      log: () => {},
      ...baseMode,
    })
    const res = await fn('Bash', { command: 'ls' }, { signal: new AbortController().signal, toolUseID: 't' } as any)
    expect(res.behavior).toBe('allow')
    expect(ask).not.toHaveBeenCalled()
  })

  it('consults mode() per-call: matrix lookup follows the chat\'s CURRENT mode', async () => {
    // Bug pre-PR E: mode was captured at boot as 'solo', so a chat that
    // switched to chatroom/parallel/primary_tool still got matrix rows
    // looked up under 'solo'. Now mode is a callback resolved on each
    // tool call. Use destructive Bash so admin tier actually relays.
    let currentMode: 'solo' | 'chatroom' | 'parallel' | 'primary_tool' = 'solo'
    const ask = vi.fn().mockResolvedValue('allow')
    const fn = makeCanUseTool({
      askUser: ask,
      resolveTier: () => 'admin',
      adminChatId: () => 'c1',
      initiatingChatId: () => 'c1',
      log: () => {},
      mode: () => currentMode,
      provider: 'claude',
      permissionMode: 'strict',
    })
    await fn('Bash', { command: 'rm -rf /tmp/x' }, { signal: new AbortController().signal, toolUseID: 't1' } as never)
    // Flip the chat's mode at runtime → next tool call should consult
    // the new row.
    currentMode = 'chatroom'
    await fn('Bash', { command: 'rm -rf /tmp/y' }, { signal: new AbortController().signal, toolUseID: 't2' } as never)
    // Both calls relay; assertion that matters is no throw on the second
    // call — meaning the matrix lookup succeeded for chatroom too.
    expect(ask).toHaveBeenCalledTimes(2)
  })

  it('returns deny when relay is needed but no admin chat configured', async () => {
    const ask = vi.fn()
    const fn = makeCanUseTool({
      askUser: ask,
      resolveTier: () => 'admin',
      adminChatId: () => null,
      initiatingChatId: () => null,
      log: () => {},
      ...baseMode,
    })
    // shell_destructive triggers the admin relay path.
    const res = await fn('Bash', { command: 'rm -rf /tmp/x' }, { signal: new AbortController().signal, toolUseID: 't' } as any)
    expect(res.behavior).toBe('deny')
    expect(ask).not.toHaveBeenCalled()
  })

  it('canUseTool denies a guest trying to call Bash even though matrix would allow it', async () => {
    const cut = makeCanUseTool({
      askUser: async () => 'deny',
      resolveTier: () => 'guest',
      adminChatId: () => 'admin1',
      initiatingChatId: () => 'guest1',
      mode: () => 'solo',
      provider: 'claude',
      permissionMode: 'strict',
      log: () => {},
    })
    const result = await cut('Bash', { command: 'ls' }, { toolUseID: 'tid' } as any)
    expect(result.behavior).toBe('deny')
  })

  it('canUseTool relays destructive Bash for trusted user', async () => {
    let lastTarget: string | null = null
    const cut = makeCanUseTool({
      askUser: async (target) => { lastTarget = target; return 'allow' },
      resolveTier: () => 'trusted',
      adminChatId: () => 'admin1',
      initiatingChatId: () => 'trusted1',
      mode: () => 'solo',
      provider: 'claude',
      permissionMode: 'strict',
      log: () => {},
    })
    // Post-RFC-05: trusted auto-allows plain Bash; only destructive
    // Bash (rm -rf, etc.) goes through the relay set.
    const result = await cut('Bash', { command: 'rm -rf /tmp/x' }, { toolUseID: 'tid' } as any)
    expect(result.behavior).toBe('allow')  // trusted.relay has shell_destructive → relay
    expect(lastTarget).toBe('admin1')       // prompt routed to admin chat, not the trusted user
  })
})

describe('effectivePolicy', () => {
  const adminBase = { askUser: 'never' } as Capability
  const strictBase = { askUser: 'per-tool' } as Capability

  it('tier.deny → deny regardless of base', () => {
    expect(effectivePolicy(adminBase, TIER_PROFILES.guest, 'shell')).toBe('deny')
    expect(effectivePolicy(strictBase, TIER_PROFILES.guest, 'shell')).toBe('deny')
  })

  it('tier.relay → relay regardless of base', () => {
    expect(effectivePolicy(adminBase, TIER_PROFILES.trusted, 'shell_destructive')).toBe('relay')
    expect(effectivePolicy(strictBase, TIER_PROFILES.trusted, 'shell_destructive')).toBe('relay')
  })

  it('tier.allow + base never → allow', () => {
    expect(effectivePolicy(adminBase, TIER_PROFILES.admin, 'shell')).toBe('allow')
  })

  it('tier.allow + base per-tool → allow (post-RFC-05: tier short-circuits matrix)', () => {
    // Pre-RFC-05: matrix.askUser='per-tool' overrode tier.allow → relay.
    // Post-RFC-05: tier.allow explicitly auto-allows; matrix is only the
    // fallthrough when tier didn't classify the kind. Means admin tier
    // in strict mode auto-allows safe tools instead of prompting for
    // each one.
    expect(effectivePolicy(strictBase, TIER_PROFILES.admin, 'shell')).toBe('allow')
  })
})

describe('permission-relay × capability-matrix', () => {
  it.each(CAPABILITY_MATRIX.filter(r => r.askUser === 'never'))(
    '$mode/$provider/$permissionMode → admin tier + askUser="never" SHOULD short-circuit to allow',
    async (row) => {
      const askUser = vi.fn(async () => 'allow' as const)
      const canUse = makeCanUseTool({
        askUser,
        resolveTier: () => 'admin',
        adminChatId: () => 'admin1',
        initiatingChatId: () => 'c1',
        log: () => {},
        mode: () => row.mode,
        provider: row.provider,
        permissionMode: row.permissionMode,
      })
      const result = await canUse('Bash', { command: 'ls' }, { signal: new AbortController().signal, suggestions: [] } as any)
      expect(result.behavior).toBe('allow')
      expect(askUser).not.toHaveBeenCalled()
    },
  )

  // Post-RFC-05: matrix.askUser='per-tool' is the fallthrough when tier
  // didn't classify a kind. Admin tier's allow set covers `shell` (plain
  // Bash), so admin in strict mode no longer prompts for `Bash ls`. Use
  // destructive Bash (`rm -rf`) to verify the relay still fires for the
  // kinds admin tier *explicitly* relays (shell_destructive).
  it.each(CAPABILITY_MATRIX.filter(r => r.askUser === 'per-tool'))(
    '$mode/$provider/$permissionMode → admin tier relays destructive Bash via tier.relay',
    async (row) => {
      const askUser = vi.fn(async () => 'allow' as const)
      const canUse = makeCanUseTool({
        askUser,
        resolveTier: () => 'admin',
        adminChatId: () => 'admin1',
        initiatingChatId: () => 'c1',
        log: () => {},
        mode: () => row.mode,
        provider: row.provider,
        permissionMode: row.permissionMode,
      })
      await canUse('Bash', { command: 'rm -rf /tmp/x' }, { signal: new AbortController().signal, suggestions: [] } as any)
      expect(askUser).toHaveBeenCalled()
    },
  )

  it.each(CAPABILITY_MATRIX.filter(r => r.askUser === 'per-tool'))(
    '$mode/$provider/$permissionMode → admin auto-allows plain Bash (no prompt)',
    async (row) => {
      const askUser = vi.fn(async () => 'allow' as const)
      const canUse = makeCanUseTool({
        askUser,
        resolveTier: () => 'admin',
        adminChatId: () => 'admin1',
        initiatingChatId: () => 'c1',
        log: () => {},
        mode: () => row.mode,
        provider: row.provider,
        permissionMode: row.permissionMode,
      })
      await canUse('Bash', { command: 'ls' }, { signal: new AbortController().signal, suggestions: [] } as any)
      expect(askUser).not.toHaveBeenCalled()
    },
  )
})
