import { describe, it, expect } from 'vitest'
import { botNameForMode } from './bot-name'

describe('botNameForMode', () => {
  it('solo+claude → cc', () => {
    expect(botNameForMode({ kind: 'solo', provider: 'claude' })).toBe('cc')
  })

  it('solo+codex → codex', () => {
    expect(botNameForMode({ kind: 'solo', provider: 'codex' })).toBe('codex')
  })

  it('primary_tool primary=claude → cc', () => {
    expect(botNameForMode({ kind: 'primary_tool', primary: 'claude' })).toBe('cc')
  })

  it('primary_tool primary=codex → codex', () => {
    expect(botNameForMode({ kind: 'primary_tool', primary: 'codex' })).toBe('codex')
  })

  it('parallel → cc + codex', () => {
    expect(botNameForMode({ kind: 'parallel' })).toBe('cc + codex')
  })

  it('chatroom → cc + codex', () => {
    expect(botNameForMode({ kind: 'chatroom' })).toBe('cc + codex')
  })

  it('unknown provider id passes through (defensive)', () => {
    expect(botNameForMode({ kind: 'solo', provider: 'gemini' as never })).toBe('gemini')
  })
})
