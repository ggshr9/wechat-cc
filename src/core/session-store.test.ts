import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { makeSessionStore } from './session-store'

describe('SessionStore', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'session-store-'))
    file = join(dir, 'sessions.json')
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('starts empty', () => {
    const s = makeSessionStore(file, { debounceMs: 0 })
    expect(s.get('compass')).toBeNull()
    expect(s.all()).toEqual({})
  })

  it('set + get roundtrips', () => {
    const s = makeSessionStore(file, { debounceMs: 0 })
    s.set('compass', 'sid-123')
    const r = s.get('compass')
    expect(r?.session_id).toBe('sid-123')
    expect(typeof r?.last_used_at).toBe('string')
  })

  it('set with same session_id bumps last_used_at', async () => {
    const s = makeSessionStore(file, { debounceMs: 0 })
    s.set('compass', 'sid-1')
    const first = s.get('compass')!.last_used_at
    await new Promise(r => setTimeout(r, 10))
    s.set('compass', 'sid-1')
    const second = s.get('compass')!.last_used_at
    expect(Date.parse(second)).toBeGreaterThan(Date.parse(first))
  })

  it('set with different session_id replaces record', () => {
    const s = makeSessionStore(file, { debounceMs: 0 })
    s.set('compass', 'sid-1')
    s.set('compass', 'sid-2')
    expect(s.get('compass')?.session_id).toBe('sid-2')
  })

  it('delete removes record', () => {
    const s = makeSessionStore(file, { debounceMs: 0 })
    s.set('compass', 'sid-1')
    s.delete('compass')
    expect(s.get('compass')).toBeNull()
  })

  it('persists across instances', async () => {
    const s1 = makeSessionStore(file, { debounceMs: 0 })
    s1.set('compass', 'sid-persist')
    await s1.flush()

    const s2 = makeSessionStore(file, { debounceMs: 0 })
    expect(s2.get('compass')?.session_id).toBe('sid-persist')
  })

  it('survives corrupt JSON', () => {
    writeFileSync(file, '{not json')
    const s = makeSessionStore(file, { debounceMs: 0 })
    expect(s.get('x')).toBeNull()
    s.set('x', 'new')
    expect(s.get('x')?.session_id).toBe('new')
  })

  it('all() returns snapshot', () => {
    const s = makeSessionStore(file, { debounceMs: 0 })
    s.set('a', 'sa')
    s.set('b', 'sb')
    expect(Object.keys(s.all()).sort()).toEqual(['a', 'b'])
  })
})
