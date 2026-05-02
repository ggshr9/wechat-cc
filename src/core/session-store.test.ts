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
    s.set('compass', 'sid-123', 'claude')
    const r = s.get('compass')
    expect(r?.session_id).toBe('sid-123')
    expect(typeof r?.last_used_at).toBe('string')
  })

  it('set with same session_id bumps last_used_at', async () => {
    const s = makeSessionStore(file, { debounceMs: 0 })
    s.set('compass', 'sid-1', 'claude')
    const first = s.get('compass')!.last_used_at
    await new Promise(r => setTimeout(r, 10))
    s.set('compass', 'sid-1', 'claude')
    const second = s.get('compass')!.last_used_at
    expect(Date.parse(second)).toBeGreaterThan(Date.parse(first))
  })

  it('set with different session_id replaces record', () => {
    const s = makeSessionStore(file, { debounceMs: 0 })
    s.set('compass', 'sid-1', 'claude')
    s.set('compass', 'sid-2', 'claude')
    expect(s.get('compass')?.session_id).toBe('sid-2')
  })

  it('delete removes record', () => {
    const s = makeSessionStore(file, { debounceMs: 0 })
    s.set('compass', 'sid-1', 'claude')
    s.delete('compass')
    expect(s.get('compass')).toBeNull()
  })

  it('persists across instances', async () => {
    const s1 = makeSessionStore(file, { debounceMs: 0 })
    s1.set('compass', 'sid-persist', 'claude')
    await s1.flush()

    const s2 = makeSessionStore(file, { debounceMs: 0 })
    expect(s2.get('compass')?.session_id).toBe('sid-persist')
  })

  it('survives corrupt JSON', () => {
    writeFileSync(file, '{not json')
    const s = makeSessionStore(file, { debounceMs: 0 })
    expect(s.get('x')).toBeNull()
    s.set('x', 'new', 'claude')
    expect(s.get('x')?.session_id).toBe('new')
  })

  it('all() returns snapshot', () => {
    const s = makeSessionStore(file, { debounceMs: 0 })
    s.set('a', 'sa', 'claude')
    s.set('b', 'sb', 'claude')
    expect(Object.keys(s.all()).sort()).toEqual(['a', 'b'])
  })

  it('setSummary updates summary + summary_updated_at; flush persists', async () => {
    const store = makeSessionStore(file, { debounceMs: 0 })
    store.set('compass', 's_abc', 'claude')
    store.setSummary('compass', '修了 ilink-glue')
    await store.flush()
    const fresh = makeSessionStore(file, { debounceMs: 0 })
    const rec = fresh.get('compass')
    expect(rec?.summary).toBe('修了 ilink-glue')
    expect(rec?.summary_updated_at).toBeDefined()
    expect(typeof rec?.summary_updated_at).toBe('string')
  })

  it('setSummary on unknown alias is a no-op', async () => {
    const store = makeSessionStore(file, { debounceMs: 0 })
    store.setSummary('nope', 'whatever')
    await store.flush()
    const fresh = makeSessionStore(file, { debounceMs: 0 })
    expect(fresh.get('nope')).toBeNull()
  })

  it('setSummary preserves existing session_id and last_used_at', async () => {
    const store = makeSessionStore(file, { debounceMs: 0 })
    store.set('compass', 's_abc', 'claude')
    const before = store.get('compass')
    store.setSummary('compass', 'a summary')
    const after = store.get('compass')
    expect(after?.session_id).toBe(before?.session_id)
    expect(after?.last_used_at).toBe(before?.last_used_at)
  })

  describe('provider tagging (RFC 03 P0)', () => {
    it('writes provider field on set, persists across reload', async () => {
      const s1 = makeSessionStore(file, { debounceMs: 0 })
      s1.set('compass', 'sid-claude', 'claude')
      s1.set('mobile', 'sid-codex', 'codex')
      await s1.flush()
      const s2 = makeSessionStore(file, { debounceMs: 0 })
      expect(s2.get('compass')?.provider).toBe('claude')
      expect(s2.get('mobile')?.provider).toBe('codex')
    })

    it('get() with expectedProvider returns null on mismatch', () => {
      const s = makeSessionStore(file, { debounceMs: 0 })
      s.set('compass', 'sid-claude', 'claude')
      expect(s.get('compass', 'claude')?.session_id).toBe('sid-claude')
      expect(s.get('compass', 'codex')).toBeNull()
    })

    it('get() without expectedProvider returns the record regardless of provider', () => {
      const s = makeSessionStore(file, { debounceMs: 0 })
      s.set('compass', 'sid-codex', 'codex')
      expect(s.get('compass')?.session_id).toBe('sid-codex')
    })

    it('records without provider field are treated as claude (legacy migration)', async () => {
      // Simulate v0.x JSON written before the field existed.
      writeFileSync(file, JSON.stringify({
        version: 1,
        sessions: { compass: { session_id: 'sid-legacy', last_used_at: new Date().toISOString() } },
      }))
      const s = makeSessionStore(file, { debounceMs: 0 })
      // No expectedProvider — record returned as-is, missing provider.
      expect(s.get('compass')?.session_id).toBe('sid-legacy')
      // expectedProvider='claude' — match (legacy default).
      expect(s.get('compass', 'claude')?.session_id).toBe('sid-legacy')
      // expectedProvider='codex' — mismatch.
      expect(s.get('compass', 'codex')).toBeNull()
    })

    it('updates provider in place on legacy record when next set() arrives', async () => {
      writeFileSync(file, JSON.stringify({
        version: 1,
        sessions: { compass: { session_id: 'sid-x', last_used_at: new Date().toISOString() } },
      }))
      const s = makeSessionStore(file, { debounceMs: 0 })
      s.set('compass', 'sid-x', 'claude')  // same session_id, write provider
      await s.flush()
      const fresh = makeSessionStore(file, { debounceMs: 0 })
      expect(fresh.get('compass')?.provider).toBe('claude')
    })

    it('replaces record when provider changes (different agent re-binds alias)', () => {
      const s = makeSessionStore(file, { debounceMs: 0 })
      s.set('compass', 'sid-claude', 'claude')
      s.set('compass', 'sid-codex', 'codex')
      const rec = s.get('compass')
      expect(rec?.session_id).toBe('sid-codex')
      expect(rec?.provider).toBe('codex')
    })
  })
})
