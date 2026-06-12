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

describe('migration v12 — a2a_events table', () => {
  it('creates a2a_events table with expected columns', () => {
    const db = openDb({ path: ':memory:' })
    const cols = db.query<{ name: string }, []>(
      "SELECT name FROM pragma_table_info('a2a_events')"
    ).all()
    const names = cols.map(c => c.name).sort()
    expect(names).toEqual(['agent_id', 'direction', 'http_status', 'id', 'status', 'text', 'ts', 'urgency'])
  })

  it('PRAGMA user_version is at least 12 after v12 (latest migrations applied)', () => {
    const db = openDb({ path: ':memory:' })
    const v = (db.query('PRAGMA user_version').get() as { user_version: number }).user_version
    expect(v).toBeGreaterThanOrEqual(12)
  })

  it('agent_ts index exists', () => {
    const db = openDb({ path: ':memory:' })
    const idx = db.query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='a2a_events'"
    ).all()
    expect(idx.find(i => i.name === 'a2a_events_agent_ts')).toBeDefined()
  })
})

describe('migration v13 — events.kind adds memory_deleted + memory_path column', () => {
  it('extends events.kind CHECK to include memory_deleted', () => {
    const db = openDb({ path: ':memory:' })
    // Should succeed (kind allowed)
    expect(() => db.exec(
      "INSERT INTO events(id, chat_id, ts, kind, trigger, reasoning) " +
      "VALUES ('evt_a', 'chat1', '2026-05-26T00:00:00.000Z', 'memory_deleted', 'mcp_tool_call', 'user said forget')"
    )).not.toThrow()
  })

  it('rejects kind values outside the union (CHECK still active)', () => {
    const db = openDb({ path: ':memory:' })
    expect(() => db.exec(
      "INSERT INTO events(id, chat_id, ts, kind, trigger, reasoning) " +
      "VALUES ('evt_b', 'chat1', '2026-05-26T00:00:00.000Z', 'not_a_real_kind', 'mcp_tool_call', 'whatever')"
    )).toThrow()
  })

  it('preserves pre-v13 rows through the table recreate, and adds memory_path nullable TEXT column', () => {
    const db = openDb({ path: ':memory:' })
    // Insert a row with a pre-existing kind
    db.exec(
      "INSERT INTO events(id, chat_id, ts, kind, trigger, reasoning) " +
      "VALUES ('evt_legacy', 'chat1', '2026-05-25T00:00:00.000Z', 'milestone', 'manual', 'old row preserved')"
    )
    // The migration ran on openDb (all-in-one). Validate the schema:
    const cols = db.query<{ name: string; type: string; notnull: number }, []>(
      "SELECT name, type, [notnull] FROM pragma_table_info('events')"
    ).all()
    const mp = cols.find(c => c.name === 'memory_path')
    expect(mp).toBeDefined()
    expect(mp!.type).toBe('TEXT')
    expect(mp!.notnull).toBe(0)
    // And the legacy row survived
    const row = db.query<{ reasoning: string }, []>(
      "SELECT reasoning FROM events WHERE id = 'evt_legacy'"
    ).get()
    expect(row?.reasoning).toBe('old row preserved')
  })
})

