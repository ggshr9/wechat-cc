import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { makeSessionStore } from './session-store'
import { openTestDb, openDb, type Db } from '../lib/db'

// Pre-tier (v0.5) rows migrated from the legacy sessions.json land
// under chat_id='_legacy'. Most tests in this file pre-date the
// per-chat split, so reusing that placeholder keeps assertions
// focused on the (alias, provider) surface they were written for.
const CHAT = '_legacy'

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
    expect(s.get({ alias: 'compass', provider: 'claude', chatId: CHAT })).toBeNull()
    expect(s.all()).toEqual({})
  })

  it('set + get roundtrips', () => {
    const s = makeSessionStore(db)
    s.set({ alias: 'compass', provider: 'claude', chatId: CHAT, sessionId: 'sid-123' })
    const r = s.get({ alias: 'compass', provider: 'claude', chatId: CHAT })
    expect(r?.session_id).toBe('sid-123')
    expect(typeof r?.last_used_at).toBe('string')
  })

  it('set with same session_id bumps last_used_at', async () => {
    const s = makeSessionStore(db)
    s.set({ alias: 'compass', provider: 'claude', chatId: CHAT, sessionId: 'sid-1' })
    const first = s.get({ alias: 'compass', provider: 'claude', chatId: CHAT })!.last_used_at
    await new Promise(r => setTimeout(r, 10))
    s.set({ alias: 'compass', provider: 'claude', chatId: CHAT, sessionId: 'sid-1' })
    const second = s.get({ alias: 'compass', provider: 'claude', chatId: CHAT })!.last_used_at
    expect(Date.parse(second)).toBeGreaterThan(Date.parse(first))
  })

  it('set with different session_id (same provider) replaces record', () => {
    const s = makeSessionStore(db)
    s.set({ alias: 'compass', provider: 'claude', chatId: CHAT, sessionId: 'sid-1' })
    s.set({ alias: 'compass', provider: 'claude', chatId: CHAT, sessionId: 'sid-2' })
    expect(s.get({ alias: 'compass', provider: 'claude', chatId: CHAT })?.session_id).toBe('sid-2')
  })

  it('delete removes record', () => {
    const s = makeSessionStore(db)
    s.set({ alias: 'compass', provider: 'claude', chatId: CHAT, sessionId: 'sid-1' })
    s.delete({ alias: 'compass', chatId: CHAT })
    expect(s.get({ alias: 'compass', provider: 'claude', chatId: CHAT })).toBeNull()
  })

  it('persists across instances (same db file)', async () => {
    const path = join(dir, 'wechat-cc.db')
    const d1 = openDb({ path })
    try {
      const s1 = makeSessionStore(d1)
      s1.set({ alias: 'compass', provider: 'claude', chatId: CHAT, sessionId: 'sid-persist' })
      await s1.flush()
    } finally { d1.close() }

    const d2 = openDb({ path })
    try {
      const s2 = makeSessionStore(d2)
      expect(s2.get({ alias: 'compass', provider: 'claude', chatId: CHAT })?.session_id).toBe('sid-persist')
    } finally { d2.close() }
  })

  it('all() returns snapshot keyed by alias|provider|chatId', () => {
    const s = makeSessionStore(db)
    s.set({ alias: 'a', provider: 'claude', chatId: CHAT, sessionId: 'sa' })
    s.set({ alias: 'b', provider: 'claude', chatId: CHAT, sessionId: 'sb' })
    const snap = s.all()
    expect(Object.keys(snap).sort()).toEqual([`a|claude|${CHAT}`, `b|claude|${CHAT}`])
    expect(snap[`a|claude|${CHAT}`]?.alias).toBe('a')
    expect(snap[`b|claude|${CHAT}`]?.session_id).toBe('sb')
  })

  it('two chats on the same alias+provider get distinct rows', () => {
    const s = makeSessionStore(db)
    s.set({ alias: '_default', provider: 'claude', chatId: 'chatA', sessionId: 'sessA' })
    s.set({ alias: '_default', provider: 'claude', chatId: 'chatB', sessionId: 'sessB' })
    expect(s.get({ alias: '_default', provider: 'claude', chatId: 'chatA' })?.session_id).toBe('sessA')
    expect(s.get({ alias: '_default', provider: 'claude', chatId: 'chatB' })?.session_id).toBe('sessB')
  })

  it('setSummary updates summary + summary_updated_at; persists across re-open', async () => {
    const path = join(dir, 'wechat-cc.db')
    const d1 = openDb({ path })
    try {
      const store = makeSessionStore(d1)
      store.set({ alias: 'compass', provider: 'claude', chatId: CHAT, sessionId: 's_abc' })
      store.setSummary({ alias: 'compass', provider: 'claude', chatId: CHAT }, '修了 ilink-glue')
      await store.flush()
    } finally { d1.close() }

    const d2 = openDb({ path })
    try {
      const fresh = makeSessionStore(d2)
      const rec = fresh.get({ alias: 'compass', provider: 'claude', chatId: CHAT })
      expect(rec?.summary).toBe('修了 ilink-glue')
      expect(rec?.summary_updated_at).toBeDefined()
      expect(typeof rec?.summary_updated_at).toBe('string')
    } finally { d2.close() }
  })

  it('setSummary on unknown alias is a no-op', async () => {
    const store = makeSessionStore(db)
    store.setSummary({ alias: 'nope', provider: 'claude', chatId: CHAT }, 'whatever')
    await store.flush()
    expect(store.get({ alias: 'nope', provider: 'claude', chatId: CHAT })).toBeNull()
  })

  it('setSummary preserves existing session_id and last_used_at', () => {
    const store = makeSessionStore(db)
    store.set({ alias: 'compass', provider: 'claude', chatId: CHAT, sessionId: 's_abc' })
    const before = store.get({ alias: 'compass', provider: 'claude', chatId: CHAT })
    store.setSummary({ alias: 'compass', provider: 'claude', chatId: CHAT }, 'a summary')
    const after = store.get({ alias: 'compass', provider: 'claude', chatId: CHAT })
    expect(after?.session_id).toBe(before?.session_id)
    expect(after?.last_used_at).toBe(before?.last_used_at)
  })

  describe('provider tagging (RFC 03 P0)', () => {
    it('writes provider field on set, persists across reload', async () => {
      const path = join(dir, 'wechat-cc.db')
      const d1 = openDb({ path })
      try {
        const s1 = makeSessionStore(d1)
        s1.set({ alias: 'compass', provider: 'claude', chatId: CHAT, sessionId: 'sid-claude' })
        s1.set({ alias: 'mobile', provider: 'codex', chatId: CHAT, sessionId: 'sid-codex' })
        await s1.flush()
      } finally { d1.close() }
      const d2 = openDb({ path })
      try {
        const s2 = makeSessionStore(d2)
        expect(s2.get({ alias: 'compass', provider: 'claude', chatId: CHAT })?.provider).toBe('claude')
        expect(s2.get({ alias: 'mobile', provider: 'codex', chatId: CHAT })?.provider).toBe('codex')
      } finally { d2.close() }
    })

    it('get() with wrong provider returns null', () => {
      const s = makeSessionStore(db)
      s.set({ alias: 'compass', provider: 'claude', chatId: CHAT, sessionId: 'sid-claude' })
      expect(s.get({ alias: 'compass', provider: 'claude', chatId: CHAT })?.session_id).toBe('sid-claude')
      expect(s.get({ alias: 'compass', provider: 'codex', chatId: CHAT })).toBeNull()
    })

    it('binding two providers on the same (alias, chatId) keeps both rows', () => {
      const s = makeSessionStore(db)
      s.set({ alias: 'compass', provider: 'claude', chatId: CHAT, sessionId: 'sid-claude' })
      s.set({ alias: 'compass', provider: 'codex', chatId: CHAT, sessionId: 'sid-codex' })
      expect(s.get({ alias: 'compass', provider: 'claude', chatId: CHAT })?.session_id).toBe('sid-claude')
      expect(s.get({ alias: 'compass', provider: 'codex', chatId: CHAT })?.session_id).toBe('sid-codex')
    })

    it('delete clears all provider rows for the (alias, chatId)', () => {
      const s = makeSessionStore(db)
      s.set({ alias: 'compass', provider: 'claude', chatId: CHAT, sessionId: 'sid-claude' })
      s.set({ alias: 'compass', provider: 'codex', chatId: CHAT, sessionId: 'sid-codex' })
      s.delete({ alias: 'compass', chatId: CHAT })
      expect(s.get({ alias: 'compass', provider: 'claude', chatId: CHAT })).toBeNull()
      expect(s.get({ alias: 'compass', provider: 'codex', chatId: CHAT })).toBeNull()
    })

    it('delete on one chat leaves a sibling chat row intact', () => {
      const s = makeSessionStore(db)
      s.set({ alias: 'compass', provider: 'claude', chatId: 'chatA', sessionId: 'sid-A' })
      s.set({ alias: 'compass', provider: 'claude', chatId: 'chatB', sessionId: 'sid-B' })
      s.delete({ alias: 'compass', chatId: 'chatA' })
      expect(s.get({ alias: 'compass', provider: 'claude', chatId: 'chatA' })).toBeNull()
      expect(s.get({ alias: 'compass', provider: 'claude', chatId: 'chatB' })?.session_id).toBe('sid-B')
    })

    it('deleteOne removes only the specified provider row', () => {
      // Regression guard: session-manager's stale-record cleanup must
      // not collateral-damage the other provider's resume point. Before
      // this, calling delete(alias) on a stale codex row also wiped the
      // still-valid claude row, forcing a cold start on /cc.
      const s = makeSessionStore(db)
      s.set({ alias: 'compass', provider: 'claude', chatId: CHAT, sessionId: 'sid-claude' })
      s.set({ alias: 'compass', provider: 'codex', chatId: CHAT, sessionId: 'sid-codex' })
      s.deleteOne({ alias: 'compass', provider: 'claude', chatId: CHAT })
      expect(s.get({ alias: 'compass', provider: 'claude', chatId: CHAT })).toBeNull()
      expect(s.get({ alias: 'compass', provider: 'codex', chatId: CHAT })?.session_id).toBe('sid-codex')
    })

    it('deleteOne on a non-existent triple is a no-op', () => {
      const s = makeSessionStore(db)
      s.set({ alias: 'compass', provider: 'codex', chatId: CHAT, sessionId: 'sid-codex' })
      s.deleteOne({ alias: 'compass', provider: 'claude', chatId: CHAT })  // no claude row exists
      expect(s.get({ alias: 'compass', provider: 'codex', chatId: CHAT })?.session_id).toBe('sid-codex')
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
      // Legacy rows land under chat_id='_legacy'.
      expect(s.get({ alias: 'compass', provider: 'claude', chatId: '_legacy' })?.session_id).toBe('sid-claude')
      expect(s.get({ alias: 'mobile', provider: 'codex', chatId: '_legacy' })?.session_id).toBe('sid-codex')
      expect(s.get({ alias: 'mobile', provider: 'codex', chatId: '_legacy' })?.summary).toBe('mobile chat')
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
      expect(s.get({ alias: 'compass', provider: 'claude', chatId: '_legacy' })?.session_id).toBe('sid-legacy')
      expect(s.get({ alias: 'compass', provider: 'codex', chatId: '_legacy' })).toBeNull()
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
      expect(s2.get({ alias: 'compass', provider: 'claude', chatId: '_legacy' })?.session_id).toBe('sid')
    })
  })
})
