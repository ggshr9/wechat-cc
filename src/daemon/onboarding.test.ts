import { describe, expect, it } from 'vitest'
import { makeOnboardingHandler, type OnboardingDeps } from './onboarding'
import type { InboundMsg } from '../core/prompt-format'

function mkMsg(opts: { chatId?: string; userId?: string; text: string }): InboundMsg {
  return {
    chatId: opts.chatId ?? 'u',
    userId: opts.userId ?? 'u',
    userName: undefined,
    accountId: 'a1',
    text: opts.text,
    msgType: 'text',
    createTimeMs: 0,
  }
}

function makeDeps(opts: { knownUsers?: Set<string>; nowStart?: number } = {}): {
  deps: OnboardingDeps
  sent: string[]
  saved: Array<{ chatId: string; name: string }>
  dispatched: InboundMsg[]
  setNow: (ms: number) => void
} {
  const known = opts.knownUsers ?? new Set<string>()
  let nowMs = opts.nowStart ?? 1_000_000
  const sent: string[] = []
  const saved: Array<{ chatId: string; name: string }> = []
  const dispatched: InboundMsg[] = []
  const deps: OnboardingDeps = {
    isKnownUser: (uid) => known.has(uid),
    setUserName: async (chatId, name) => { saved.push({ chatId, name }); known.add(chatId) },
    sendMessage: async (_chatId, text) => { sent.push(text) },
    botName: () => 'cc',
    dispatchInbound: async (msg) => { dispatched.push(msg) },
    log: () => {},
    now: () => nowMs,
  }
  return { deps, sent, saved, dispatched, setNow: (ms: number) => { nowMs = ms } }
}

