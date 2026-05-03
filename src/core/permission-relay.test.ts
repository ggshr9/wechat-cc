import { describe, it, expect, vi } from 'vitest'
import { makeCanUseTool } from './permission-relay'
import { CAPABILITY_MATRIX } from './capability-matrix'

const baseMode = { mode: 'solo' as const, provider: 'claude' as const, permissionMode: 'strict' as const }

describe('makeCanUseTool', () => {
  it('returns allow when user replies allow', async () => {
    const ask = vi.fn().mockResolvedValue('allow')
    const fn = makeCanUseTool({
      askUser: ask,
      defaultChatId: () => 'admin-chat',
      log: () => {},
      ...baseMode,
    })
    const res = await fn('Edit', { path: '/tmp/x' }, { signal: new AbortController().signal, toolUseID: 't1' } as any)
    expect(res.behavior).toBe('allow')
    expect(ask).toHaveBeenCalledWith('admin-chat', expect.stringContaining('Edit'), expect.any(String), expect.any(Number))
  })

  it('returns deny when user replies deny', async () => {
    const fn = makeCanUseTool({
      askUser: async () => 'deny',
      defaultChatId: () => 'admin-chat',
      log: () => {},
      ...baseMode,
    })
    const res = await fn('Bash', { cmd: 'rm -rf /' }, { signal: new AbortController().signal, toolUseID: 't1' } as any)
    expect(res.behavior).toBe('deny')
    if (res.behavior === 'deny') expect(res.message).toMatch(/denied/i)
  })

  it('returns deny on timeout', async () => {
    const fn = makeCanUseTool({
      askUser: async () => 'timeout',
      defaultChatId: () => 'admin-chat',
      log: () => {},
      ...baseMode,
    })
    const res = await fn('Write', { path: '/x' }, { signal: new AbortController().signal, toolUseID: 't' } as any)
    expect(res.behavior).toBe('deny')
  })

  it('returns deny with auto-decline reason when no default chat', async () => {
    const ask = vi.fn()
    const fn = makeCanUseTool({
      askUser: ask,
      defaultChatId: () => null,
      log: () => {},
      ...baseMode,
    })
    const res = await fn('Edit', {}, { signal: new AbortController().signal, toolUseID: 't' } as any)
    expect(res.behavior).toBe('deny')
    expect(ask).not.toHaveBeenCalled()
  })
})

describe('permission-relay × capability-matrix', () => {
  it.each(CAPABILITY_MATRIX.filter(r => r.askUser === 'never'))(
    '$mode/$provider/$permissionMode → askUser="never" SHOULD short-circuit to allow',
    async (row) => {
      const askUser = vi.fn(async () => 'allow' as const)
      const canUse = makeCanUseTool({
        askUser,
        defaultChatId: () => 'c1',
        log: () => {},
        mode: row.mode,
        provider: row.provider,
        permissionMode: row.permissionMode,
      })
      const result = await canUse('Bash', { command: 'ls' }, { signal: new AbortController().signal, suggestions: [] } as any)
      expect(result.behavior).toBe('allow')
      expect(askUser).not.toHaveBeenCalled()
    },
  )

  it.each(CAPABILITY_MATRIX.filter(r => r.askUser === 'per-tool'))(
    '$mode/$provider/$permissionMode → askUser="per-tool" SHOULD invoke askUser',
    async (row) => {
      const askUser = vi.fn(async () => 'allow' as const)
      const canUse = makeCanUseTool({
        askUser,
        defaultChatId: () => 'c1',
        log: () => {},
        mode: row.mode,
        provider: row.provider,
        permissionMode: row.permissionMode,
      })
      await canUse('Bash', { command: 'ls' }, { signal: new AbortController().signal, suggestions: [] } as any)
      expect(askUser).toHaveBeenCalled()
    },
  )
})
