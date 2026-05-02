import { describe, expect, it } from 'vitest'
import { createProviderRegistry } from './provider-registry'
import type { AgentProvider } from './agent-provider'

const stub: AgentProvider = {
  spawn: async () => ({
    dispatch: async () => ({ assistantText: [], replyToolCalled: false }),
    close: async () => {},
    onAssistantText: () => () => {},
    onResult: () => () => {},
  }),
}

describe('ProviderRegistry', () => {
  it('starts empty', () => {
    const r = createProviderRegistry()
    expect(r.list()).toEqual([])
    expect(r.has('claude')).toBe(false)
    expect(r.get('claude')).toBeNull()
  })

  it('register + get + has + list', () => {
    const r = createProviderRegistry()
    r.register('claude', stub, { displayName: 'Claude', canResume: () => true })
    expect(r.has('claude')).toBe(true)
    expect(r.list()).toEqual(['claude'])
    const e = r.get('claude')
    expect(e?.provider).toBe(stub)
    expect(e?.opts.displayName).toBe('Claude')
    expect(e?.opts.canResume('/cwd', 'sid')).toBe(true)
  })

  it('throws on duplicate id', () => {
    const r = createProviderRegistry()
    r.register('claude', stub, { displayName: 'Claude', canResume: () => true })
    expect(() => r.register('claude', stub, { displayName: 'Claude2', canResume: () => true }))
      .toThrow(/already registered: claude/)
  })

  it('two providers coexist', () => {
    const r = createProviderRegistry()
    r.register('claude', stub, { displayName: 'Claude', canResume: () => true })
    r.register('codex', stub, { displayName: 'Codex', canResume: () => false })
    expect(r.list().sort()).toEqual(['claude', 'codex'])
    expect(r.get('codex')?.opts.displayName).toBe('Codex')
    expect(r.get('codex')?.opts.canResume('/x', 'y')).toBe(false)
  })

  it('open ProviderId — accepts arbitrary string ids (RFC 03 §3.3)', () => {
    const r = createProviderRegistry()
    r.register('gemini-experimental', stub, { displayName: 'Gemini', canResume: () => true })
    expect(r.has('gemini-experimental')).toBe(true)
  })
})
