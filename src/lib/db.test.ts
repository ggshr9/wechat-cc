import { describe, expect, it } from 'vitest'
import { openTestDb, openDb, renameMigrated } from './db'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('openDb', () => {
  it('returns a database with all migrations applied', () => {
    const db = openTestDb()
    const v = db.query('PRAGMA user_version').get() as { user_version: number }
    expect(v.user_version).toBeGreaterThan(0)
    // schema for v1: session_state table exists
    const tables = db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
    expect(tables.map(t => t.name)).toContain('session_state')
  })

  it('is idempotent: re-opening an existing file does not re-run migrations', () => {
    const dir = mkdtempSync(join(tmpdir(), 'db-test-'))
    try {
      const path = join(dir, 'test.db')
      const db1 = openDb({ path })
      const v1 = (db1.query('PRAGMA user_version').get() as { user_version: number }).user_version
      db1.exec("INSERT INTO session_state(bot_id, first_seen_expired_at) VALUES ('b1', '2026-01-01T00:00:00Z')")
      db1.close()

      const db2 = openDb({ path })
      const v2 = (db2.query('PRAGMA user_version').get() as { user_version: number }).user_version
      expect(v2).toBe(v1)
      const row = db2.query("SELECT bot_id FROM session_state WHERE bot_id='b1'").get() as { bot_id: string } | null
      expect(row?.bot_id).toBe('b1')
      db2.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('enables WAL', () => {
    const dir = mkdtempSync(join(tmpdir(), 'db-test-wal-'))
    try {
      const db = openDb({ path: join(dir, 'wal.db') })
      const mode = db.query('PRAGMA journal_mode').get() as { journal_mode: string }
      expect(mode.journal_mode.toLowerCase()).toBe('wal')
      db.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('renameMigrated', () => {
  it('renames the file to <file>.migrated', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rm-'))
    try {
      const file = join(dir, 'legacy.json')
      writeFileSync(file, '{}')
      renameMigrated(file)
      expect(existsSync(file)).toBe(false)
      expect(existsSync(`${file}.migrated`)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('swallows ENOENT when the file is already gone (concurrent first-boot race)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rm-'))
    try {
      const file = join(dir, 'legacy.json')
      // Simulate "another process already renamed it" — file does not exist.
      expect(() => renameMigrated(file)).not.toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
