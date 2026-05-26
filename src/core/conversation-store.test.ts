import { afterEach, beforeEach, describe, expect, it, test } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { makeConversationStore } from './conversation-store'
import { modeRequiresParticipantPrefix } from './conversation'
import { openTestDb, openDb, type Db } from '../lib/db'

describe('ConversationStore', () => {
  let dir: string
  let db: Db
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'conv-store-'))
    db = openTestDb()
  })
  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('starts empty', () => {
    const s = makeConversationStore(db)
    expect(s.get('chat-1')).toBeNull()
    expect(s.all()).toEqual({})
  })

  it('set + get for solo mode', () => {
    const s = makeConversationStore(db)
    s.set('chat-1', { kind: 'solo', provider: 'codex' })
    const r = s.get('chat-1')
    expect(r?.mode).toEqual({ kind: 'solo', provider: 'codex' })
  })

  it('set replaces previous mode for the same chat', () => {
    const s = makeConversationStore(db)
    s.set('chat-1', { kind: 'solo', provider: 'claude' })
    s.set('chat-1', { kind: 'solo', provider: 'codex' })
    expect(s.get('chat-1')?.mode).toEqual({ kind: 'solo', provider: 'codex' })
  })

  it('set works for parallel and chatroom modes (no provider field)', () => {
    const s = makeConversationStore(db)
    s.set('chat-a', { kind: 'parallel' })
    s.set('chat-b', { kind: 'chatroom' })
    s.set('chat-c', { kind: 'primary_tool', primary: 'claude' })
    expect(s.get('chat-a')?.mode).toEqual({ kind: 'parallel' })
    expect(s.get('chat-b')?.mode).toEqual({ kind: 'chatroom' })
    expect(s.get('chat-c')?.mode).toEqual({ kind: 'primary_tool', primary: 'claude' })
  })

  it('delete removes the record', () => {
    const s = makeConversationStore(db)
    s.set('chat-1', { kind: 'solo', provider: 'codex' })
    s.delete('chat-1')
    expect(s.get('chat-1')).toBeNull()
  })

  it('persists across instances (same db file)', async () => {
    const path = join(dir, 'wechat-cc.db')
    const d1 = openDb({ path })
    try {
      const s1 = makeConversationStore(d1)
      s1.set('chat-1', { kind: 'solo', provider: 'codex' })
      s1.set('chat-2', { kind: 'parallel' })
      await s1.flush()
    } finally { d1.close() }
    const d2 = openDb({ path })
    try {
      const s2 = makeConversationStore(d2)
      expect(s2.get('chat-1')?.mode).toEqual({ kind: 'solo', provider: 'codex' })
      expect(s2.get('chat-2')?.mode).toEqual({ kind: 'parallel' })
    } finally { d2.close() }
  })

  it('all() returns a snapshot copy (independent of subsequent set)', () => {
    const s = makeConversationStore(db)
    s.set('chat-1', { kind: 'solo', provider: 'claude' })
    const snap = s.all()
    s.set('chat-2', { kind: 'parallel' })
    expect(Object.keys(snap)).toEqual(['chat-1'])
  })

  describe('identity (PR5 Task 19)', () => {
    it('upsertIdentity + getIdentity round-trip', () => {
      const s = makeConversationStore(db)
      s.upsertIdentity('c1', { userId: 'u1', accountId: 'a1', userName: '张三' })
      expect(s.getIdentity('c1')).toEqual({
        user_id: 'u1',
        account_id: 'a1',
        last_user_name: '张三',
      })
    })

    it('upsertIdentity preserves existing mode (does not clobber set())', () => {
      const s = makeConversationStore(db)
      s.set('c1', { kind: 'solo', provider: 'codex' })
      s.upsertIdentity('c1', { userId: 'u1', accountId: 'a1' })
      expect(s.get('c1')?.mode).toEqual({ kind: 'solo', provider: 'codex' })
      expect(s.getIdentity('c1')?.user_id).toBe('u1')
    })

    it('upsertIdentity merges — undefined args preserve, defined overwrite', () => {
      const s = makeConversationStore(db)
      s.upsertIdentity('c1', { userId: 'u1', accountId: 'a1', userName: '张三' })
      // Second call: only userName changes; userId/accountId omitted should preserve
      s.upsertIdentity('c1', { userName: '张三 (renamed)' })
      expect(s.getIdentity('c1')).toEqual({
        user_id: 'u1',
        account_id: 'a1',
        last_user_name: '张三 (renamed)',
      })
    })

    it('getIdentity returns null for unknown chat', () => {
      const s = makeConversationStore(db)
      expect(s.getIdentity('c-unknown')).toBeNull()
    })

    it('upsertIdentity for new chat inserts a row with default mode (solo+claude)', () => {
      const s = makeConversationStore(db)
      s.upsertIdentity('c1', { userId: 'u1' })
      // The row exists and has the default mode — get() should return it
      expect(s.get('c1')?.mode).toEqual({ kind: 'solo', provider: 'claude' })
    })
  })

  describe('legacy file migration', () => {
    it('imports a v1 conversations.json and renames it .migrated', () => {
      const file = join(dir, 'conversations.json')
      writeFileSync(file, JSON.stringify({
        version: 1,
        conversations: {
          'chat-x': { mode: { kind: 'solo', provider: 'codex' } },
          'chat-y': { mode: { kind: 'parallel' } },
          'chat-z': { mode: { kind: 'primary_tool', primary: 'claude' } },
        },
      }))
      const s = makeConversationStore(db, { migrateFromFile: file })
      expect(s.get('chat-x')?.mode).toEqual({ kind: 'solo', provider: 'codex' })
      expect(s.get('chat-y')?.mode).toEqual({ kind: 'parallel' })
      expect(s.get('chat-z')?.mode).toEqual({ kind: 'primary_tool', primary: 'claude' })
      expect(existsSync(file)).toBe(false)
      expect(existsSync(`${file}.migrated`)).toBe(true)
    })

    it('drops half-formed legacy records (solo without provider, primary_tool without primary)', () => {
      const file = join(dir, 'conversations.json')
      writeFileSync(file, JSON.stringify({
        version: 1,
        conversations: {
          'bad-1': { mode: { kind: 'solo' } as any },
          'bad-2': { mode: { kind: 'primary_tool' } as any },
          'good': { mode: { kind: 'solo', provider: 'claude' } },
        },
      }))
      const s = makeConversationStore(db, { migrateFromFile: file })
      expect(s.get('bad-1')).toBeNull()
      expect(s.get('bad-2')).toBeNull()
      expect(s.get('good')?.mode).toEqual({ kind: 'solo', provider: 'claude' })
    })

    it('preserves the file when JSON is corrupt', () => {
      const file = join(dir, 'conversations.json')
      writeFileSync(file, '{not json')
      const s = makeConversationStore(db, { migrateFromFile: file })
      expect(s.all()).toEqual({})
      expect(existsSync(file)).toBe(true)
      expect(existsSync(`${file}.migrated`)).toBe(false)
    })

    it('is idempotent — second construction with same opt is a no-op', () => {
      const file = join(dir, 'conversations.json')
      writeFileSync(file, JSON.stringify({
        version: 1,
        conversations: { 'chat-1': { mode: { kind: 'parallel' } } },
      }))
      makeConversationStore(db, { migrateFromFile: file })
      const s2 = makeConversationStore(db, { migrateFromFile: file })
      expect(s2.get('chat-1')?.mode).toEqual({ kind: 'parallel' })
    })
  })

  // PR5 Task 21 — nameStore deprecation. The legacy user_names.json
  // is now backfilled into conversations.last_user_name on first boot
  // so the IlinkAdapter's resolveUserName can read from a single source.
  describe('user_names.json backfill', () => {
    it('populates last_user_name from a legacy user_names.json', () => {
      const file = join(dir, 'user_names.json')
      writeFileSync(file, JSON.stringify({ c1: '张三', c2: 'Alice' }))
      const s = makeConversationStore(db, { migrateFromUserNamesFile: file })
      expect(s.getIdentity('c1')?.last_user_name).toBe('张三')
      expect(s.getIdentity('c2')?.last_user_name).toBe('Alice')
    })

    it('renames source file to .migrated after import', () => {
      const file = join(dir, 'user_names.json')
      writeFileSync(file, JSON.stringify({ c1: 'A' }))
      makeConversationStore(db, { migrateFromUserNamesFile: file })
      expect(existsSync(file)).toBe(false)
      expect(existsSync(`${file}.migrated`)).toBe(true)
    })

    it('silently skips a missing user_names.json (no throw)', () => {
      // Construction must not throw when the file is absent.
      const s = makeConversationStore(db, {
        migrateFromUserNamesFile: join(dir, 'definitely-missing.json'),
      })
      expect(s.all()).toEqual({})
    })

    it('preserves an existing last_user_name when backfill races mw-identity', () => {
      // Pre-seed a row with a fresher name (simulates mw-identity populating
      // it on a live inbound before backfill runs).
      const s0 = makeConversationStore(db)
      s0.upsertIdentity('c1', { userName: '新名字' })

      const file = join(dir, 'user_names.json')
      writeFileSync(file, JSON.stringify({ c1: '旧名字' }))
      const s = makeConversationStore(db, { migrateFromUserNamesFile: file })
      expect(s.getIdentity('c1')?.last_user_name).toBe('新名字')
    })
  })

  describe('chatsForAccount (PR5 Task 23 — replaces in-memory accountChatIndex)', () => {
    it('returns chats whose account_id matches', () => {
      const store = makeConversationStore(openTestDb())
      store.upsertIdentity('c1', { accountId: 'a1' })
      store.upsertIdentity('c2', { accountId: 'a1' })
      store.upsertIdentity('c3', { accountId: 'a2' })
      expect([...store.chatsForAccount('a1')].sort()).toEqual(['c1', 'c2'])
      expect(store.chatsForAccount('a2')).toEqual(['c3'])
      expect(store.chatsForAccount('unknown')).toEqual([])
    })

    it('ignores empty accountId', () => {
      const store = makeConversationStore(openTestDb())
      store.upsertIdentity('c1', { accountId: 'a1' })
      expect(store.chatsForAccount('')).toEqual([])
    })
  })
})

