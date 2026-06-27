import { describe, it, expect } from 'vitest'
import { buildOpeningPrompt, buildRebuttalPrompt, buildVerdictPrompt, parseConvergence } from './chatroom-conductor'

describe('chatroom-conductor', () => {
  const openings = [
    { speaker: 'claude' as const, text: '用 A 方案' },
    { speaker: 'codex' as const, text: '用 B 方案' },
  ]

  it('opening prompt frames the agent as a chatroom participant naming the peers (not solo)', () => {
    const p = buildOpeningPrompt('选 A 还是 B?', ['claude', 'codex'], 'claude')
    expect(p).toContain('codex')          // names the peer it's sitting with
    expect(p).toContain('选 A 还是 B?')    // the user's message
    expect(p).toMatch(/圆桌|chatroom|讨论/) // chatroom framing, not a solo turn
    expect(p).toContain('不是 solo')       // explicit: you are NOT alone
  })

  it('opening prompt names ALL other peers for an N>2 panel', () => {
    const p = buildOpeningPrompt('q', ['claude', 'codex', 'gemini'], 'claude')
    expect(p).toContain('codex')
    expect(p).toContain('gemini')
  })

  it('rebuttal prompt gives self the OTHERS full openings and asks for pointed engagement', () => {
    const p = buildRebuttalPrompt('选 A 还是 B?', openings, 'claude')
    expect(p).toContain('用 B 方案')        // sees the other's actual text
    expect(p).not.toContain('用 A 方案')     // not fed its own opening back
    expect(p).toMatch(/错了|反例|证据|角度/) // told to engage substantively, not just restate
  })

  it('rebuttal prompt forbids homogeneous/redundant cross-talk (only NEW substance)', () => {
    const p = buildRebuttalPrompt('选 A 还是 B?', openings, 'claude')
    expect(p).toMatch(/新东西|别重复|新内容/) // must add new substance, not echo
    expect(p).toMatch(/附和|凑字数/)          // explicitly bans padding / agreeable filler
  })

  it('verdict prompt asks for a stance + consensus/disagreement/recommendation, not a transcript', () => {
    const p = buildVerdictPrompt('选 A 还是 B?', openings, openings)
    expect(p).toMatch(/共识/)
    expect(p).toMatch(/分歧/)
    expect(p).toMatch(/结论|建议/)
    expect(p).toMatch(/🎯/)                  // verdict marker
  })

  it('parseConvergence tolerates ```json fences', () => {
    expect(parseConvergence('```json\n{"converged":true}\n```')).toEqual({ converged: true })
  })

  it('parseConvergence extracts fields from a TRUNCATED output (the live parse-fail case)', () => {
    // moderator-style truncation: cut off mid-string, no closing brace
    const raw = '{"converged": false, "disagreement": "A 方案的并发安全性没说清，B 说的'
    expect(parseConvergence(raw)).toEqual({ converged: false, disagreement: expect.any(String) })
  })

  it('parseConvergence on total garbage defaults to converged=true (stop, never loop)', () => {
    expect(parseConvergence('更')).toEqual({ converged: true })
  })
})
