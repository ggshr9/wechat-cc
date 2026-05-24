import { describe, expect, it } from 'vitest'
import { Database } from 'bun:sqlite'
import { openTestDb, openDb, renameMigrated, runMigrations } from './db'
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

describe('migration v10 — sessions.chat_id', () => {
  it('adds chat_id column with _legacy default for pre-existing rows', () => {
    const db = new Database(':memory:')
    db.exec(`
      PRAGMA user_version = 9;
      CREATE TABLE sessions (
        alias TEXT NOT NULL,
        provider TEXT NOT NULL,
        session_id TEXT NOT NULL,
        last_used_at TEXT NOT NULL,
        summary TEXT,
        summary_updated_at TEXT,
        PRIMARY KEY (alias, provider)
      ) STRICT;
      INSERT INTO sessions(alias, provider, session_id, last_used_at)
        VALUES ('_default', 'claude', 'sess1', '${new Date().toISOString()}');
    `)

    runMigrations(db)

    const cols = db.query("PRAGMA table_info('sessions')").all() as Array<{ name: string }>
    expect(cols.map(c => c.name)).toContain('chat_id')

    const row = db.query("SELECT chat_id FROM sessions WHERE alias = '_default'").get() as { chat_id: string }
    expect(row.chat_id).toBe('_legacy')

    const ver = db.query('PRAGMA user_version').get() as { user_version: number }
    expect(ver.user_version).toBeGreaterThanOrEqual(10)
  })

  it('legacy rows older than 1 day are cleaned up', () => {
    const db = new Database(':memory:')
    const oldTs = new Date(Date.now() - 2 * 86_400_000).toISOString()
    db.exec(`
      PRAGMA user_version = 9;
      CREATE TABLE sessions (
        alias TEXT NOT NULL, provider TEXT NOT NULL, session_id TEXT NOT NULL,
        last_used_at TEXT NOT NULL, summary TEXT, summary_updated_at TEXT,
        PRIMARY KEY (alias, provider)
      ) STRICT;
      INSERT INTO sessions(alias, provider, session_id, last_used_at) VALUES
        ('_default', 'claude', 'old_sess', '${oldTs}'),
        ('_default', 'codex',  'fresh',    '${new Date().toISOString()}');
    `)
    runMigrations(db)
    const remaining = db.query<{ session_id: string }, []>('SELECT session_id FROM sessions').all()
    expect(remaining.map(r => r.session_id)).toContain('fresh')
    expect(remaining.map(r => r.session_id)).not.toContain('old_sess')
  })
})

describe('migration v11 — participants column', () => {
  it('adds nullable TEXT participants column to conversations', () => {
    const db = openDb({ path: ':memory:' })
    const cols = db.query<{ name: string; type: string; notnull: number }, []>(
      "SELECT name, type, [notnull] FROM pragma_table_info('conversations')"
    ).all()
    const col = cols.find(c => c.name === 'participants')
    expect(col).toBeDefined()
    expect(col!.type).toBe('TEXT')
    expect(col!.notnull).toBe(0)
  })

  it('pre-v11 rows hydrate with NULL participants', () => {
    const db = openDb({ path: ':memory:' })
    db.exec(
      "INSERT INTO conversations(chat_id, mode_kind, mode_provider, mode_primary, updated_at) " +
      "VALUES ('legacy-chat', 'chatroom', NULL, NULL, '2026-05-22T00:00:00.000Z')"
    )
    const row = db.query<{ participants: string | null }, []>(
      "SELECT participants FROM conversations WHERE chat_id = 'legacy-chat'"
    ).get()
    expect(row).toBeDefined()
    expect(row!.participants).toBeNull()
  })
})
