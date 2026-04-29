import { describe, expect, it } from 'vitest'
import { buildIntrospectPrompt, parseIntrospectResponse } from './introspect-prompt'

describe('buildIntrospectPrompt', () => {
  it('includes memory + recent observations + recent events sections', () => {
    const prompt = buildIntrospectPrompt({
      chatId: 'chat_x',
      memorySnapshot: 'profile.md:\n用户叫小丸子，喜欢吉他',
      recentObservations: [
        { ts: '2026-04-22T00:00:00Z', body: '你说过想学吉他' },
      ],
      recentEvents: [
        { ts: '2026-04-28T00:00:00Z', kind: 'cron_eval_skipped', reasoning: 'user in focus' },
      ],
      recentInboundMessages: ['今天好累'],
    })
    expect(prompt).toContain('小丸子')
    expect(prompt).toContain('你说过想学吉他')
    expect(prompt).toContain('user in focus')
    expect(prompt).toContain('今天好累')
    expect(prompt).toContain('JSON')
    expect(prompt.length).toBeLessThan(8000)
  })

  it('truncates oversized memory snapshots', () => {
    const big = 'x'.repeat(20000)
    const prompt = buildIntrospectPrompt({
      chatId: 'chat_x', memorySnapshot: big,
      recentObservations: [], recentEvents: [], recentInboundMessages: [],
    })
    expect(prompt.length).toBeLessThan(8000)
  })

  it('handles empty inputs gracefully', () => {
    const prompt = buildIntrospectPrompt({
      chatId: 'chat_x', memorySnapshot: '', recentObservations: [], recentEvents: [], recentInboundMessages: [],
    })
    expect(prompt).toContain('JSON')
    expect(prompt).not.toContain('undefined')
  })
})

describe('parseIntrospectResponse', () => {
  it('parses well-formed JSON', () => {
    const r = parseIntrospectResponse('{"write":true,"body":"observation","tone":"curious","reasoning":"r"}')
    expect(r).toEqual({ write: true, body: 'observation', tone: 'curious', reasoning: 'r' })
  })

  it('strips ```json code fences', () => {
    const r = parseIntrospectResponse('```json\n{"write":false,"reasoning":"nothing new"}\n```')
    expect(r).toEqual({ write: false, reasoning: 'nothing new' })
  })

  it('extracts JSON from prose-prefixed output', () => {
    const r = parseIntrospectResponse('Here is my decision: {"write":false,"reasoning":"r"} thanks.')
    expect(r?.reasoning).toBe('r')
  })

  it('returns null on completely malformed output', () => {
    expect(parseIntrospectResponse('not json at all')).toBeNull()
    expect(parseIntrospectResponse('')).toBeNull()
  })

  it('rejects when write=true but body is missing', () => {
    expect(parseIntrospectResponse('{"write":true,"reasoning":"r"}')).toBeNull()
  })

  it('rejects unknown tone values', () => {
    const r = parseIntrospectResponse('{"write":true,"body":"x","tone":"angry","reasoning":"r"}')
    expect(r).toBeNull()
  })
})
