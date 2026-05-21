import { describe, expect, it } from 'vitest'
import { createProviderRegistry } from './provider-registry'
import { makeFakeSession } from './test-helpers'
import type { AgentProvider } from './agent-provider'

const stub: AgentProvider = {
  spawn: async () => makeFakeSession({
    events: [{ kind: 'result', sessionId: '_', numTurns: 1, durationMs: 0 }],
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

  describe('getCheapEval — provider-agnostic resolution (PR F)', () => {
    const stubWithCheap = (label: string): AgentProvider => ({
      spawn: async () => makeFakeSession({
        events: [{ kind: 'result', sessionId: '_', numTurns: 1, durationMs: 0 }],
      }),
      cheapEval: async () => label,
    })

    it('returns null when no registered provider implements cheapEval', () => {
      const r = createProviderRegistry()
      r.register('claude', stub, { displayName: 'Claude', canResume: () => true })
      expect(r.getCheapEval()).toBeNull()
    })

    it('returns cheapEval when registered provider implements it', async () => {
      const r = createProviderRegistry()
      r.register('codex', stubWithCheap('codex-text'), { displayName: 'Codex', canResume: () => true })
      const ce = r.getCheapEval()
      expect(ce).not.toBeNull()
      expect(await ce!('prompt')).toBe('codex-text')
    })

    it('prefers claude over codex when both registered', async () => {
      const r = createProviderRegistry()
      // Register codex FIRST to verify preference is not insertion-order.
      r.register('codex', stubWithCheap('codex-text'), { displayName: 'Codex', canResume: () => true })
      r.register('claude', stubWithCheap('claude-text'), { displayName: 'Claude', canResume: () => true })
      const ce = r.getCheapEval()
      expect(await ce!('prompt')).toBe('claude-text')
    })

    it('falls back to codex when claude registered without cheapEval', async () => {
      const r = createProviderRegistry()
      r.register('claude', stub, { displayName: 'Claude', canResume: () => true })
      r.register('codex', stubWithCheap('codex-text'), { displayName: 'Codex', canResume: () => true })
      const ce = r.getCheapEval()
      expect(await ce!('prompt')).toBe('codex-text')
    })

    it('falls back to any registered provider when neither claude nor codex registered', async () => {
      const r = createProviderRegistry()
      r.register('gemini', stubWithCheap('gemini-text'), { displayName: 'Gemini', canResume: () => true })
      const ce = r.getCheapEval()
      expect(await ce!('prompt')).toBe('gemini-text')
    })
  })
})