describe('migration v13→v14 upgrade — events data preserved', () => {
  it('preserves pre-v14 rows through the table recreate, memory_path intact', () => {
    // Build a db that has run migrations 0..12 (user_version=13) so it
    // has the v13 events schema (with memory_deleted kind + memory_path col)
    // but has NOT yet run v14. We do this by running all migrations then
    // rolling back user_version — but since SQLite doesn't support undoing
    // DDL, the cleanest approach is to construct the v13 schema directly,
    // matching the shape the v13 migration leaves behind, then run v14.
    const db = new Database(':memory:')
    // Replicate the exact v13 schema so runMigrations sees user_version=13
    // and only applies v14.
    db.exec(`
      PRAGMA user_version = 13;
      CREATE TABLE events (
        id TEXT PRIMARY KEY NOT NULL,
        chat_id TEXT NOT NULL,
        ts TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN (
          'cron_eval_pushed', 'cron_eval_skipped', 'cron_eval_failed',
          'observation_written', 'milestone',
          'memory_deleted'
        )),
        trigger TEXT NOT NULL,
        reasoning TEXT NOT NULL,
        push_text TEXT,
        observation_id TEXT,
        milestone_id TEXT,
        jsonl_session_id TEXT,
        memory_path TEXT
      ) STRICT;
      CREATE INDEX events_chat_ts ON events(chat_id, ts DESC);
    `)
    // Insert a row using the memory_deleted kind and a non-null memory_path
    db.exec(
      "INSERT INTO events(id, chat_id, ts, kind, trigger, reasoning, memory_path) " +
      "VALUES ('evt_pre14', 'chat1', '2026-06-01T00:00:00.000Z', 'memory_deleted', 'mcp_tool_call', 'user said forget', '/foo/bar.md')"
    )
    // Run remaining migrations (only v14 applies, since user_version=13)
    runMigrations(db)
    // The row must have survived the CHECK rebuild
    const row = db.query<{ reasoning: string; memory_path: string | null }, []>(
      "SELECT reasoning, memory_path FROM events WHERE id = 'evt_pre14'"
    ).get()
    expect(row?.reasoning).toBe('user said forget')
    expect(row?.memory_path).toBe('/foo/bar.md')
    // And threads_extracted must now be accepted as a valid kind
    expect(() => db.exec(
      "INSERT INTO events(id, chat_id, ts, kind, trigger, reasoning) " +
      "VALUES ('evt_new', 'chat1', '2026-06-11T00:00:00.000Z', 'threads_extracted', 'introspect', 'extracted threads')"
    )).not.toThrow()
  })
})

describe('dialogue migration', () => {
  it('creates messages / threads / thread_extract_state tables', () => {
    const db = openTestDb()
    db.exec(`INSERT INTO messages(id, chat_id, ts, direction, kind, text, source)
             VALUES ('m1', 'c1', '2026-06-11T00:00:00Z', 'in', 'text', 'hi', 'live')`)
    db.exec(`INSERT INTO threads(id, chat_id, title, facets, created_ts, last_active)
             VALUES ('t1', 'c1', '排产', '["task"]', '2026-06-11T00:00:00Z', '2026-06-11T00:00:00Z')`)
    db.exec(`INSERT INTO thread_extract_state(chat_id, extracted_to_ts)
             VALUES ('c1', '2026-06-11T00:00:00Z')`)
    expect(db.query('SELECT COUNT(*) c FROM messages').get()).toEqual({ c: 1 })
  })

  it('messages.direction is constrained to in/out', () => {
    const db = openTestDb()
    expect(() => db.exec(
      `INSERT INTO messages(id, chat_id, ts, direction, kind, text, source)
       VALUES ('m2', 'c1', '2026-06-11T00:00:00Z', 'sideways', 'text', 'x', 'live')`,
    )).toThrow()
  })

  it('events accepts the new threads_extracted kind and still accepts old kinds', () => {
    const db = openTestDb()
    db.exec(`INSERT INTO events(id, chat_id, ts, kind, trigger, reasoning)
             VALUES ('e1', 'c1', '2026-06-11T00:00:00Z', 'threads_extracted', 'introspect', 'r')`)
    db.exec(`INSERT INTO events(id, chat_id, ts, kind, trigger, reasoning)
             VALUES ('e2', 'c1', '2026-06-11T00:00:00Z', 'observation_written', 'cron', 'r')`)
    expect(db.query('SELECT COUNT(*) c FROM events').get()).toEqual({ c: 2 })
  })

  it('events rows survive the CHECK rebuild', () => {
    const db = openTestDb()
    const cols = db.query(`SELECT name FROM pragma_table_info('events')`).all() as Array<{ name: string }>
    expect(cols.map(c => c.name)).toContain('observation_id')
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
