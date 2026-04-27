import { describe, it, expect, vi } from 'vitest'
import { routeInbound, type RouterDeps } from './message-router'

describe('routeInbound', () => {
  it('resolves chat to project and dispatches formatted prompt', async () => {
    const dispatch = vi.fn().mockResolvedValue(undefined)
    const acquire = vi.fn().mockResolvedValue({ alias: 'P', path: '/p', dispatch })
    const log = vi.fn()
    const deps: RouterDeps = {
      resolveProject: () => ({ alias: 'P', path: '/p' }),
      manager: { acquire } as any,
      format: (m) => `MSG:${m.text}`,
      log,
    }
    await routeInbound(deps, {
      chatId: 'c', userId: 'u', userName: 'n',
      text: 'hi', msgType: 'text', createTimeMs: 1, accountId: 'a',
    })
    expect(acquire).toHaveBeenCalledWith('P', '/p')
    expect(dispatch).toHaveBeenCalledWith('MSG:hi')
    expect(log).toHaveBeenCalledWith('ROUTER', expect.stringContaining('route chat=c'))
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

  it('can relay provider assistant text back to the source chat', async () => {
    const dispatch = vi.fn().mockResolvedValue({ assistantText: ['codex says hi'] })
    const sendAssistantText = vi.fn().mockResolvedValue(undefined)
    const deps: RouterDeps = {
      resolveProject: () => ({ alias: 'P', path: '/p' }),
      manager: {
        acquire: vi.fn().mockResolvedValue({
          alias: 'P',
          path: '/p',
          dispatch,
        }),
      } as any,
      format: (m) => m.text,
      sendAssistantText,
      log: vi.fn(),
    }

    await routeInbound(deps, {
      chatId: 'chat-1', userId: 'u', text: 'hi', msgType: 'text', createTimeMs: 1, accountId: 'a',
    })

    expect(sendAssistantText).toHaveBeenCalledWith('chat-1', 'codex says hi')
  })

  it('does not attach session-wide assistant listeners that can leak across chats', async () => {
    const assistantListeners = new Set<(text: string) => void>()
    const dispatch = vi.fn().mockResolvedValue({})
    const sendAssistantText = vi.fn().mockResolvedValue(undefined)
    const deps: RouterDeps = {
      resolveProject: () => ({ alias: 'P', path: '/p' }),
      manager: {
        acquire: vi.fn().mockResolvedValue({
          alias: 'P',
          path: '/p',
          dispatch,
          onAssistantText: (cb: (text: string) => void) => {
            assistantListeners.add(cb)
            return () => { assistantListeners.delete(cb) }
          },
        }),
      } as any,
      format: (m) => m.text,
      sendAssistantText,
      log: vi.fn(),
    }

    await routeInbound(deps, {
      chatId: 'chat-1', userId: 'u1', text: 'first', msgType: 'text', createTimeMs: 1, accountId: 'a',
    })
    await routeInbound(deps, {
      chatId: 'chat-2', userId: 'u2', text: 'second', msgType: 'text', createTimeMs: 2, accountId: 'a',
    })
    for (const cb of assistantListeners) cb('late shared-session text')

    expect(assistantListeners.size).toBe(0)
    expect(sendAssistantText).not.toHaveBeenCalled()
  })
})
