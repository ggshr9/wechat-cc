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
  initialUserName?: string
} = {}) {
  const registered = opts.registered ?? ['claude', 'codex']
  const set = vi.fn<(chatId: string, mode: Mode) => void>()
  let stored: Mode | null = opts.initialMode ?? null
  let storedName: { chat: string; name: string } | null = null
  const sentMessages: Array<[string, string]> = []
  const sendMessage = vi.fn(async (chatId: string, text: string) => {
    sentMessages.push([chatId, text])
    return { msgId: 'm-1' }
  })
  const cmds = makeModeCommands({
    coordinator: {
      getMode: () => stored ?? { kind: 'solo', provider: opts.defaultProviderId ?? 'claude' },
      setMode: (chatId, mode) => { stored = mode; set(chatId, mode) },
      cancel: () => false,
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
    setUserName: vi.fn(async (chat: string, name: string) => { storedName = { chat, name } }),
    getUserName: vi.fn(() => opts.initialUserName ?? null),
    log: () => {},
  })
  return { cmds, set, sendMessage, sentMessages, getStored: () => stored, getStoredName: () => storedName }
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
        cancel: () => false,
      },
      registry: {
        has: (id: string) => id === 'claude',
        get: () => ({ provider: {} as never, opts: { displayName: 'Claude', canResume: () => true } }),
        list: () => ['claude'],
      },
      defaultProviderId: 'claude',
      sendMessage: sendMessage as unknown as Parameters<typeof makeModeCommands>[0]['sendMessage'],
      setUserName: async () => {},
      getUserName: () => null,
      log: () => {},
    })
    await cmds.handle(inbound('/both'))
    expect(sentMessages[0]?.[1]).toContain('启用失败')
    expect(sentMessages[0]?.[1]).toContain('missing: codex')
  })

  // ── /chat — chatroom mode (RFC 03 P5) ─────────────────────────────────

  it('/chat switches to chatroom mode', async () => {
    const { cmds, set, sentMessages } = setup({ registered: ['claude', 'codex'] })
    const consumed = await cmds.handle(inbound('/chat'))
    expect(consumed).toBe(true)
    expect(set).toHaveBeenCalledWith('chat-1', { kind: 'chatroom' })
    expect(sentMessages[0]?.[1]).toContain('聊天室模式开启')
    expect(sentMessages[0]?.[1]).toContain('@user')
    expect(sentMessages[0]?.[1]).toContain('@codex')
    expect(sentMessages[0]?.[1]).toContain('/stop')
  })

  it('/chat surfaces validation error when one provider missing', async () => {
    const sentMessages: Array<[string, string]> = []
    const sendMessage = vi.fn(async (chatId: string, text: string) => {
      sentMessages.push([chatId, text]); return { msgId: 'm' }
    })
    const cmds = makeModeCommands({
      coordinator: {
        getMode: () => ({ kind: 'solo', provider: 'claude' }),
        setMode: () => { throw new Error("mode 'chatroom' requires providers claude, codex; missing: codex") },
        cancel: () => false,
      },
      registry: {
        has: (id: string) => id === 'claude',
        get: () => ({ provider: {} as never, opts: { displayName: 'Claude', canResume: () => true } }),
        list: () => ['claude'],
      },
      defaultProviderId: 'claude',
      sendMessage: sendMessage as unknown as Parameters<typeof makeModeCommands>[0]['sendMessage'],
      setUserName: async () => {},
      getUserName: () => null,
      log: () => {},
    })
    await cmds.handle(inbound('/chat'))
    expect(sentMessages[0]?.[1]).toContain('启用失败')
    expect(sentMessages[0]?.[1]).toContain('missing: codex')
  })

  // ── /stop — exit any mode, revert to default ──────────────────────────

  it('/stop reverts to default solo (alias for /solo)', async () => {
    const { cmds, set, sentMessages } = setup({
      defaultProviderId: 'codex',
      initialMode: { kind: 'chatroom' },
    })
    const consumed = await cmds.handle(inbound('/stop'))
    expect(consumed).toBe(true)
    expect(set).toHaveBeenCalledWith('chat-1', { kind: 'solo', provider: 'codex' })
    expect(sentMessages[0]?.[1]).toContain('已退出当前模式')
    expect(sentMessages[0]?.[1]).toContain('Codex')
  })

  it('/stop also calls coordinator.cancel and notifies on in-flight chatroom (RFC 03 review #11)', async () => {
    const sentMessages: Array<[string, string]> = []
    const sendMessage = vi.fn(async (chatId: string, text: string) => {
      sentMessages.push([chatId, text]); return { msgId: 'm' }
    })
    const cancel = vi.fn(() => true)  // signals an in-flight loop
    const cmds = makeModeCommands({
      coordinator: {
        getMode: () => ({ kind: 'chatroom' }),
        setMode: () => {},
        cancel,
      },
      registry: {
        has: () => true,
        get: () => ({ provider: {} as never, opts: { displayName: 'Claude', canResume: () => true } }),
        list: () => ['claude', 'codex'],
      },
      defaultProviderId: 'claude',
      sendMessage: sendMessage as unknown as Parameters<typeof makeModeCommands>[0]['sendMessage'],
      setUserName: async () => {},
      getUserName: () => null,
      log: () => {},
    })
    await cmds.handle(inbound('/stop'))
    expect(cancel).toHaveBeenCalledWith('chat-1')
    expect(sentMessages[0]?.[1]).toContain('已中止 in-flight chatroom')
  })

  it('/stop without in-flight loop does NOT mention cancel suffix', async () => {
    const sentMessages: Array<[string, string]> = []
    const sendMessage = vi.fn(async (chatId: string, text: string) => {
      sentMessages.push([chatId, text]); return { msgId: 'm' }
    })
    const cmds = makeModeCommands({
      coordinator: {
        getMode: () => ({ kind: 'solo', provider: 'claude' }),
        setMode: () => {},
        cancel: () => false,  // nothing in flight
      },
      registry: {
        has: () => true,
        get: () => ({ provider: {} as never, opts: { displayName: 'Claude', canResume: () => true } }),
        list: () => ['claude', 'codex'],
      },
      defaultProviderId: 'claude',
      sendMessage: sendMessage as unknown as Parameters<typeof makeModeCommands>[0]['sendMessage'],
      setUserName: async () => {},
      getUserName: () => null,
      log: () => {},
    })
    await cmds.handle(inbound('/stop'))
    expect(sentMessages[0]?.[1]).not.toContain('已中止')
  })

  it('/mode lists /chat and /stop as available now', async () => {
    const { cmds, sentMessages } = setup()
    await cmds.handle(inbound('/mode'))
    expect(sentMessages[0]?.[1]).toContain('/chat')
    expect(sentMessages[0]?.[1]).toContain('/stop')
  })

  it('/mode lists /both and /cc + codex as available', async () => {
    const { cmds, sentMessages } = setup()
    await cmds.handle(inbound('/mode'))
    expect(sentMessages[0]?.[1]).toContain('/both')
    expect(sentMessages[0]?.[1]).toContain('/cc + codex')
    expect(sentMessages[0]?.[1]).toContain('/codex + cc')
  })

  // ── /cc + codex / /codex + cc — primary_tool (RFC 03 P4) ─────────────

  it('/cc + codex switches to primary_tool with claude primary', async () => {
    const { cmds, set, sentMessages } = setup({ registered: ['claude', 'codex'] })
    const consumed = await cmds.handle(inbound('/cc + codex'))
    expect(consumed).toBe(true)
    expect(set).toHaveBeenCalledWith('chat-1', { kind: 'primary_tool', primary: 'claude' })
    expect(sentMessages[0]?.[1]).toContain('主从模式开启')
    expect(sentMessages[0]?.[1]).toContain('Claude')
    expect(sentMessages[0]?.[1]).toContain('delegate_codex')
  })

  it('/codex + cc switches to primary_tool with codex primary', async () => {
    const { cmds, set, sentMessages } = setup({ registered: ['claude', 'codex'] })
    await cmds.handle(inbound('/codex + cc'))
    expect(set).toHaveBeenCalledWith('chat-1', { kind: 'primary_tool', primary: 'codex' })
    expect(sentMessages[0]?.[1]).toContain('Codex')
    expect(sentMessages[0]?.[1]).toContain('delegate_claude')
  })

  it('/cc + codex tolerates whitespace variations', async () => {
    const { cmds, set } = setup({ registered: ['claude', 'codex'] })
    await cmds.handle(inbound('/cc +codex'))
    expect(set).toHaveBeenLastCalledWith('chat-1', { kind: 'primary_tool', primary: 'claude' })
    await cmds.handle(inbound('/cc +   codex   '))
    expect(set).toHaveBeenLastCalledWith('chat-1', { kind: 'primary_tool', primary: 'claude' })
  })

  it('/cc + cc rejects same-provider self-delegation', async () => {
    const { cmds, set, sentMessages } = setup({ registered: ['claude', 'codex'] })
    await cmds.handle(inbound('/cc + cc'))
    expect(set).not.toHaveBeenCalled()
    expect(sentMessages[0]?.[1]).toContain('不能是同一个 provider')
  })

  it('/cc + foo rejects unknown peer with hint', async () => {
    const { cmds, set, sentMessages } = setup({ registered: ['claude', 'codex'] })
    await cmds.handle(inbound('/cc + foo'))
    expect(set).not.toHaveBeenCalled()
    expect(sentMessages[0]?.[1]).toContain('未知的 peer')
  })

  it('/cc + codex surfaces validation error when peer missing from registry', async () => {
    const sentMessages: Array<[string, string]> = []
    const sendMessage = vi.fn(async (chatId: string, text: string) => {
      sentMessages.push([chatId, text]); return { msgId: 'm' }
    })
    const cmds = makeModeCommands({
      coordinator: {
        getMode: () => ({ kind: 'solo', provider: 'claude' }),
        setMode: () => { throw new Error("mode 'primary_tool' requires both providers claude, codex; missing: codex") },
        cancel: () => false,
      },
      registry: {
        has: (id: string) => id === 'claude',
        get: () => ({ provider: {} as never, opts: { displayName: 'Claude', canResume: () => true } }),
        list: () => ['claude'],
      },
      defaultProviderId: 'claude',
      sendMessage: sendMessage as unknown as Parameters<typeof makeModeCommands>[0]['sendMessage'],
      setUserName: async () => {},
      getUserName: () => null,
      log: () => {},
    })
    await cmds.handle(inbound('/cc + codex'))
    expect(sentMessages[0]?.[1]).toContain('启用失败')
    expect(sentMessages[0]?.[1]).toContain('missing: codex')
  })

  it('returns false for unrecognised slash words like /health (lets admin-commands handle)', async () => {
    const { cmds, sendMessage } = setup()
    const consumed = await cmds.handle(inbound('/health'))
    expect(consumed).toBe(false)
    expect(sendMessage).not.toHaveBeenCalled()
  })

  // ── /name <nick> — user self-rename (PR2 #17) ────────────────────────

  it('/name <nick> sets the nickname and confirms', async () => {
    const { cmds, sentMessages, getStoredName } = setup()
    const consumed = await cmds.handle(inbound('/name Nate'))
    expect(consumed).toBe(true)
    expect(getStoredName()).toEqual({ chat: 'chat-1', name: 'Nate' })
    expect(sentMessages[0]?.[1]).toContain('Nate')
  })

  it('/name accepts multi-word nicknames', async () => {
    const { cmds, getStoredName } = setup()
    await cmds.handle(inbound('/name 张 三'))
    expect(getStoredName()).toEqual({ chat: 'chat-1', name: '张 三' })
  })

  it('/name with empty arg replies usage', async () => {
    const { cmds, sentMessages, getStoredName } = setup()
    const consumed = await cmds.handle(inbound('/name'))
    expect(consumed).toBe(true)
    expect(getStoredName()).toBeNull()
    expect(sentMessages[0]?.[1]).toMatch(/用法|usage/i)
  })
})