describe('makeOnboardingHandler', () => {
  it('passes through messages from already-known users (no consume, no send)', async () => {
    const { deps, sent } = makeDeps({ knownUsers: new Set(['u1']) })
    const handler = makeOnboardingHandler(deps)
    const consumed = await handler.handle(mkMsg({ userId: 'u1', chatId: 'u1', text: 'hello' }))
    expect(consumed).toBe(false)
    expect(sent).toHaveLength(0)
  })

  it('first contact → consumes message + sends greeting', async () => {
    const { deps, sent } = makeDeps()
    const handler = makeOnboardingHandler(deps)
    const consumed = await handler.handle(mkMsg({ userId: 'u-new', chatId: 'u-new', text: '帮我查个东西' }))
    expect(consumed).toBe(true)
    expect(sent[0]).toMatch(/你好/)
    expect(sent[0]).toMatch(/称呼你/)
    // Mode-aware bot name should appear in the greeting.
    expect(sent[0]).toMatch(/cc/)
  })

  it('second message (within window) → saves nickname + confirms', async () => {
    const { deps, sent, saved } = makeDeps()
    const handler = makeOnboardingHandler(deps)
    await handler.handle(mkMsg({ text: 'first message' }))
    const consumed = await handler.handle(mkMsg({ text: '丸子' }))
    expect(consumed).toBe(true)
    expect(saved).toEqual([{ chatId: 'u', name: '丸子' }])
    expect(sent[1]).toMatch(/好的 丸子/)
    expect(sent[1]).toMatch(/刚才你说「first message」/)
  })

  it('rejects empty / whitespace-only nicknames', async () => {
    const { deps, sent, saved } = makeDeps()
    const handler = makeOnboardingHandler(deps)
    await handler.handle(mkMsg({ text: 'hi' }))
    await handler.handle(mkMsg({ text: '   ' }))
    expect(saved).toHaveLength(0)
    expect(sent[1]).toMatch(/不能为空/)
  })

  it('rejects nicknames over the length cap', async () => {
    const { deps, sent, saved } = makeDeps()
    const handler = makeOnboardingHandler(deps)
    await handler.handle(mkMsg({ text: 'hi' }))
    await handler.handle(mkMsg({ text: 'a'.repeat(50) }))
    expect(saved).toHaveLength(0)
    expect(sent[1]).toMatch(/太长/)
  })

  it('rejects nicknames with disallowed chars', async () => {
    const { deps, sent, saved } = makeDeps()
    const handler = makeOnboardingHandler(deps)
    await handler.handle(mkMsg({ text: 'hi' }))
    await handler.handle(mkMsg({ text: 'hax<script>' }))
    expect(saved).toHaveLength(0)
    expect(sent[1]).toMatch(/只支持/)
  })

  it('after the 30-min window, treats next message as first contact again (re-greet)', async () => {
    const { deps, sent, setNow } = makeDeps({ nowStart: 1_000_000 })
    const handler = makeOnboardingHandler(deps)
    await handler.handle(mkMsg({ text: 'hi' }))
    setNow(1_000_000 + 31 * 60_000)  // 31 min later
    const consumed = await handler.handle(mkMsg({ text: '丸子' }))
    expect(consumed).toBe(true)
    // Second message after timeout = a fresh greeting, not a name accept.
    expect(sent[1]).toMatch(/你好/)
  })

  it('accepts a valid nickname containing CJK + hyphen + alphanumeric', async () => {
    const { deps, saved } = makeDeps()
    const handler = makeOnboardingHandler(deps)
    await handler.handle(mkMsg({ text: 'hi' }))
    await handler.handle(mkMsg({ text: '丸子-2' }))
    expect(saved[0]!.name).toBe('丸子-2')
  })

  it('drops a duplicate inbound with the same trigger text within 1.5s window', async () => {
    let nameSet: string | null = null
    const sent: string[] = []
    let clock = 1_000_000

    const handler = makeOnboardingHandler({
      isKnownUser: () => false,
      setUserName: async (_chat, name) => { nameSet = name },
      sendMessage: async (_chat, text) => { sent.push(text) },
      botName: () => 'cc',
      dispatchInbound: async () => {},
      log: () => {},
      now: () => clock,
    })

    const r1 = await handler.handle(mkMsg({ userId: 'u1', chatId: 'c1', text: '你好' }))
    expect(r1).toBe(true)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('称呼你')

    clock += 100
    const r2 = await handler.handle(mkMsg({ userId: 'u1', chatId: 'c1', text: '你好' }))
    expect(r2).toBe(true)
    expect(nameSet).toBeNull()
    expect(sent).toHaveLength(1)
  })

  it('still accepts a different text as nickname within the 1.5s window', async () => {
    let nameSet: string | null = null
    const sent: string[] = []
    let clock = 1_000_000

    const handler = makeOnboardingHandler({
      isKnownUser: () => false,
      setUserName: async (_chat, name) => { nameSet = name },
      sendMessage: async (_chat, text) => { sent.push(text) },
      botName: () => 'cc',
      dispatchInbound: async () => {},
      log: () => {},
      now: () => clock,
    })

    await handler.handle(mkMsg({ userId: 'u1', chatId: 'c1', text: '你好' }))
    clock += 100
    const r2 = await handler.handle(mkMsg({ userId: 'u1', chatId: 'c1', text: 'Nate' }))
    expect(r2).toBe(true)
    expect(nameSet).toBe('Nate')
  })

  it('echoes + dispatches the first message after nickname is captured', async () => {
    const dispatched: InboundMsg[] = []
    const sent: string[] = []
    const handler = makeOnboardingHandler({
      isKnownUser: () => false,
      setUserName: async () => {},
      sendMessage: async (_c, t) => { sent.push(t) },
      botName: () => 'cc',
      dispatchInbound: async (msg) => { dispatched.push(msg) },
      log: () => {},
    })

    await handler.handle({
      chatId: 'c1', userId: 'u1', userName: undefined, accountId: 'a1',
      text: '为什么天空是蓝色的', msgType: 'text', createTimeMs: 0,
    })
    await handler.handle({
      chatId: 'c1', userId: 'u1', userName: undefined, accountId: 'a1',
      text: 'Nate', msgType: 'text', createTimeMs: 0,
    })

    // Allow the void-dispatch promise to flush.
    await new Promise(r => setTimeout(r, 10))

    expect(dispatched).toHaveLength(1)
    expect(dispatched[0]?.text).toBe('为什么天空是蓝色的')
    expect(sent.at(-1)).toContain('刚才你说「为什么天空是蓝色的」')
  })
})
