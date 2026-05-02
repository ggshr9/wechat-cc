/**
 * Migration smoke test — populates a fake state dir with every legacy
 * file format we ever shipped, then constructs each SQLite-backed store
 * with `migrateFromFile` pointing at it and asserts:
 *
 *   1. All 7 legacy files are renamed to `*.migrated` after first
 *      construction.
 *   2. The SQLite db has the expected rows for each store (counts +
 *      sample reads through the public API).
 *   3. The 7 schema tables all exist (PRAGMA user_version = 7).
 *   4. Re-constructing the same stores against the same db is a no-op
 *      (idempotent — the rename leaves no source to re-import).
 *
 * This is the "before-release" check we promised in PR #13's release
 * note. Per-store unit tests cover individual migration paths in
 * isolation; this test exercises the cross-store wiring an upgrading
 * user actually hits on first daemon boot.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type Db } from './db'
import { makeSessionStateStore } from '../daemon/session-state'
import { makeSessionStore } from '../core/session-store'
import { makeConversationStore } from '../core/conversation-store'
import { makeActivityStore } from '../daemon/activity/store'
import { makeMilestonesStore } from '../daemon/milestones/store'
import { makeObservationsStore } from '../daemon/observations/store'
import { makeEventsStore } from '../daemon/events/store'

interface ChatFixture {
  chatId: string
  events: number
  observations: number
  milestones: number
  activityDays: number
}

const CHAT_A: ChatFixture = { chatId: 'chat_a', events: 3, observations: 2, milestones: 1, activityDays: 4 }
const CHAT_B: ChatFixture = { chatId: 'chat_b', events: 1, observations: 1, milestones: 0, activityDays: 2 }

describe('full state-dir migration — upgrading-user smoke', () => {
  let stateDir: string
  let db: Db

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'wechat-state-mig-'))
    fixtureLegacyFiles(stateDir, [CHAT_A, CHAT_B])
    db = openDb({ path: join(stateDir, 'wechat-cc.db') })
  })

  afterEach(() => {
    db.close()
    rmSync(stateDir, { recursive: true, force: true })
  })

  it('opens a fresh db with PRAGMA user_version = 7 and the 7 tables', () => {
    const v = (db.query('PRAGMA user_version').get() as { user_version: number }).user_version
    expect(v).toBe(7)
    const tables = db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>
    expect(tables.map(t => t.name)).toEqual([
      'activity', 'conversations', 'events', 'milestones', 'observations', 'session_state', 'sessions',
    ])
  })

  it('migrates session_state.json + sessions.json + conversations.json on first store construction', () => {
    const sessionState = makeSessionStateStore(db, { migrateFromFile: join(stateDir, 'session-state.json') })
    const sessions = makeSessionStore(db, { migrateFromFile: join(stateDir, 'sessions.json') })
    const conversations = makeConversationStore(db, { migrateFromFile: join(stateDir, 'conversations.json') })

    // session_state — 2 expired bots from the fixture.
    expect(sessionState.listExpired()).toHaveLength(2)
    const botA = sessionState.listExpired().find(b => b.id === 'bot-A')
    expect(botA?.last_reason).toBe('errcode=-14')

    // sessions — composite (alias, provider) PK; the fixture has 2 aliases:
    //   compass: claude session
    //   mobile:  codex session
    expect(sessions.get('compass', 'claude')?.session_id).toBe('sid-claude-1')
    expect(sessions.get('mobile', 'codex')?.session_id).toBe('sid-codex-1')
    // get() without provider returns the most-recently-used row.
    expect(sessions.get('compass')?.provider).toBe('claude')

    // conversations — 3 chats, 3 modes.
    expect(conversations.get(CHAT_A.chatId)?.mode).toEqual({ kind: 'solo', provider: 'claude' })
    expect(conversations.get(CHAT_B.chatId)?.mode).toEqual({ kind: 'parallel' })
    expect(conversations.get('chat_pt')?.mode).toEqual({ kind: 'primary_tool', primary: 'codex' })

    // All 3 top-level files are now .migrated.
    for (const fname of ['session-state.json', 'sessions.json', 'conversations.json']) {
      expect(existsSync(join(stateDir, fname))).toBe(false)
      expect(existsSync(join(stateDir, `${fname}.migrated`))).toBe(true)
    }
  })

  it('migrates per-chat jsonls (events / observations / milestones / activity) on first store construction', async () => {
    for (const chat of [CHAT_A, CHAT_B]) {
      const memRoot = join(stateDir, 'memory')
      const events = makeEventsStore(db, chat.chatId, { migrateFromFile: join(memRoot, chat.chatId, 'events.jsonl') })
      const observations = makeObservationsStore(db, chat.chatId, {
        ttlDays: 365_000,  // wide window so fixture rows aren't TTL-filtered
        migrateFromFile: join(memRoot, chat.chatId, 'observations.jsonl'),
      })
      const milestones = makeMilestonesStore(db, chat.chatId, { migrateFromFile: join(memRoot, chat.chatId, 'milestones.jsonl') })
      const activity = makeActivityStore(db, chat.chatId, { migrateFromFile: join(memRoot, chat.chatId, 'activity.jsonl') })

      expect(await events.list()).toHaveLength(chat.events)
      expect(await observations.listActive()).toHaveLength(chat.observations)
      expect(await milestones.list()).toHaveLength(chat.milestones)
      // Activity uses recentDays; pass a wide window since the fixture
      // dates are pinned to 2026-04 and the test runs in CI months later.
      expect(await activity.recentDays(365_000)).toHaveLength(chat.activityDays)

      // Each chat's 4 jsonls are now .migrated.
      for (const fname of ['events.jsonl', 'observations.jsonl', 'milestones.jsonl', 'activity.jsonl']) {
        const path = join(memRoot, chat.chatId, fname)
        expect(existsSync(path)).toBe(false)
        expect(existsSync(`${path}.migrated`)).toBe(true)
      }
    }
  })

  it('isolates per-chat data — chat_a events do not leak into chat_b reads', async () => {
    const memRoot = join(stateDir, 'memory')
    const eventsA = makeEventsStore(db, CHAT_A.chatId, { migrateFromFile: join(memRoot, CHAT_A.chatId, 'events.jsonl') })
    const eventsB = makeEventsStore(db, CHAT_B.chatId, { migrateFromFile: join(memRoot, CHAT_B.chatId, 'events.jsonl') })
    const a = await eventsA.list()
    const b = await eventsB.list()
    expect(a.map(e => e.id).every(id => id.startsWith('evt_a_'))).toBe(true)
    expect(b.map(e => e.id).every(id => id.startsWith('evt_b_'))).toBe(true)
    expect(a).toHaveLength(CHAT_A.events)
    expect(b).toHaveLength(CHAT_B.events)
  })

  it('is idempotent — second store construction is a no-op', async () => {
    // First pass: migrate everything.
    makeSessionStateStore(db, { migrateFromFile: join(stateDir, 'session-state.json') })
    makeSessionStore(db, { migrateFromFile: join(stateDir, 'sessions.json') })
    makeConversationStore(db, { migrateFromFile: join(stateDir, 'conversations.json') })
    for (const chat of [CHAT_A, CHAT_B]) {
      const memRoot = join(stateDir, 'memory')
      makeEventsStore(db, chat.chatId, { migrateFromFile: join(memRoot, chat.chatId, 'events.jsonl') })
      makeObservationsStore(db, chat.chatId, { migrateFromFile: join(memRoot, chat.chatId, 'observations.jsonl') })
      makeMilestonesStore(db, chat.chatId, { migrateFromFile: join(memRoot, chat.chatId, 'milestones.jsonl') })
      makeActivityStore(db, chat.chatId, { migrateFromFile: join(memRoot, chat.chatId, 'activity.jsonl') })
    }
    const beforeRowCounts = countAllRows(db)

    // Second pass: re-construct with the same options. All legacy files
    // are already renamed to .migrated, so the existsSync gate inside
    // each store's maybeImportLegacy returns early. No duplicate rows.
    makeSessionStateStore(db, { migrateFromFile: join(stateDir, 'session-state.json') })
    makeSessionStore(db, { migrateFromFile: join(stateDir, 'sessions.json') })
    makeConversationStore(db, { migrateFromFile: join(stateDir, 'conversations.json') })
    for (const chat of [CHAT_A, CHAT_B]) {
      const memRoot = join(stateDir, 'memory')
      makeEventsStore(db, chat.chatId, { migrateFromFile: join(memRoot, chat.chatId, 'events.jsonl') })
      makeObservationsStore(db, chat.chatId, { migrateFromFile: join(memRoot, chat.chatId, 'observations.jsonl') })
      makeMilestonesStore(db, chat.chatId, { migrateFromFile: join(memRoot, chat.chatId, 'milestones.jsonl') })
      makeActivityStore(db, chat.chatId, { migrateFromFile: join(memRoot, chat.chatId, 'activity.jsonl') })
    }
    const afterRowCounts = countAllRows(db)

    expect(afterRowCounts).toEqual(beforeRowCounts)
  })

  it('preserves a corrupt JSON file (no rename) so a fixer can inspect it', () => {
    const file = join(stateDir, 'session-state.json')
    writeFileSync(file, '{not valid json')
    const sessionState = makeSessionStateStore(db, { migrateFromFile: file })
    expect(sessionState.listExpired()).toEqual([])
    // Corrupt file is preserved — same posture as the per-store unit
    // tests cover individually, but worth exercising at the cross-
    // store level too because that's what an upgrading user with one
    // bad file actually hits.
    expect(existsSync(file)).toBe(true)
    expect(existsSync(`${file}.migrated`)).toBe(false)
  })
})

// ── fixture builders ─────────────────────────────────────────────────

function fixtureLegacyFiles(stateDir: string, chats: ChatFixture[]): void {
  // Top-level: session-state.json
  writeFileSync(
    join(stateDir, 'session-state.json'),
    JSON.stringify({
      version: 1,
      bots: {
        'bot-A': { status: 'expired', first_seen_expired_at: '2026-04-01T00:00:00.000Z', last_reason: 'errcode=-14' },
        'bot-B': { status: 'expired', first_seen_expired_at: '2026-04-02T00:00:00.000Z' },
      },
    }),
  )

  // Top-level: sessions.json — alias × provider.
  writeFileSync(
    join(stateDir, 'sessions.json'),
    JSON.stringify({
      version: 1,
      sessions: {
        compass: { session_id: 'sid-claude-1', last_used_at: '2026-04-10T00:00:00.000Z', provider: 'claude' },
        mobile: { session_id: 'sid-codex-1', last_used_at: '2026-04-11T00:00:00.000Z', provider: 'codex', summary: 'mobile chat', summary_updated_at: '2026-04-12T00:00:00.000Z' },
      },
    }),
  )

  // Top-level: conversations.json — covers all 4 mode kinds we ever shipped.
  writeFileSync(
    join(stateDir, 'conversations.json'),
    JSON.stringify({
      version: 1,
      conversations: {
        [CHAT_A.chatId]: { mode: { kind: 'solo', provider: 'claude' } },
        [CHAT_B.chatId]: { mode: { kind: 'parallel' } },
        chat_pt: { mode: { kind: 'primary_tool', primary: 'codex' } },
        chat_room: { mode: { kind: 'chatroom' } },
      },
    }),
  )

  // Per-chat memory dirs.
  for (const chat of chats) {
    const memDir = join(stateDir, 'memory', chat.chatId)
    mkdirSync(memDir, { recursive: true })

    // events.jsonl — id-prefixed by chat for cross-isolation testing.
    const eventLines: string[] = []
    for (let i = 0; i < chat.events; i++) {
      eventLines.push(JSON.stringify({
        id: `evt_${chat.chatId.slice(-1)}_${i}`,  // chat_a → evt_a_0; chat_b → evt_b_0
        ts: `2026-04-${String(20 + i).padStart(2, '0')}T08:00:00.000Z`,
        kind: 'cron_eval_skipped' as const,
        trigger: 'hourly',
        reasoning: `fixture event ${i} for ${chat.chatId}`,
      }))
    }
    writeFileSync(join(memDir, 'events.jsonl'), eventLines.join('\n') + (eventLines.length ? '\n' : ''))

    // observations.jsonl
    const obsLines: string[] = []
    for (let i = 0; i < chat.observations; i++) {
      obsLines.push(JSON.stringify({
        id: `obs_${chat.chatId.slice(-1)}_${i}`,
        ts: `2026-04-${String(15 + i).padStart(2, '0')}T08:00:00.000Z`,
        body: `fixture observation ${i}`,
        archived: false,
      }))
    }
    writeFileSync(join(memDir, 'observations.jsonl'), obsLines.join('\n') + (obsLines.length ? '\n' : ''))

    // milestones.jsonl
    const msLines: string[] = []
    for (let i = 0; i < chat.milestones; i++) {
      msLines.push(JSON.stringify({
        id: `ms_${chat.chatId.slice(-1)}_fixture_${i}`,
        ts: `2026-04-${String(10 + i).padStart(2, '0')}T08:00:00.000Z`,
        body: `fixture milestone ${i}`,
      }))
    }
    writeFileSync(join(memDir, 'milestones.jsonl'), msLines.join('\n') + (msLines.length ? '\n' : ''))

    // activity.jsonl
    const actLines: string[] = []
    for (let i = 0; i < chat.activityDays; i++) {
      const date = `2026-04-${String(20 + i).padStart(2, '0')}`
      actLines.push(JSON.stringify({
        date,
        first_msg_ts: `${date}T08:00:00.000Z`,
        msg_count: i + 1,
      }))
    }
    writeFileSync(join(memDir, 'activity.jsonl'), actLines.join('\n') + (actLines.length ? '\n' : ''))
  }
}

function countAllRows(db: Db): Record<string, number> {
  const tables = ['session_state', 'sessions', 'conversations', 'activity', 'milestones', 'observations', 'events']
  const out: Record<string, number> = {}
  for (const t of tables) {
    const row = db.query(`SELECT COUNT(*) as n FROM ${t}`).get() as { n: number }
    out[t] = row.n
  }
  return out
}
