import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clampTail, parseLine, tailLog } from './logs'

let stateDir: string

beforeEach(() => { stateDir = mkdtempSync(join(tmpdir(), 'wechat-cc-logs-')) })
afterEach(() => { rmSync(stateDir, { recursive: true, force: true }) })

describe('parseLine', () => {
  it('extracts timestamp + tag + message from a well-formed entry', () => {
    const r = parseLine('2026-04-28T07:22:21.184Z [SESSION_EXPIRED] bot abc — stopping loop')
    expect(r).toEqual({
      timestamp: '2026-04-28T07:22:21.184Z',
      tag: 'SESSION_EXPIRED',
      message: 'bot abc — stopping loop',
      raw: '2026-04-28T07:22:21.184Z [SESSION_EXPIRED] bot abc — stopping loop',
    })
  })

  it('preserves trailing/embedded whitespace in message', () => {
    expect(parseLine('2026-04-28T07:22:21.184Z [POLL]  doubled   spaces').message).toBe(' doubled   spaces')
  })

  it('handles tag with multiple words / hyphens', () => {
    const r = parseLine('2026-04-28T07:22:21.184Z [SESSION RESUME] alias=compass')
    expect(r.tag).toBe('SESSION RESUME')
    expect(r.message).toBe('alias=compass')
  })

  it('falls back to raw when line lacks the expected format', () => {
    const raw = 'plain stderr noise without bracket tag'
    expect(parseLine(raw)).toEqual({ timestamp: '', tag: '', message: raw, raw })
  })

  it('falls back to raw for stack-trace continuation lines', () => {
    const raw = '    at Object.<anonymous> (/path/to/file.js:42:15)'
    expect(parseLine(raw)).toEqual({ timestamp: '', tag: '', message: raw, raw })
  })
})

describe('clampTail', () => {
  it('clamps to MIN (1) for zero / negative / NaN', () => {
    expect(clampTail(0)).toBe(1)
    expect(clampTail(-5)).toBe(1)
    expect(clampTail(NaN)).toBe(1)
  })

  it('clamps to MAX (5000) for huge values', () => {
    expect(clampTail(10000)).toBe(5000)
    expect(clampTail(Infinity)).toBe(5000)
  })

  it('floors fractional values', () => {
    expect(clampTail(50.7)).toBe(50)
  })

  it('passes through valid values', () => {
    expect(clampTail(50)).toBe(50)
    expect(clampTail(1)).toBe(1)
    expect(clampTail(5000)).toBe(5000)
  })
})

describe('tailLog', () => {
  it('returns empty entries when log file does not exist (fresh install)', () => {
    const r = tailLog(stateDir, 50)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.entries).toEqual([])
    expect(r.totalLines).toBe(0)
  })

  it('returns last N entries in file order', () => {
    const lines = Array.from({ length: 10 }, (_, i) =>
      `2026-04-28T07:22:${String(20 + i).padStart(2, '0')}.000Z [POLL] tick ${i}`,
    )
    writeFileSync(join(stateDir, 'channel.log'), lines.join('\n') + '\n')
    const r = tailLog(stateDir, 3)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.totalLines).toBe(10)
    expect(r.entries.map(e => e.message)).toEqual(['tick 7', 'tick 8', 'tick 9'])
  })

  it('returns all entries when N >= totalLines', () => {
    writeFileSync(join(stateDir, 'channel.log'), '2026-04-28T07:22:21.184Z [POLL] only one\n')
    const r = tailLog(stateDir, 100)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.entries).toHaveLength(1)
  })

  it('skips blank lines (caused by trailing newline split)', () => {
    writeFileSync(join(stateDir, 'channel.log'), 'real\n\n\n')
    const r = tailLog(stateDir, 50)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.entries).toHaveLength(1)
    expect(r.entries[0]!.raw).toBe('real')
  })

  it('parses each tail entry through parseLine (mixed well-formed + plain)', () => {
    const content = [
      '2026-04-28T07:22:21.184Z [SESSION_EXPIRED] alpha',
      '   stack continuation',
      '2026-04-28T07:22:22.000Z [POLL] beta',
    ].join('\n') + '\n'
    writeFileSync(join(stateDir, 'channel.log'), content)
    const r = tailLog(stateDir, 50)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.entries[0]!.tag).toBe('SESSION_EXPIRED')
    expect(r.entries[1]!.tag).toBe('')
    expect(r.entries[1]!.raw).toBe('   stack continuation')
    expect(r.entries[2]!.tag).toBe('POLL')
  })

  it('clamps N within tailLog the same way clampTail does', () => {
    writeFileSync(join(stateDir, 'channel.log'), Array.from({ length: 6000 }, (_, i) => `line-${i}`).join('\n') + '\n')
    const r = tailLog(stateDir, 99999)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.entries.length).toBe(5000)  // MAX_TAIL
    expect(r.entries[0]!.raw).toBe('line-1000')  // tail of 5000 from 6000 starts at index 1000
  })
})
