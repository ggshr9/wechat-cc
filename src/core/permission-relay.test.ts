import { describe, it, expect, vi } from 'vitest'
import { makeCanUseTool } from './permission-relay'

describe('makeCanUseTool', () => {
  it('returns allow when user replies allow', async () => {
    const ask = vi.fn().mockResolvedValue('allow')
    const fn = makeCanUseTool({
      askUser: ask,
      defaultChatId: () => 'admin-chat',
      log: () => {},
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
    })
    const res = await fn('Edit', {}, { signal: new AbortController().signal, toolUseID: 't' } as any)
    expect(res.behavior).toBe('deny')
    expect(ask).not.toHaveBeenCalled()
  })
})
