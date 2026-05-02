/**
 * SQLite connection + schema migration for the daemon's state stores.
 *
 * Single ~/.claude/channels/wechat/wechat-cc.db file owned by the daemon
 * process. Each table that used to live as a JSON/JSONL file under the
 * channel state dir is migrated here one-at-a-time across PR7 commits.
 *
 * Schema versioning: PRAGMA user_version. Each `migrations` entry below
 * advances the version by one and creates / alters the table for that
 * step. openDb() applies any missing migrations in order.
 *
 * Concurrency posture:
 *   - WAL journal mode → daemon is the single writer; dashboard / CLI
 *     read-only queries can run concurrently without blocking writes.
 *   - foreign_keys = ON for safety even though we don't currently model
 *     cross-table refs; cheap pragma, lets future schema use FKs.
 *
 * No ORM — call sites use db.prepare() / .query() with prepared
 * statements. bun:sqlite is API-compatible enough with better-sqlite3
 * that swapping later (if Bun ever drops the builtin) would be local.
 */
import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export type Db = Database

/**
 * Each migration runs once, in order, when its index is greater than the
 * file's PRAGMA user_version. After it runs we set user_version = index+1.
 * NEVER reorder; NEVER edit a published migration in place — append a new
 * one. Doing otherwise will corrupt every existing user's database.
 */
type Migration = (db: Database) => void

const migrations: Migration[] = [
  // v1 — session_state. PR7 commit 1.
  (db) => {
    db.exec(`
      CREATE TABLE session_state (
        bot_id TEXT PRIMARY KEY NOT NULL,
        first_seen_expired_at TEXT NOT NULL,
        last_reason TEXT
      ) STRICT;
    `)
  },
  // v2 — sessions (alias × provider → SDK session_id for resume). PR7 commit 2.
  // Composite PK so a single alias can hold one claude + one codex session
  // independently (legacy v0.x format collapsed both into a single row).
  (db) => {
    db.exec(`
      CREATE TABLE sessions (
        alias TEXT NOT NULL,
        provider TEXT NOT NULL,
        session_id TEXT NOT NULL,
        last_used_at TEXT NOT NULL,
        summary TEXT,
        summary_updated_at TEXT,
        PRIMARY KEY (alias, provider)
      ) STRICT;
      CREATE INDEX sessions_alias_last_used ON sessions(alias, last_used_at DESC);
    `)
  },
  // v3 — conversations (chatId → Mode). PR7 commit 3.
  // Mode is normalized into separate columns so future queries (e.g.
  // "all chats currently using codex") don't need JSON1 extension.
  // Only `solo` mode uses mode_provider; only `primary_tool` uses
  // mode_primary; `parallel` / `chatroom` use neither.
  (db) => {
    db.exec(`
      CREATE TABLE conversations (
        chat_id TEXT PRIMARY KEY NOT NULL,
        mode_kind TEXT NOT NULL CHECK (mode_kind IN ('solo', 'primary_tool', 'parallel', 'chatroom')),
        mode_provider TEXT,
        mode_primary TEXT,
        updated_at TEXT NOT NULL
      ) STRICT;
    `)
  },
  // v4 — activity (per-chat per-day inbound message tally). PR7 commit 4.
  // One row per (chat_id, UTC date). Detector reads recent days to
  // evaluate the 7-day-streak milestone.
  (db) => {
    db.exec(`
      CREATE TABLE activity (
        chat_id TEXT NOT NULL,
        date TEXT NOT NULL,            -- YYYY-MM-DD UTC
        first_msg_ts TEXT NOT NULL,    -- ISO 8601
        msg_count INTEGER NOT NULL,
        PRIMARY KEY (chat_id, date)
      ) STRICT;
    `)
  },
  // v5 — milestones (per-chat fires, id-deduped, permanent). PR7 commit 5.
  // event_id back-pointer mirrors the existing JSONL field; it's nullable
  // because demo seeding writes milestones without an associated event.
  (db) => {
    db.exec(`
      CREATE TABLE milestones (
        chat_id TEXT NOT NULL,
        id TEXT NOT NULL,
        ts TEXT NOT NULL,
        body TEXT NOT NULL,
        event_id TEXT,
        PRIMARY KEY (chat_id, id)
      ) STRICT;
    `)
  },
]

export interface OpenDbOpts {
  /**
   * Filesystem path to the SQLite file. Use `:memory:` for tests. Parent
   * directory is created (recursively, mode 0700) if it doesn't exist.
   */
  path: string
}

export function openDb(opts: OpenDbOpts): Database {
  if (opts.path !== ':memory:') {
    const dir = dirname(opts.path)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
  }
  const db = new Database(opts.path, { create: true })
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec('PRAGMA foreign_keys = ON;')
  // 5s busy_timeout — the CLI process and daemon may try to write the same
  // db simultaneously (e.g. `wechat-cc sessions delete` while the daemon
  // bumps last_used_at). With WAL the conflict window is short; the
  // timeout makes it transparent.
  db.exec('PRAGMA busy_timeout = 5000;')
  applyMigrations(db)
  return db
}

function applyMigrations(db: Database): void {
  const row = db.query('PRAGMA user_version').get() as { user_version: number } | null
  const current = row?.user_version ?? 0
  for (let i = current; i < migrations.length; i++) {
    const next = migrations[i]!
    db.transaction(() => {
      next(db)
      // PRAGMA user_version doesn't accept bound params; safe — value is
      // a literal integer index from our own array, not user input.
      db.exec(`PRAGMA user_version = ${i + 1};`)
    })()
  }
}

/** Test helper — opens a fresh in-memory db with all migrations applied. */
export function openTestDb(): Database {
  return openDb({ path: ':memory:' })
}
