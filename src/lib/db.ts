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
import { existsSync, mkdirSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'

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
      CREATE TABLE IF NOT EXISTS session_state (
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
      CREATE TABLE IF NOT EXISTS sessions (
        alias TEXT NOT NULL,
        provider TEXT NOT NULL,
        session_id TEXT NOT NULL,
        last_used_at TEXT NOT NULL,
        summary TEXT,
        summary_updated_at TEXT,
        PRIMARY KEY (alias, provider)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS sessions_alias_last_used ON sessions(alias, last_used_at DESC);
    `)
  },
  // v3 — conversations (chatId → Mode). PR7 commit 3.
  // Mode is normalized into separate columns so future queries (e.g.
  // "all chats currently using codex") don't need JSON1 extension.
  // Only `solo` mode uses mode_provider; only `primary_tool` uses
  // mode_primary; `parallel` / `chatroom` use neither.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
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
      CREATE TABLE IF NOT EXISTS activity (
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
      CREATE TABLE IF NOT EXISTS milestones (
        chat_id TEXT NOT NULL,
        id TEXT NOT NULL,
        ts TEXT NOT NULL,
        body TEXT NOT NULL,
        event_id TEXT,
        PRIMARY KEY (chat_id, id)
      ) STRICT;
    `)
  },
  // v6 — observations (per-chat companion notes, archive flag). PR7 commit 6.
  // archived is INTEGER (0/1) per SQLite STRICT — no native bool type.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS observations (
        id TEXT PRIMARY KEY NOT NULL,
        chat_id TEXT NOT NULL,
        ts TEXT NOT NULL,
        body TEXT NOT NULL,
        tone TEXT,
        archived INTEGER NOT NULL DEFAULT 0,
        archived_at TEXT,
        event_id TEXT
      ) STRICT;
      CREATE INDEX IF NOT EXISTS observations_chat_ts ON observations(chat_id, ts DESC);
    `)
  },
  // v7 — events (per-chat append-only decision log). PR7 commit 7.
  // The largest table by volume; introspect cron writes ~1 row per
  // tick × per chat × per day. Index on (chat_id, ts DESC) is what the
  // dashboard's "last N decisions" query hits.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY NOT NULL,
        chat_id TEXT NOT NULL,
        ts TEXT NOT NULL,
        kind TEXT NOT NULL,
        trigger TEXT NOT NULL,
        reasoning TEXT NOT NULL,
        push_text TEXT,
        observation_id TEXT,
        milestone_id TEXT,
        jsonl_session_id TEXT
      ) STRICT;
      CREATE INDEX IF NOT EXISTS events_chat_ts ON events(chat_id, ts DESC);
    `)
  },
  // v8 — tighten events.kind with a CHECK constraint mirroring the
  // closed EventKind TS union in src/daemon/events/store.ts. Posture-
  // aligned with conversations.mode_kind (which has had its CHECK since
  // v3). SQLite's ALTER TABLE can't add a CHECK on an existing column,
  // so we recreate the table; rows preserved via INSERT…SELECT, and the
  // events_chat_ts index has to be re-created (DROP TABLE drops it too).
  // If any pre-existing row has a kind outside the union, the CHECK will
  // fail this migration — that's the desired outcome (loud failure beats
  // silent drift; the store-side type only narrowed *new* writes).
  (db) => {
    db.exec(`
      CREATE TABLE events_new (
        id TEXT PRIMARY KEY NOT NULL,
        chat_id TEXT NOT NULL,
        ts TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN (
          'cron_eval_pushed', 'cron_eval_skipped', 'cron_eval_failed',
          'observation_written', 'milestone'
        )),
        trigger TEXT NOT NULL,
        reasoning TEXT NOT NULL,
        push_text TEXT,
        observation_id TEXT,
        milestone_id TEXT,
        jsonl_session_id TEXT
      ) STRICT;
      INSERT INTO events_new SELECT * FROM events;
      DROP TABLE events;
      ALTER TABLE events_new RENAME TO events;
      CREATE INDEX events_chat_ts ON events(chat_id, ts DESC);
    `)
  },
  // v9 — identity columns on conversations (chatId → userId/accountId/lastUserName).
  // Surfaces WeChat identity alongside mode so the dashboard can primary-display
  // user (instead of opaque chatId) and the in-memory accountChatIndex from
  // v0.6 PR4 can be replaced by `WHERE account_id = ?`. SQLite's STRICT mode
  // doesn't allow ALTER TABLE...ADD COLUMN with constraints; nullable TEXT is
  // the simplest forward-compatible shape — older rows get NULL until next
  // inbound repopulates via the upcoming mw-identity middleware.
  (db) => {
    db.exec(`
      ALTER TABLE conversations ADD COLUMN user_id TEXT;
      ALTER TABLE conversations ADD COLUMN account_id TEXT;
      ALTER TABLE conversations ADD COLUMN last_user_name TEXT;
    `)
  },
  // v10 — per-chat session keys. Pre-tier sessions get chat_id='_legacy'
  // and are cleaned up if they're older than a day (most installs have
  // nothing newer; the 1-day grace handles fresh upgrades mid-conversation).
  // See docs/superpowers/specs/2026-05-22-user-tier-permissions-design.md.
  (db) => {
    // SQLite can't ALTER a PRIMARY KEY in place; rebuild the table.
    // The column add + table rebuild + delete happen inside this migration
    // function which runs in a single transaction in the runner.
    db.exec(`
      ALTER TABLE sessions ADD COLUMN chat_id TEXT NOT NULL DEFAULT '_legacy';
      CREATE TABLE sessions_v10 (
        alias TEXT NOT NULL,
        provider TEXT NOT NULL,
        -- DEFAULT '_legacy' keeps callers that don't yet supply chat_id from
        -- failing on INSERT. Task 8 rewrites session-store queries to always
        -- pass an explicit chat_id; the default becomes vestigial then, but
        -- harmless. Removing it later requires another migration.
        chat_id TEXT NOT NULL DEFAULT '_legacy',
        session_id TEXT NOT NULL,
        last_used_at TEXT NOT NULL,
        summary TEXT,
        summary_updated_at TEXT,
        PRIMARY KEY (alias, provider, chat_id)
      ) STRICT;
      INSERT INTO sessions_v10(alias, provider, chat_id, session_id, last_used_at, summary, summary_updated_at)
        SELECT alias, provider, chat_id, session_id, last_used_at, summary, summary_updated_at FROM sessions;
      DROP TABLE sessions;
      ALTER TABLE sessions_v10 RENAME TO sessions;
      CREATE INDEX IF NOT EXISTS sessions_alias_last_used ON sessions(alias, last_used_at DESC);
    `)
    // Cleanup pre-tier rows older than 1 day. ISO 8601 string-comparable.
    const cutoff = new Date(Date.now() - 86_400_000).toISOString()
    db.exec(`DELETE FROM sessions WHERE chat_id = '_legacy' AND last_used_at < '${cutoff}'`)
  },
  // v11 — participants column on conversations (N-way modes, P3).
  // Nullable JSON-encoded TEXT array of provider ids. NULL on pre-v11 rows
  // (legacy 2-way parallel/chatroom); the coordinator's resolveParticipants
  // helper backfills these to the first-two-registered providers on first
  // dispatch under the new code so the user's "this chat was 2-way"
  // expectation is preserved. New explicit /chat <p1> <p2> ... commands
  // write the list directly.
  // See docs/superpowers/specs/2026-05-23-n-way-modes-design.md.
  (db) => {
    // Guard: unit-test harnesses that start from user_version=9 (sessions-only
    // schema) will reach this migration without a conversations table. The
    // guard keeps those pre-existing v10 tests green while still applying the
    // column in every real database that went through the full migration chain.
    const has = db
      .query<{ cnt: number }, []>(
        "SELECT COUNT(*) AS cnt FROM sqlite_master WHERE type='table' AND name='conversations'"
      )
      .get()
    if (has && has.cnt > 0) {
      db.exec(`ALTER TABLE conversations ADD COLUMN participants TEXT;`)
    }
  },
  // v12 — a2a_events: observability log for A2A inbound/outbound calls.
  // See docs/superpowers/specs/2026-05-24-a2a-integration-design.md.
  (db) => {
    db.exec(`
      CREATE TABLE a2a_events (
        id TEXT PRIMARY KEY NOT NULL,
        ts TEXT NOT NULL,
        direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
        agent_id TEXT NOT NULL,
        text TEXT NOT NULL,
        urgency TEXT,
        status TEXT NOT NULL DEFAULT 'ok',
        http_status INTEGER
      ) STRICT;
      CREATE INDEX a2a_events_agent_ts ON a2a_events(agent_id, ts DESC);
    `)
  },
  // v13 — events: add `memory_deleted` kind + `memory_path` column for the
  // soft-delete audit log (see docs/specs/2026-05-21-memory-delete-safety-design.md).
  // Same posture as v8: SQLite can't widen a CHECK in place, so the table
  // is rebuilt and the chat-ts index re-created.
  (db) => {
    // Guard: some unit-test harnesses start from user_version=9 with only
    // a sessions table — no events table to migrate. Mirrors v11's
    // conversations guard so those targeted-scope tests stay green while
    // real production dbs (which went through v6/v7) take the rebuild path.
    const hasEvents = db
      .query<{ cnt: number }, []>(
        "SELECT COUNT(*) AS cnt FROM sqlite_master WHERE type='table' AND name='events'"
      )
      .get()
    if (!hasEvents || hasEvents.cnt === 0) return
    db.exec(`
      CREATE TABLE events_v13 (
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
      INSERT INTO events_v13 (id, chat_id, ts, kind, trigger, reasoning,
                              push_text, observation_id, milestone_id, jsonl_session_id)
        SELECT id, chat_id, ts, kind, trigger, reasoning,
               push_text, observation_id, milestone_id, jsonl_session_id FROM events;
      DROP TABLE events;
      ALTER TABLE events_v13 RENAME TO events;
      CREATE INDEX events_chat_ts ON events(chat_id, ts DESC);
    `)
  },
  // v14 — dialogue real data: canonical messages store, topic threads,
  // extraction watermark; events gains 'threads_extracted' kind (CHECK
  // constraints can't be altered in SQLite → rebuild events in place).
  // Spec: docs/superpowers/specs/2026-06-11-dialogue-real-data-design.md
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id        TEXT PRIMARY KEY NOT NULL,
        chat_id   TEXT NOT NULL,
        ts        TEXT NOT NULL,
        direction TEXT NOT NULL CHECK (direction IN ('in','out')),
        kind      TEXT NOT NULL DEFAULT 'text',
        text      TEXT NOT NULL,
        provider  TEXT,
        source    TEXT NOT NULL DEFAULT 'live'
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_messages_chat_ts ON messages(chat_id, ts);

      CREATE TABLE IF NOT EXISTS threads (
        id          TEXT PRIMARY KEY NOT NULL,
        chat_id     TEXT NOT NULL,
        title       TEXT NOT NULL,
        summary     TEXT NOT NULL DEFAULT '',
        facets      TEXT NOT NULL,
        tags        TEXT NOT NULL DEFAULT '[]',
        private     INTEGER NOT NULL DEFAULT 0,
        status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','dormant','done')),
        episodes    TEXT NOT NULL DEFAULT '[]',
        created_ts  TEXT NOT NULL,
        last_active TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_threads_chat ON threads(chat_id, last_active);

      CREATE TABLE IF NOT EXISTS thread_extract_state (
        chat_id         TEXT PRIMARY KEY NOT NULL,
        extracted_to_ts TEXT NOT NULL
      ) STRICT;
    `)
    // events CHECK rebuild: create new → copy → rename. Column set matches the existing schema; only the kind set widens.
    // Guard: some unit-test harnesses skip the full migration chain and may
    // not have an events table (mirrors v11/v13 guard posture).
    const hasEvents = db
      .query<{ cnt: number }, []>(
        "SELECT COUNT(*) AS cnt FROM sqlite_master WHERE type='table' AND name='events'"
      )
      .get()
    if (!hasEvents || hasEvents.cnt === 0) return
    db.exec(`
      CREATE TABLE events_new (
        id TEXT PRIMARY KEY NOT NULL,
        chat_id TEXT NOT NULL,
        ts TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN (
          'cron_eval_pushed', 'cron_eval_skipped', 'cron_eval_failed',
          'observation_written', 'milestone',
          'memory_deleted', 'threads_extracted'
        )),
        trigger TEXT NOT NULL,
        reasoning TEXT NOT NULL,
        push_text TEXT,
        observation_id TEXT,
        milestone_id TEXT,
        jsonl_session_id TEXT,
        memory_path TEXT
      ) STRICT;
      INSERT INTO events_new
        SELECT id, chat_id, ts, kind, trigger, reasoning,
               push_text, observation_id, milestone_id, jsonl_session_id, memory_path
        FROM events;
      DROP TABLE events;
      ALTER TABLE events_new RENAME TO events;
      CREATE INDEX events_chat_ts ON events(chat_id, ts DESC);
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