describe('conversation-store — participants', () => {
  test('round-trips chatroom mode with explicit participants', () => {
    const db = openDb({ path: ':memory:' })
    const store = makeConversationStore(db)
    store.set('chat-3way', { kind: 'chatroom', participants: ['claude', 'codex', 'cursor'] })
    const got = store.get('chat-3way')
    expect(got?.mode).toEqual({ kind: 'chatroom', participants: ['claude', 'codex', 'cursor'] })
  })

  test('round-trips parallel mode with explicit participants', () => {
    const db = openDb({ path: ':memory:' })
    const store = makeConversationStore(db)
    store.set('chat-par', { kind: 'parallel', participants: ['claude', 'cursor'] })
    const got = store.get('chat-par')
    expect(got?.mode).toEqual({ kind: 'parallel', participants: ['claude', 'cursor'] })
  })

  test('omits participants field when undefined (no JSON in DB)', () => {
    const db = openDb({ path: ':memory:' })
    const store = makeConversationStore(db)
    store.set('chat-default', { kind: 'parallel' })
    const got = store.get('chat-default')
    // Mode comes back without the participants key (undefined, not null).
    expect(got?.mode).toEqual({ kind: 'parallel' })
    expect('participants' in (got!.mode as object)).toBe(false)
  })

  test('hydrates legacy row (no participants column populated) as undefined', () => {
    const db = openDb({ path: ':memory:' })
    db.exec(
      "INSERT INTO conversations(chat_id, mode_kind, mode_provider, mode_primary, updated_at) " +
      "VALUES ('legacy', 'chatroom', NULL, NULL, '2026-05-22T00:00:00.000Z')"
    )
    const store = makeConversationStore(db)
    const got = store.get('legacy')
    expect(got?.mode).toEqual({ kind: 'chatroom' })
  })

  test('setParticipants updates only the participants column', () => {
    const db = openDb({ path: ':memory:' })
    const store = makeConversationStore(db)
    store.set('chat-bf', { kind: 'chatroom' })
    store.setParticipants('chat-bf', ['claude', 'codex'])
    const got = store.get('chat-bf')
    expect(got?.mode).toEqual({ kind: 'chatroom', participants: ['claude', 'codex'] })
  })

  test('setParticipants is a no-op on a chat with no row', () => {
    const db = openDb({ path: ':memory:' })
    const store = makeConversationStore(db)
    // Should not throw, should not insert a synthetic row.
    store.setParticipants('nonexistent', ['claude', 'codex'])
    expect(store.get('nonexistent')).toBeNull()
  })

  test('rejects setParticipants on solo/primary_tool modes (only parallel/chatroom support it)', () => {
    const db = openDb({ path: ':memory:' })
    const store = makeConversationStore(db)
    store.set('chat-solo', { kind: 'solo', provider: 'claude' })
    expect(() => store.setParticipants('chat-solo', ['claude', 'codex']))
      .toThrow(/only parallel\/chatroom/)
  })

  test('set(chatroom-without-participants) preserves prior participant list (COALESCE)', () => {
    // Regression: `/chat claude codex` → `/solo` → `/chat` (no args)
    // previously wiped the participants column to NULL on the third
    // upsert because excluded.participants was NULL. The COALESCE in
    // stmtUpsert keeps the prior list around for re-entry.
    const db = openDb({ path: ':memory:' })
    const store = makeConversationStore(db)
    store.set('chat', { kind: 'chatroom', participants: ['claude', 'codex'] })
    store.set('chat', { kind: 'solo', provider: 'claude' })
    store.set('chat', { kind: 'chatroom' })  // no participants → must NOT clobber
    expect(store.get('chat')?.mode).toEqual({ kind: 'chatroom', participants: ['claude', 'codex'] })
  })

  test('set(chatroom-with-participants) overwrites prior list', () => {
    // Explicit list still takes precedence over the COALESCE preserve.
    const db = openDb({ path: ':memory:' })
    const store = makeConversationStore(db)
    store.set('chat', { kind: 'chatroom', participants: ['claude', 'codex'] })
    store.set('chat', { kind: 'chatroom', participants: ['claude', 'cursor'] })
    expect(store.get('chat')?.mode).toEqual({ kind: 'chatroom', participants: ['claude', 'cursor'] })
  })
})

describe('modeRequiresParticipantPrefix (RFC 03 review #5)', () => {
  it('returns true for parallel + chatroom (multi-participant modes)', () => {
    expect(modeRequiresParticipantPrefix({ kind: 'parallel' })).toBe(true)
    expect(modeRequiresParticipantPrefix({ kind: 'chatroom' })).toBe(true)
  })

  it('returns false for solo + primary_tool (single-visible-speaker modes)', () => {
    expect(modeRequiresParticipantPrefix({ kind: 'solo', provider: 'claude' })).toBe(false)
    expect(modeRequiresParticipantPrefix({ kind: 'solo', provider: 'codex' })).toBe(false)
    expect(modeRequiresParticipantPrefix({ kind: 'primary_tool', primary: 'claude' })).toBe(false)
    expect(modeRequiresParticipantPrefix({ kind: 'primary_tool', primary: 'codex' })).toBe(false)
  })
})
