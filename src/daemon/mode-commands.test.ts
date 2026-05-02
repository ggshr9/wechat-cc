import { describe, expect, it, vi } from 'vitest'
import { makeModeCommands } from './mode-commands'
import type { Mode, ProviderId } from '../core/conversation'
import type { InboundMsg } from '../core/prompt-format'

function inbound(text: string, chatId = 'chat-1'): InboundMsg {
  return { chatId, userId: chatId, text, msgType: 'text', createTimeMs: 0, accountId: 'a' }
}

function setup(opts: {
  registered?: ProviderId[]
  defaultProviderId?: ProviderId
  initialMode?: Mode
} = {}) {
  const registered = opts.registered ?? ['claude', 'codex']
  const set = vi.fn<(chatId: string, mode: Mode) => void>()
  let stored: Mode | null = opts.initialMode ?? null
  const sentMessages: Array<[string, string]> = []
  const sendMessage = vi.fn(async (chatId: string, text: string) => {
    sentMessages.push([chatId, text])
    return { msgId: 'm-1' }
  })
  const cmds = makeModeCommands({
    coordinator: {
      getMode: () => stored ?? { kind: 'solo', provider: opts.defaultProviderId ?? 'claude' },
      setMode: (chatId, mode) => { stored = mode; set(chatId, mode) },
    },
    registry: {
      has: (id: string) => registered.includes(id),
      get: (id: string) => registered.includes(id)
        ? { provider: {} as never, opts: { displayName: id[0]!.toUpperCase() + id.slice(1), canResume: () => true } }
        : null,
      list: () => registered,
    },
    defaultProviderId: opts.defaultProviderId ?? 'claude',
    sendMessage: sendMessage as unknown as Parameters<typeof makeModeCommands>[0]['sendMessage'],
    log: () => {},
  })
  return { cmds, set, sendMessage, sentMessages, getStored: () => stored }
}

describe('makeModeCommands', () => {
  it('returns false for non-slash messages (passes through to next handler)', async () => {
    const { cmds, sendMessage } = setup()
    const consumed = await cmds.handle(inbound('hello, this is just a normal message'))
    expect(consumed).toBe(false)
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('/cc switches mode to solo+claude and replies', async () => {
    const { cmds, set, sentMessages } = setup({ defaultProviderId: 'codex' })
    const consumed = await cmds.handle(inbound('/cc'))
    expect(consumed).toBe(true)
    expect(set).toHaveBeenCalledWith('chat-1', { kind: 'solo', provider: 'claude' })
    expect(sentMessages[0]?.[1]).toContain('Claude')
    expect(sentMessages[0]?.[1]).toContain('solo')
  })

  it('/codex switches mode to solo+codex', async () => {
    const { cmds, set } = setup()
    await cmds.handle(inbound('/codex'))
    expect(set).toHaveBeenCalledWith('chat-1', { kind: 'solo', provider: 'codex' })
  })

  it('/cc and /codex are case-insensitive on the slash word', async () => {
    const { cmds, set } = setup()
    await cmds.handle(inbound('/CC'))
    expect(set).toHaveBeenLastCalledWith('chat-1', { kind: 'solo', provider: 'claude' })
    await cmds.handle(inbound('/Codex'))
    expect(set).toHaveBeenLastCalledWith('chat-1', { kind: 'solo', provider: 'codex' })
  })

  it('/cc rejects with helpful message when claude is not registered', async () => {
    const { cmds, set, sentMessages } = setup({ registered: ['codex'] })
    const consumed = await cmds.handle(inbound('/cc'))
    expect(consumed).toBe(true)
    expect(set).not.toHaveBeenCalled()
    expect(sentMessages[0]?.[1]).toContain('未注册')
    expect(sentMessages[0]?.[1]).toContain('codex')
  })

  it('/solo reverts to default provider', async () => {
    const { cmds, set, sentMessages } = setup({ defaultProviderId: 'claude' })
    await cmds.handle(inbound('/solo'))
    expect(set).toHaveBeenCalledWith('chat-1', { kind: 'solo', provider: 'claude' })
    expect(sentMessages[0]?.[1]).toContain('恢复默认')
  })

  it('/mode shows current mode + registered providers + default', async () => {
    const { cmds, sentMessages } = setup({
      defaultProviderId: 'codex',
      initialMode: { kind: 'solo', provider: 'claude' },
    })
    await cmds.handle(inbound('/mode'))
    const text = sentMessages[0]?.[1] ?? ''
    expect(text).toContain('solo · claude')   // current
    expect(text).toContain('claude, codex')   // registered
    expect(text).toContain('默认: codex')      // default
  })

  it('/both switches to parallel mode (RFC 03 P3)', async () => {
    const { cmds, set, sentMessages } = setup({ registered: ['claude', 'codex'] })
    const consumed = await cmds.handle(inbound('/both'))
    expect(consumed).toBe(true)
    expect(set).toHaveBeenCalledWith('chat-1', { kind: 'parallel' })
    expect(sentMessages[0]?.[1]).toContain('并行模式开启')
    expect(sentMessages[0]?.[1]).toContain('[Claude]')
    expect(sentMessages[0]?.[1]).toContain('[Codex]')
  })

  it('/both surfaces validation error when one provider missing', async () => {
    // Mock setMode to throw — simulates coordinator's validateMode rejecting
    const sentMessages: Array<[string, string]> = []
    const sendMessage = vi.fn(async (chatId: string, text: string) => {
      sentMessages.push([chatId, text]); return { msgId: 'm' }
    })
    const cmds = makeModeCommands({
      coordinator: {
        getMode: () => ({ kind: 'solo', provider: 'claude' }),
        setMode: () => { throw new Error("mode 'parallel' requires providers claude, codex; missing: codex") },
      },
      registry: {
        has: (id: string) => id === 'claude',
        get: () => ({ provider: {} as never, opts: { displayName: 'Claude', canResume: () => true } }),
        list: () => ['claude'],
      },
      defaultProviderId: 'claude',
      sendMessage: sendMessage as unknown as Parameters<typeof makeModeCommands>[0]['sendMessage'],
      log: () => {},
    })
    await cmds.handle(inbound('/both'))
    expect(sentMessages[0]?.[1]).toContain('启用失败')
    expect(sentMessages[0]?.[1]).toContain('missing: codex')
  })

  it('/chat and /cc + codex still placeholder ("not yet implemented")', async () => {
    const { cmds, set, sentMessages } = setup()
    await cmds.handle(inbound('/chat'))
    await cmds.handle(inbound('/cc + codex'))
    expect(set).not.toHaveBeenCalled()
    expect(sentMessages[0]?.[1]).toContain('P5')
    expect(sentMessages[1]?.[1]).toContain('P4')
  })

  it('/mode lists /both as available', async () => {
    const { cmds, sentMessages } = setup()
    await cmds.handle(inbound('/mode'))
    expect(sentMessages[0]?.[1]).toContain('/both')
  })

  it('returns false for unrecognised slash words like /health (lets admin-commands handle)', async () => {
    const { cmds, sendMessage } = setup()
    const consumed = await cmds.handle(inbound('/health'))
    expect(consumed).toBe(false)
    expect(sendMessage).not.toHaveBeenCalled()
  })
})