/**
 * Convenience wrapper that resolves the daemon's canonical state file
 * (`<stateDir>/wechat-cc.db`) and opens it. Used by the CLI leaf commands
 * — every read-only `wechat-cc <noun> list` path goes through here so the
 * boilerplate isn't repeated 10× across cli.ts.
 *
 * For tests / non-canonical paths, use `openDb({ path })` directly.
 */
export function openWechatDb(stateDir: string): Database {
  return openDb({ path: join(stateDir, 'wechat-cc.db') })
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
  runMigrations(db)
  return db
}

/**
 * Apply any migrations whose index is greater than the database's current
 * PRAGMA user_version. Exported so tests can drive the runner against a
 * pre-populated in-memory db (e.g. simulating an upgrade from v9).
 */
export function runMigrations(db: Database): void {
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

/**
 * Mark a legacy state file as imported by renaming it to `<file>.migrated`.
 *
 * Concurrent-first-boot safety: when daemon + CLI both boot against a
 * pre-PR7 install, both can pass the `existsSync` gate in their store
 * factories, both run their (idempotent) INSERT OR REPLACE/IGNORE
 * transactions, and both reach the rename. The first wins; the second's
 * `renameSync` would throw ENOENT and propagate as an unhelpful error
 * out of the store constructor. Swallow ENOENT here — the file being
 * gone IS the success state.
 *
 * Other errors (EACCES, ENOSPC, …) still propagate.
 */
export function renameMigrated(file: string): void {
  try {
    renameSync(file, `${file}.migrated`)
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return
    throw err
  }
}
