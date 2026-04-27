import { describe, expect, it } from 'vitest'
import { makeOnboardingHandler, type OnboardingDeps } from './onboarding'

function makeDeps(opts: { knownUsers?: Set<string>; nowStart?: number } = {}): {
  deps: OnboardingDeps
  sent: string[]
  saved: Array<{ chatId: string; name: string }>
  setNow: (ms: number) => void
} {
  const known = opts.knownUsers ?? new Set<string>()
  let nowMs = opts.nowStart ?? 1_000_000
  const sent: string[] = []
  const saved: Array<{ chatId: string; name: string }> = []
  const deps: OnboardingDeps = {
    isKnownUser: (uid) => known.has(uid),
    setUserName: async (chatId, name) => { saved.push({ chatId, name }); known.add(chatId) },
    sendMessage: async (_chatId, text) => { sent.push(text) },
    log: () => {},
    now: () => nowMs,
  }
  return { deps, sent, saved, setNow: (ms: number) => { nowMs = ms } }
}

describe('makeOnboardingHandler', () => {
  it('passes through messages from already-known users (no consume, no send)', async () => {
    const { deps, sent } = makeDeps({ knownUsers: new Set(['u1']) })
    const handler = makeOnboardingHandler(deps)
    const consumed = await handler.handle({ userId: 'u1', chatId: 'u1', text: 'hello' })
    expect(consumed).toBe(false)
    expect(sent).toHaveLength(0)
  })

  it('first contact → consumes message + sends greeting', async () => {
    const { deps, sent } = makeDeps()
    const handler = makeOnboardingHandler(deps)
    const consumed = await handler.handle({ userId: 'u-new', chatId: 'u-new', text: '帮我查个东西' })
    expect(consumed).toBe(true)
    expect(sent[0]).toMatch(/你好/)
    expect(sent[0]).toMatch(/昵称/)
  })

  it('second message (within window) → saves nickname + confirms', async () => {
    const { deps, sent, saved } = makeDeps()
    const handler = makeOnboardingHandler(deps)
    await handler.handle({ userId: 'u', chatId: 'u', text: 'first message' })
    const consumed = await handler.handle({ userId: 'u', chatId: 'u', text: '丸子' })
    expect(consumed).toBe(true)
    expect(saved).toEqual([{ chatId: 'u', name: '丸子' }])
    expect(sent[1]).toMatch(/好的，丸子/)
  })

  it('rejects empty / whitespace-only nicknames', async () => {
    const { deps, sent, saved } = makeDeps()
    const handler = makeOnboardingHandler(deps)
    await handler.handle({ userId: 'u', chatId: 'u', text: 'hi' })
    await handler.handle({ userId: 'u', chatId: 'u', text: '   ' })
    expect(saved).toHaveLength(0)
    expect(sent[1]).toMatch(/不能为空/)
  })

  it('rejects nicknames over the length cap', async () => {
    const { deps, sent, saved } = makeDeps()
    const handler = makeOnboardingHandler(deps)
    await handler.handle({ userId: 'u', chatId: 'u', text: 'hi' })
    await handler.handle({ userId: 'u', chatId: 'u', text: 'a'.repeat(50) })
    expect(saved).toHaveLength(0)
    expect(sent[1]).toMatch(/太长/)
  })

  it('rejects nicknames with disallowed chars', async () => {
    const { deps, sent, saved } = makeDeps()
    const handler = makeOnboardingHandler(deps)
    await handler.handle({ userId: 'u', chatId: 'u', text: 'hi' })
    await handler.handle({ userId: 'u', chatId: 'u', text: 'hax<script>' })
    expect(saved).toHaveLength(0)
    expect(sent[1]).toMatch(/只支持/)
  })

  it('after the 30-min window, treats next message as first contact again (re-greet)', async () => {
    const { deps, sent, setNow } = makeDeps({ nowStart: 1_000_000 })
    const handler = makeOnboardingHandler(deps)
    await handler.handle({ userId: 'u', chatId: 'u', text: 'hi' })
    setNow(1_000_000 + 31 * 60_000)  // 31 min later
    const consumed = await handler.handle({ userId: 'u', chatId: 'u', text: '丸子' })
    expect(consumed).toBe(true)
    // Second message after timeout = a fresh greeting, not a name accept.
    expect(sent[1]).toMatch(/你好/)
  })

  it('accepts a valid nickname containing CJK + hyphen + alphanumeric', async () => {
    const { deps, saved } = makeDeps()
    const handler = makeOnboardingHandler(deps)
    await handler.handle({ userId: 'u', chatId: 'u', text: 'hi' })
    await handler.handle({ userId: 'u', chatId: 'u', text: '丸子-2' })
    expect(saved[0]!.name).toBe('丸子-2')
  })
})
