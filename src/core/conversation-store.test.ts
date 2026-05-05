import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
