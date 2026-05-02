import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { makeSessionStore } from './session-store'
import { openTestDb, openDb, type Db } from '../lib/db'

describe('SessionStore', () => {
  let dir: string
  let db: Db

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'session-store-'))
    db = openTestDb()
  })
  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('starts empty', () => {
    const s = makeSessionStore(db)
    expect(s.get('compass')).toBeNull()
    expect(s.all()).toEqual({})
  })

  it('set + get roundtrips', () => {
    const s = makeSessionStore(db)
    s.set('compass', 'sid-123', 'claude')
    const r = s.get('compass')
    expect(r?.session_id).toBe('sid-123')
    expect(typeof r?.last_used_at).toBe('string')
  })

  it('set with same session_id bumps last_used_at', async () => {
    const s = makeSessionStore(db)
    s.set('compass', 'sid-1', 'claude')
    const first = s.get('compass')!.last_used_at
    await new Promise(r => setTimeout(r, 10))
    s.set('compass', 'sid-1', 'claude')
    const second = s.get('compass')!.last_used_at
    expect(Date.parse(second)).toBeGreaterThan(Date.parse(first))
  })

  it('set with different session_id (same provider) replaces record', () => {
    const s = makeSessionStore(db)
    s.set('compass', 'sid-1', 'claude')
    s.set('compass', 'sid-2', 'claude')
    expect(s.get('compass')?.session_id).toBe('sid-2')
  })

  it('delete removes record', () => {
    const s = makeSessionStore(db)
    s.set('compass', 'sid-1', 'claude')
    s.delete('compass')
    expect(s.get('compass')).toBeNull()
  })

  it('persists across instances (same db file)', async () => {
    const path = join(dir, 'wechat-cc.db')
    const d1 = openDb({ path })
    try {
      const s1 = makeSessionStore(d1)
      s1.set('compass', 'sid-persist', 'claude')
      await s1.flush()
    } finally { d1.close() }

    const d2 = openDb({ path })
    try {
      const s2 = makeSessionStore(d2)
      expect(s2.get('compass')?.session_id).toBe('sid-persist')
    } finally { d2.close() }
  })

  it('all() returns snapshot', () => {
    const s = makeSessionStore(db)
    s.set('a', 'sa', 'claude')
    s.set('b', 'sb', 'claude')
    expect(Object.keys(s.all()).sort()).toEqual(['a', 'b'])
  })

  it('setSummary updates summary + summary_updated_at; persists across re-open', async () => {
    const path = join(dir, 'wechat-cc.db')
    const d1 = openDb({ path })
    try {
      const store = makeSessionStore(d1)
      store.set('compass', 's_abc', 'claude')
      store.setSummary('compass', '修了 ilink-glue')
      await store.flush()
    } finally { d1.close() }

    const d2 = openDb({ path })
    try {
      const fresh = makeSessionStore(d2)
      const rec = fresh.get('compass')
      expect(rec?.summary).toBe('修了 ilink-glue')
      expect(rec?.summary_updated_at).toBeDefined()
      expect(typeof rec?.summary_updated_at).toBe('string')
    } finally { d2.close() }
  })

  it('setSummary on unknown alias is a no-op', async () => {
    const store = makeSessionStore(db)
    store.setSummary('nope', 'whatever')
    await store.flush()
    expect(store.get('nope')).toBeNull()
  })

  it('setSummary preserves existing session_id and last_used_at', () => {
    const store = makeSessionStore(db)
    store.set('compass', 's_abc', 'claude')
    const before = store.get('compass')
    store.setSummary('compass', 'a summary')
    const after = store.get('compass')
    expect(after?.session_id).toBe(before?.session_id)
    expect(after?.last_used_at).toBe(before?.last_used_at)
  })

  describe('provider tagging (RFC 03 P0)', () => {
    it('writes provider field on set, persists across reload', async () => {
      const path = join(dir, 'wechat-cc.db')
      const d1 = openDb({ path })
      try {
        const s1 = makeSessionStore(d1)
        s1.set('compass', 'sid-claude', 'claude')
        s1.set('mobile', 'sid-codex', 'codex')
        await s1.flush()
      } finally { d1.close() }
      const d2 = openDb({ path })
      try {
        const s2 = makeSessionStore(d2)
        expect(s2.get('compass')?.provider).toBe('claude')
        expect(s2.get('mobile')?.provider).toBe('codex')
      } finally { d2.close() }
    })

    it('get() with expectedProvider returns null on mismatch', () => {
      const s = makeSessionStore(db)
      s.set('compass', 'sid-claude', 'claude')
      expect(s.get('compass', 'claude')?.session_id).toBe('sid-claude')
      expect(s.get('compass', 'codex')).toBeNull()
    })

    it('get() without expectedProvider returns the most-recent record across providers', async () => {
      const s = makeSessionStore(db)
      s.set('compass', 'sid-claude', 'claude')
      await new Promise(r => setTimeout(r, 10))
      s.set('compass', 'sid-codex', 'codex')
      // Both rows now exist; latest by last_used_at = codex.
      expect(s.get('compass')?.session_id).toBe('sid-codex')
      // Each provider lookup still works independently.
      expect(s.get('compass', 'claude')?.session_id).toBe('sid-claude')
      expect(s.get('compass', 'codex')?.session_id).toBe('sid-codex')
    })

    it('binding a different provider to the same alias keeps both rows', () => {
      const s = makeSessionStore(db)
      s.set('compass', 'sid-claude', 'claude')
      s.set('compass', 'sid-codex', 'codex')
      // get(alias) without provider returns the latest (codex).
      expect(s.get('compass')?.session_id).toBe('sid-codex')
      // The claude row is still there for resume on /cc.
      expect(s.get('compass', 'claude')?.session_id).toBe('sid-claude')
    })

    it('delete clears all provider rows for the alias', () => {
      const s = makeSessionStore(db)
      s.set('compass', 'sid-claude', 'claude')
      s.set('compass', 'sid-codex', 'codex')
      s.delete('compass')
      expect(s.get('compass', 'claude')).toBeNull()
      expect(s.get('compass', 'codex')).toBeNull()
    })
  })

  describe('legacy file migration', () => {
    it('imports rows from a v1 sessions.json with provider tags', () => {
      const file = join(dir, 'sessions.json')
      writeFileSync(file, JSON.stringify({
        version: 1,
        sessions: {
          compass: { session_id: 'sid-claude', last_used_at: '2026-04-01T00:00:00.000Z', provider: 'claude' },
          mobile: { session_id: 'sid-codex', last_used_at: '2026-04-02T00:00:00.000Z', provider: 'codex', summary: 'mobile chat', summary_updated_at: '2026-04-03T00:00:00.000Z' },
        },
      }))
      const s = makeSessionStore(db, { migrateFromFile: file })
      expect(s.get('compass')?.session_id).toBe('sid-claude')
      expect(s.get('mobile')?.session_id).toBe('sid-codex')
      expect(s.get('mobile')?.summary).toBe('mobile chat')
      expect(existsSync(file)).toBe(false)
      expect(existsSync(`${file}.migrated`)).toBe(true)
    })

    it('treats records without provider field as claude (v0.x legacy default)', () => {
      const file = join(dir, 'sessions.json')
      writeFileSync(file, JSON.stringify({
        version: 1,
        sessions: { compass: { session_id: 'sid-legacy', last_used_at: '2026-04-01T00:00:00.000Z' } },
      }))
      const s = makeSessionStore(db, { migrateFromFile: file })
      expect(s.get('compass')?.provider).toBe('claude')
      expect(s.get('compass', 'claude')?.session_id).toBe('sid-legacy')
      expect(s.get('compass', 'codex')).toBeNull()
    })

    it('preserves the file when JSON is corrupt', () => {
      const file = join(dir, 'sessions.json')
      writeFileSync(file, '{not json')
      const s = makeSessionStore(db, { migrateFromFile: file })
      expect(s.all()).toEqual({})
      expect(existsSync(file)).toBe(true)
      expect(existsSync(`${file}.migrated`)).toBe(false)
    })

    it('is idempotent — second construction with same opt is a no-op', () => {
      const file = join(dir, 'sessions.json')
      writeFileSync(file, JSON.stringify({
        version: 1,
        sessions: { compass: { session_id: 'sid', last_used_at: '2026-04-01T00:00:00.000Z' } },
      }))
      makeSessionStore(db, { migrateFromFile: file })
      const s2 = makeSessionStore(db, { migrateFromFile: file })
      expect(s2.get('compass')?.session_id).toBe('sid')
    })
  })
})
