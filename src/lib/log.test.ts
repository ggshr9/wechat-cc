import { describe, it, expect } from 'vitest'
import { formatHumanLine, formatJsonRecord } from './log'

describe('formatHumanLine', () => {
  it('builds the legacy `<ISO> [TAG] <msg>` shape parsed by src/cli/logs.ts', () => {
    const line = formatHumanLine('2026-05-02T07:00:00.000Z', 'BOOT', 'started pid=42')
    expect(line).toBe('2026-05-02T07:00:00.000Z [BOOT] started pid=42\n')
  })

  it('preserves message content verbatim (no escaping)', () => {
    const line = formatHumanLine('2026-05-02T07:00:00.000Z', 'TEST', 'has "quotes" and a / slash')
    expect(line).toBe('2026-05-02T07:00:00.000Z [TEST] has "quotes" and a / slash\n')
  })
})

describe('formatJsonRecord', () => {
  it('emits one JSON object per line with ts/tag/msg + fields merged', () => {
    const line = formatJsonRecord('2026-05-02T07:00:00.000Z', 'COORDINATOR', 'solo dispatch', {
      event: 'dispatch_solo',
      chat_id: 'c1',
      provider: 'claude',
    })
    expect(line).not.toBeNull()
    expect(line!.endsWith('\n')).toBe(true)
    const parsed = JSON.parse(line!)
    expect(parsed).toEqual({
      ts: '2026-05-02T07:00:00.000Z',
      tag: 'COORDINATOR',
      msg: 'solo dispatch',
      event: 'dispatch_solo',
      chat_id: 'c1',
      provider: 'claude',
    })
  })

  it('field collision: caller-supplied keys win over the canonical set', () => {
    // Documented behaviour — caller can override `ts`/`tag`/`msg` if needed
    // (e.g. backfilling historical events). Spread order makes this explicit.
    const line = formatJsonRecord('2026-05-02T07:00:00.000Z', 'TAG', 'msg', { tag: 'OVERRIDDEN' })
    const parsed = JSON.parse(line!)
    expect(parsed.tag).toBe('OVERRIDDEN')
  })

  it('returns null on circular references (never crashes the caller)', () => {
    const circular: Record<string, unknown> = { name: 'x' }
    circular.self = circular
    const line = formatJsonRecord('2026-05-02T07:00:00.000Z', 'TAG', 'msg', circular)
    expect(line).toBeNull()
  })
})
