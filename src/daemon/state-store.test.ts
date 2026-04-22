import { describe, it, expect, beforeEach, vi } from 'vitest'
import { makeStateStore } from './state-store'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function freshPath(): string {
  const d = mkdtempSync(join(tmpdir(), 'wcc-store-'))
  return join(d, 'ctx.json')
}

describe('state-store', () => {
  beforeEach(() => { vi.useRealTimers() })

  it('returns undefined for unset keys when file missing', () => {
    const s = makeStateStore(freshPath(), { debounceMs: 1000 })
    expect(s.get('x')).toBeUndefined()
    expect(s.all()).toEqual({})
  })

  it('loads existing JSON file on construction', () => {
    const p = freshPath()
    writeFileSync(p, JSON.stringify({ chat1: 'tokA', chat2: 'tokB' }))
    const s = makeStateStore(p, { debounceMs: 1000 })
    expect(s.get('chat1')).toBe('tokA')
    expect(s.all()).toEqual({ chat1: 'tokA', chat2: 'tokB' })
  })

  it('set() is visible via get() immediately', () => {
    const s = makeStateStore(freshPath(), { debounceMs: 1000 })
    s.set('a', 'v1')
    expect(s.get('a')).toBe('v1')
  })

  it('does not write to disk until debounce expires', async () => {
    vi.useFakeTimers()
    const p = freshPath()
    const s = makeStateStore(p, { debounceMs: 1000 })
    s.set('a', 'v1')
    expect(existsSync(p)).toBe(false)
    vi.advanceTimersByTime(500)
    expect(existsSync(p)).toBe(false)
    vi.advanceTimersByTime(501)
    // timer scheduled — let the microtask queue drain
    await Promise.resolve()
    expect(existsSync(p)).toBe(true)
    expect(JSON.parse(readFileSync(p, 'utf8'))).toEqual({ a: 'v1' })
  })

  it('flush() writes immediately and clears pending timer', async () => {
    const p = freshPath()
    const s = makeStateStore(p, { debounceMs: 10_000 })
    s.set('a', 'v1')
    expect(existsSync(p)).toBe(false)
    await s.flush()
    expect(existsSync(p)).toBe(true)
    expect(JSON.parse(readFileSync(p, 'utf8'))).toEqual({ a: 'v1' })
  })

  it('flush() is a no-op when nothing is pending', async () => {
    const p = freshPath()
    const s = makeStateStore(p, { debounceMs: 1000 })
    await s.flush()
    expect(existsSync(p)).toBe(false)  // nothing to write
  })

  it('delete() removes a key and marks dirty', async () => {
    const p = freshPath()
    writeFileSync(p, JSON.stringify({ a: 'v1', b: 'v2' }))
    const s = makeStateStore(p, { debounceMs: 1000 })
    s.delete('a')
    expect(s.get('a')).toBeUndefined()
    await s.flush()
    expect(JSON.parse(readFileSync(p, 'utf8'))).toEqual({ b: 'v2' })
  })

  it('writes atomically (creates parent dir if missing)', async () => {
    const d = mkdtempSync(join(tmpdir(), 'wcc-store-'))
    const nested = join(d, 'sub', 'deep', 'ctx.json')
    const s = makeStateStore(nested, { debounceMs: 1000 })
    s.set('a', 'v1')
    await s.flush()
    expect(JSON.parse(readFileSync(nested, 'utf8'))).toEqual({ a: 'v1' })
  })
})
