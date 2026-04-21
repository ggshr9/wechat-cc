import { describe, it, expect, vi } from 'vitest'
import { routeInbound, type RouterDeps } from './message-router'

describe('routeInbound', () => {
  it('resolves chat to project and dispatches formatted prompt', async () => {
    const dispatch = vi.fn().mockResolvedValue(undefined)
    const acquire = vi.fn().mockResolvedValue({ alias: 'P', path: '/p', dispatch })
    const deps: RouterDeps = {
      resolveProject: () => ({ alias: 'P', path: '/p' }),
      manager: { acquire } as any,
      format: (m) => `MSG:${m.text}`,
      log: () => {},
    }
    await routeInbound(deps, {
      chatId: 'c', userId: 'u', userName: 'n',
      text: 'hi', msgType: 'text', createTimeMs: 1, accountId: 'a',
    })
    expect(acquire).toHaveBeenCalledWith('P', '/p')
    expect(dispatch).toHaveBeenCalledWith('MSG:hi')
  })

  it('logs and drops when resolver returns null project', async () => {
    const log = vi.fn()
    const acquire = vi.fn()
    const deps: RouterDeps = {
      resolveProject: () => null,
      manager: { acquire } as any,
      format: (m) => m.text,
      log,
    }
    await routeInbound(deps, {
      chatId: 'c', userId: 'u', text: 'hi', msgType: 'text', createTimeMs: 1, accountId: 'a',
    })
    expect(acquire).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalled()
  })
})
