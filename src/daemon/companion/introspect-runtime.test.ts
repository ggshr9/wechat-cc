import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeIntrospectAgent, resolveIntrospectChatId } from './introspect-runtime'
import { makeEventsStore } from '../events/store'
import { makeObservationsStore } from '../observations/store'

function makeStores(stateDir: string, chatId: string) {
  const memoryRoot = join(stateDir, 'memory')
  return {
    events: makeEventsStore(memoryRoot, chatId),
    observations: makeObservationsStore(memoryRoot, chatId),
  }
}

describe('makeIntrospectAgent (real SDK)', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'intro-rt-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('builds context, calls injected sdkEval, parses response', async () => {
    const { events, observations } = makeStores(dir, 'chat_x')
    const sdkEval = vi.fn(async (_prompt: string) =>
      JSON.stringify({ write: true, body: '观察一条', tone: 'curious', reasoning: 'r' })
    )
    const agent = makeIntrospectAgent({
      chatId: 'chat_x', events, observations,
      memorySnapshot: async () => 'profile.md: hello',
      recentInboundMessages: async () => ['今天累'],
      sdkEval,
    })
    const result = await agent.runIntrospect()
    expect(sdkEval).toHaveBeenCalledOnce()
    expect(result).toEqual({ write: true, body: '观察一条', tone: 'curious', reasoning: 'r' })
  })

  it('returns write=false on SDK error (does not throw)', async () => {
    const { events, observations } = makeStores(dir, 'chat_x')
    const sdkEval = vi.fn(async () => { throw new Error('timeout') })
    const agent = makeIntrospectAgent({
      chatId: 'chat_x', events, observations,
      memorySnapshot: async () => '',
      recentInboundMessages: async () => [],
      sdkEval,
    })
    const result = await agent.runIntrospect()
    expect(result.write).toBe(false)
    expect(result.reasoning).toContain('SDK error')
    expect(result.reasoning).toContain('timeout')
  })

  it('returns write=false on malformed SDK output (parse failure)', async () => {
    const { events, observations } = makeStores(dir, 'chat_x')
    const sdkEval = vi.fn(async () => 'not json at all')
    const agent = makeIntrospectAgent({
      chatId: 'chat_x', events, observations,
      memorySnapshot: async () => '',
      recentInboundMessages: async () => [],
      sdkEval,
    })
    const result = await agent.runIntrospect()
    expect(result.write).toBe(false)
    expect(result.reasoning).toContain('parse failed')
  })

  it('forwards SDK output verbatim when valid JSON', async () => {
    const { events, observations } = makeStores(dir, 'chat_x')
    const sdkEval = vi.fn(async () =>
      '```json\n{"write":false,"reasoning":"nothing new"}\n```'
    )
    const agent = makeIntrospectAgent({
      chatId: 'chat_x', events, observations,
      memorySnapshot: async () => '',
      recentInboundMessages: async () => [],
      sdkEval,
    })
    const result = await agent.runIntrospect()
    expect(result).toEqual({ write: false, reasoning: 'nothing new' })
  })
})

describe('resolveIntrospectChatId', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'introspect-rt-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('returns null when no companion config exists', () => {
    expect(resolveIntrospectChatId(dir)).toBeNull()
  })

  it('returns null when default_chat_id is not set', () => {
    const cfgDir = join(dir, 'companion')
    mkdirSync(cfgDir, { recursive: true })
    writeFileSync(join(cfgDir, 'config.json'), JSON.stringify({ enabled: true }))
    expect(resolveIntrospectChatId(dir)).toBeNull()
  })

  it('returns the configured default_chat_id', () => {
    const cfgDir = join(dir, 'companion')
    mkdirSync(cfgDir, { recursive: true })
    writeFileSync(join(cfgDir, 'config.json'), JSON.stringify({ enabled: true, default_chat_id: 'chat_x' }))
    expect(resolveIntrospectChatId(dir)).toBe('chat_x')
  })
})
