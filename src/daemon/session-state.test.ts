import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { makeSessionStateStore } from './session-state'
import { openTestDb, openDb, type Db } from '../lib/db'

describe('SessionStateStore', () => {
  let dir: string
  let db: Db

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'session-state-'))
    db = openTestDb()
  })
  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('starts empty', () => {
    const s = makeSessionStateStore(db)
    expect(s.isExpired('bot-a')).toBe(false)
    expect(s.listExpired()).toEqual([])
  })

  it('markExpired transitions once', () => {
    const s = makeSessionStateStore(db)
    expect(s.markExpired('bot-a', 'test')).toBe(true)
    expect(s.markExpired('bot-a', 'test2')).toBe(false) // idempotent
    expect(s.isExpired('bot-a')).toBe(true)
  })

  it('listExpired sorts oldest first', async () => {
    const s = makeSessionStateStore(db)
    s.markExpired('bot-a', 'reason-a')
    await new Promise(r => setTimeout(r, 10))
    s.markExpired('bot-b', 'reason-b')
    const list = s.listExpired()
    expect(list.map(e => e.id)).toEqual(['bot-a', 'bot-b'])
    expect(list[0]!.last_reason).toBe('reason-a')
  })

  it('clear removes entry', () => {
    const s = makeSessionStateStore(db)
    s.markExpired('bot-a')
    s.clear('bot-a')
    expect(s.isExpired('bot-a')).toBe(false)
    expect(s.listExpired()).toEqual([])
  })

  it('persists across instances (same db file)', async () => {
    const path = join(dir, 'wechat-cc.db')
    const d1 = openDb({ path })
    try {
      const s1 = makeSessionStateStore(d1)
      s1.markExpired('bot-a', 'boom')
      await s1.flush()
    } finally { d1.close() }

    const d2 = openDb({ path })
    try {
      const s2 = makeSessionStateStore(d2)
      expect(s2.isExpired('bot-a')).toBe(true)
      expect(s2.listExpired()[0]!.last_reason).toBe('boom')
    } finally { d2.close() }
  })

  describe('legacy file migration', () => {
    it('imports rows from a v0.x session-state.json and renames it .migrated', () => {
      const file = join(dir, 'session-state.json')
      writeFileSync(file, JSON.stringify({
        version: 1,
        bots: {
          'bot-a': { status: 'expired', first_seen_expired_at: '2026-01-01T00:00:00.000Z', last_reason: 'errcode=-14' },
          'bot-b': { status: 'expired', first_seen_expired_at: '2026-01-02T00:00:00.000Z' },
        },
      }))
      const s = makeSessionStateStore(db, { migrateFromFile: file })
      expect(s.isExpired('bot-a')).toBe(true)
      expect(s.isExpired('bot-b')).toBe(true)
      const list = s.listExpired()
      expect(list).toHaveLength(2)
      expect(list[0]!.id).toBe('bot-a')
      expect(list[0]!.last_reason).toBe('errcode=-14')
      // Original renamed
      expect(existsSync(file)).toBe(false)
      expect(existsSync(`${file}.migrated`)).toBe(true)
    })

    it('is idempotent — second boot skips when the file is already gone', () => {
      const file = join(dir, 'session-state.json')
      writeFileSync(file, JSON.stringify({
        version: 1,
        bots: { 'bot-a': { status: 'expired', first_seen_expired_at: '2026-01-01T00:00:00.000Z' } },
      }))
      makeSessionStateStore(db, { migrateFromFile: file })
      // Second construction with the same file path — file no longer exists,
      // no-op + no throw.
      const s2 = makeSessionStateStore(db, { migrateFromFile: file })
      expect(s2.listExpired()).toHaveLength(1)
    })

    it('skips silently when the legacy file has no bots key', () => {
      const file = join(dir, 'session-state.json')
      writeFileSync(file, JSON.stringify({}))
      const s = makeSessionStateStore(db, { migrateFromFile: file })
      expect(s.listExpired()).toEqual([])
      expect(existsSync(`${file}.migrated`)).toBe(true)
    })

    it('preserves the file when JSON is corrupt (so a fixer can inspect it)', () => {
      const file = join(dir, 'session-state.json')
      writeFileSync(file, '{not valid json')
      const s = makeSessionStateStore(db, { migrateFromFile: file })
      expect(s.listExpired()).toEqual([])
      expect(existsSync(file)).toBe(true)
      expect(existsSync(`${file}.migrated`)).toBe(false)
    })

    it('no migrateFromFile opt → no file ops', () => {
      const file = join(dir, 'session-state.json')
      writeFileSync(file, JSON.stringify({
        version: 1,
        bots: { 'bot-a': { status: 'expired', first_seen_expired_at: '2026-01-01T00:00:00.000Z' } },
      }))
      const s = makeSessionStateStore(db)
      expect(s.listExpired()).toEqual([])
      expect(existsSync(file)).toBe(true)  // untouched
    })
  })
})
