import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openTestDb } from '../lib/db'
import {
  backfillFromClaudeJsonl, claudeTurnToMessages, backfillFromCodexJsonl,
  dialogueTimeline, dialogueThreads, dialogueSearch, dialogueThreadDetail,
  dialogueLockSet, dialogueUnlock,
} from './dialogue'
import { loadAgentConfig, saveAgentConfig } from '../lib/agent-config'
import { makeMessagesStore } from '../lib/messages-store'
import { makeThreadsStore } from '../lib/threads-store'

describe('dialogue backfill', () => {
  it('claudeTurnToMessages maps user/assistant turns to in/out records', () => {
    const recs = claudeTurnToMessages(
      { type: 'user', ts: '2026-06-01T00:00:00Z', text: '你好' },
      'chat1', 'sess1', 0,
    )
    expect(recs[0]).toMatchObject({ chatId: 'chat1', direction: 'in', text: '你好', source: 'backfill:claude', id: 'bf:claude:sess1:0' })
  })

  it('claudeTurnToMessages maps assistant turns to out with provider=claude', () => {
    const recs = claudeTurnToMessages(
      { type: 'assistant', ts: '2026-06-01T00:00:05Z', text: '你好啊' },
      'chat1', 'sess1', 1,
    )
    expect(recs[0]).toMatchObject({ chatId: 'chat1', direction: 'out', text: '你好啊', source: 'backfill:claude', provider: 'claude' })
  })

  it('backfill is idempotent — second run adds nothing', async () => {
    const db = openTestDb()
    const dir = mkdtempSync(join(tmpdir(), 'bf-'))
    writeFileSync(join(dir, 's1.jsonl'), [
      JSON.stringify({ type: 'user', message: { content: '第一句' }, timestamp: '2026-06-01T00:00:00Z' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '回复' }] }, timestamp: '2026-06-01T00:00:05Z' }),
    ].join('\n'))
    const r1 = await backfillFromClaudeJsonl(db, dir, 'chat1')
    const r2 = await backfillFromClaudeJsonl(db, dir, 'chat1')
    expect(r1.inserted).toBe(2)
    expect(r2.inserted).toBe(0)
    expect(db.query('SELECT COUNT(*) c FROM messages').get()).toEqual({ c: 2 })
  })

  it('backfill dry-run: scans but does not write', async () => {
    const db = openTestDb()
    const dir = mkdtempSync(join(tmpdir(), 'bf-dry-'))
    writeFileSync(join(dir, 's1.jsonl'), [
      JSON.stringify({ type: 'user', message: { content: 'hello' }, timestamp: '2026-06-01T00:00:00Z' }),
    ].join('\n'))
    const r = await backfillFromClaudeJsonl(db, dir, 'chat1', true)
    expect(r.scanned).toBe(1)
    expect(r.inserted).toBe(0)
    expect(db.query('SELECT COUNT(*) c FROM messages').get()).toEqual({ c: 0 })
  })

  it('backfill skips lines with missing timestamp', async () => {
    const db = openTestDb()
    const dir = mkdtempSync(join(tmpdir(), 'bf-skip-'))
    writeFileSync(join(dir, 's1.jsonl'), [
      JSON.stringify({ type: 'user', message: { content: 'hello' } }), // no timestamp — skip
      JSON.stringify({ type: 'user', message: { content: 'world' }, timestamp: '2026-06-01T00:00:01Z' }),
    ].join('\n'))
    const r = await backfillFromClaudeJsonl(db, dir, 'chat1')
    expect(r.scanned).toBe(1)
    expect(r.inserted).toBe(1)
  })

  it('backfillFromCodexJsonl maps codex turns correctly and uses envelope timestamps', async () => {
    const db = openTestDb()
    // Build a fake codex root: <root>/YYYY/MM/DD/rollout-<ts>-<id>.jsonl
    const root = mkdtempSync(join(tmpdir(), 'codex-'))
    const dayDir = join(root, '2026', '06', '01')
    mkdirSync(dayDir, { recursive: true })
    const rolloutPath = join(dayDir, 'rollout-2026-06-01T10-00-00-abc123.jsonl')
    writeFileSync(rolloutPath, [
      JSON.stringify({ timestamp: '2026-06-01T10:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '你好 codex' }] } }),
      JSON.stringify({ timestamp: '2026-06-01T10:00:05.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '回复来自 codex' }] } }),
      JSON.stringify({ type: 'session_meta', payload: {} }), // should be skipped
    ].join('\n'))
    const r = await backfillFromCodexJsonl(db, root, 'chat1')
    expect(r.scanned).toBe(2)
    expect(r.inserted).toBe(2)
    const rows = db.query<{ direction: string; text: string; ts: string; provider: string | null; source: string }, []>(
      'SELECT direction, text, ts, provider, source FROM messages ORDER BY ts ASC'
    ).all()
    expect(rows[0]).toMatchObject({ direction: 'in', text: '你好 codex', ts: '2026-06-01T10:00:01.000Z', source: 'backfill:codex' })
    expect(rows[1]).toMatchObject({ direction: 'out', text: '回复来自 codex', ts: '2026-06-01T10:00:05.000Z', provider: 'codex', source: 'backfill:codex' })
  })

  it('backfillFromCodexJsonl uses filename-anchor fallback when envelope has no timestamp', async () => {
    const db = openTestDb()
    const root = mkdtempSync(join(tmpdir(), 'codex-anchor-'))
    const dayDir = join(root, '2025', '11', '25')
    mkdirSync(dayDir, { recursive: true })
    // Filename encodes 2025-11-25T02:41:55; lines have NO envelope timestamp
    writeFileSync(join(dayDir, 'rollout-2025-11-25T02-41-55-def999.jsonl'), [
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'anchor test' }] } }),
    ].join('\n'))
    const r = await backfillFromCodexJsonl(db, root, 'chat2')
    expect(r.scanned).toBe(1)
    expect(r.inserted).toBe(1)
    const row = db.query<{ ts: string }, []>('SELECT ts FROM messages').get()!
    // ts should be derived from the filename anchor 2025-11-25T02:41:55Z (+ 1ms for idx=1)
    expect(row.ts).toMatch(/^2025-11-25T02:41:55/)
  })

  it('backfillFromCodexJsonl skips turns with no timestamp source (neither envelope nor filename anchor)', async () => {
    const db = openTestDb()
    const root = mkdtempSync(join(tmpdir(), 'codex-nots-'))
    const dayDir = join(root, '2026', '06', '01')
    mkdirSync(dayDir, { recursive: true })
    // Filename has no parseable timestamp pattern; lines also have no envelope timestamp.
    // The turn is counted as scanned (text passes the empty guard) but not inserted.
    writeFileSync(join(dayDir, 'rollout-1234567890-abc123.jsonl'), [
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'no ts' }] } }),
    ].join('\n'))
    const r = await backfillFromCodexJsonl(db, root, 'chat3')
    expect(r.scanned).toBe(1)
    expect(r.inserted).toBe(0)
    expect(db.query('SELECT COUNT(*) c FROM messages').get()).toEqual({ c: 0 })
  })

  it('backfillFromCodexJsonl is idempotent', async () => {
    const db = openTestDb()
    const root = mkdtempSync(join(tmpdir(), 'codex-idem-'))
    const dayDir = join(root, '2026', '06', '01')
    mkdirSync(dayDir, { recursive: true })
    writeFileSync(join(dayDir, 'rollout-2026-06-01T00-00-00-def456.jsonl'), [
      JSON.stringify({ timestamp: '2026-06-01T00:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'repeat' }] } }),
    ].join('\n'))
    const r1 = await backfillFromCodexJsonl(db, root, 'chat1')
    const r2 = await backfillFromCodexJsonl(db, root, 'chat1')
    expect(r1.inserted).toBe(1)
    expect(r2.inserted).toBe(0)
    expect(db.query('SELECT COUNT(*) c FROM messages').get()).toEqual({ c: 1 })
  })

  it('backfillFromCodexJsonl handles missing root gracefully', async () => {
    const db = openTestDb()
    const r = await backfillFromCodexJsonl(db, '/tmp/__nonexistent_codex_root__', 'chat1')
    expect(r.scanned).toBe(0)
    expect(r.inserted).toBe(0)
  })
})

// ── Helpers ───────────────────────────────────────────────────────────

/** Insert N messages with sequential ts values (ms-spaced) into the db. */
async function seedMessages(db: ReturnType<typeof openTestDb>, chatId: string, n: number, opts?: { startMs?: number }): Promise<void> {
  const store = makeMessagesStore(db)
  const base = opts?.startMs ?? 1_700_000_000_000
  for (let i = 0; i < n; i++) {
    await store.append({
      id: `msg:${chatId}:${i}`,
      chatId,
      ts: new Date(base + i * 1000).toISOString(),
      direction: i % 2 === 0 ? 'in' : 'out',
      kind: 'text',
      text: `message ${i}`,
      source: 'live',
    })
  }
}

// ── dialogueTimeline tests ────────────────────────────────────────────

describe('dialogueTimeline', () => {
  it('returns messages in ascending order with hasMore=false when total < limit', async () => {
    const db = openTestDb()
    await seedMessages(db, 'chat1', 5)
    const result = await dialogueTimeline(db, 'chat1', { limit: 10 })
    expect(result.hasMore).toBe(false)
    expect(result.messages).toHaveLength(5)
    // ascending order
    const tsList = result.messages.map(m => m.ts)
    expect(tsList).toEqual([...tsList].sort())
  })

  it('returns hasMore=true when there are more rows than limit', async () => {
    const db = openTestDb()
    await seedMessages(db, 'chat1', 10)
    const result = await dialogueTimeline(db, 'chat1', { limit: 5 })
    expect(result.hasMore).toBe(true)
    expect(result.messages).toHaveLength(5)
  })

  it('default returns the NEWEST page (most-recent N), not the oldest', async () => {
    const db = openTestDb()
    await seedMessages(db, 'chat1', 10)
    const result = await dialogueTimeline(db, 'chat1', { limit: 3 })
    // messages are ascending in result, but they must be the last 3
    const all = await makeMessagesStore(db).listRange('chat1', { limit: 100 })
    const last3 = all.slice(-3).map(m => m.ts)
    expect(result.messages.map(m => m.ts)).toEqual(last3)
  })

  it('paginates upward with beforeTs', async () => {
    const db = openTestDb()
    await seedMessages(db, 'chat1', 10)
    const page1 = await dialogueTimeline(db, 'chat1', { limit: 3 })
    // page1 = last 3; cursor = first ts of page1
    const cursor = page1.messages[0]!.ts
    const page2 = await dialogueTimeline(db, 'chat1', { limit: 3, beforeTs: cursor })
    // page2 should be strictly before cursor
    for (const m of page2.messages) {
      expect(m.ts < cursor).toBe(true)
    }
    expect(page2.messages.length).toBeLessThanOrEqual(3)
  })

  it('hasMore=false on the oldest page', async () => {
    const db = openTestDb()
    await seedMessages(db, 'chat1', 3)
    const page1 = await dialogueTimeline(db, 'chat1', { limit: 3 })
    const cursor = page1.messages[0]!.ts
    const page2 = await dialogueTimeline(db, 'chat1', { limit: 5, beforeTs: cursor })
    expect(page2.hasMore).toBe(false)
  })

  it('empty chat returns empty result', async () => {
    const db = openTestDb()
    const result = await dialogueTimeline(db, 'no-such-chat', { limit: 10 })
    expect(result.messages).toHaveLength(0)
    expect(result.hasMore).toBe(false)
  })
})

// ── dialogueThreads tests ─────────────────────────────────────────────

describe('dialogueThreads', () => {
  it('returns all threads for a chat when no facet filter', async () => {
    const db = openTestDb()
    const store = makeThreadsStore(db)
    await store.create({ chatId: 'chat1', title: 'T1', summary: '', facets: ['task'], tags: [], private: false, episodes: [] })
    await store.create({ chatId: 'chat1', title: 'T2', summary: '', facets: ['life'], tags: [], private: false, episodes: [] })
    const result = await dialogueThreads(db, 'chat1', { includePrivate: false })
    expect(result.threads).toHaveLength(2)
  })

  it('filters by facet correctly', async () => {
    const db = openTestDb()
    const store = makeThreadsStore(db)
    await store.create({ chatId: 'chat1', title: 'Task+Life', summary: '', facets: ['task', 'life'], tags: [], private: false, episodes: [] })
    await store.create({ chatId: 'chat1', title: 'KnowledgeOnly', summary: '', facets: ['knowledge'], tags: [], private: false, episodes: [] })

    const taskResult = await dialogueThreads(db, 'chat1', { facet: 'task', includePrivate: false })
    expect(taskResult.threads).toHaveLength(1)
    expect(taskResult.threads[0]!.title).toBe('Task+Life')

    const lifeResult = await dialogueThreads(db, 'chat1', { facet: 'life', includePrivate: false })
    expect(lifeResult.threads).toHaveLength(1)
    expect(lifeResult.threads[0]!.title).toBe('Task+Life')

    const knowledgeResult = await dialogueThreads(db, 'chat1', { facet: 'knowledge', includePrivate: false })
    expect(knowledgeResult.threads).toHaveLength(1)
    expect(knowledgeResult.threads[0]!.title).toBe('KnowledgeOnly')
  })

  it('a thread with multi-facet [task, life] appears under both facet=task and facet=life', async () => {
    const db = openTestDb()
    const store = makeThreadsStore(db)
    await store.create({ chatId: 'chat1', title: 'Multi', summary: '', facets: ['task', 'life'], tags: [], private: false, episodes: [] })

    const r1 = await dialogueThreads(db, 'chat1', { facet: 'task', includePrivate: false })
    const r2 = await dialogueThreads(db, 'chat1', { facet: 'life', includePrivate: false })
    expect(r1.threads.some(t => t.title === 'Multi')).toBe(true)
    expect(r2.threads.some(t => t.title === 'Multi')).toBe(true)
  })

  it('excludes private threads when includePrivate=false', async () => {
    const db = openTestDb()
    const store = makeThreadsStore(db)
    await store.create({ chatId: 'chat1', title: 'Public', summary: '', facets: ['task'], tags: [], private: false, episodes: [] })
    await store.create({ chatId: 'chat1', title: 'Private', summary: '', facets: ['task'], tags: [], private: true, episodes: [] })

    const result = await dialogueThreads(db, 'chat1', { includePrivate: false })
    expect(result.threads.map(t => t.title)).not.toContain('Private')
    expect(result.threads.map(t => t.title)).toContain('Public')
  })

  it('includes private threads when includePrivate=true', async () => {
    const db = openTestDb()
    const store = makeThreadsStore(db)
    await store.create({ chatId: 'chat1', title: 'Public', summary: '', facets: ['task'], tags: [], private: false, episodes: [] })
    await store.create({ chatId: 'chat1', title: 'Private', summary: '', facets: ['task'], tags: [], private: true, episodes: [] })

    const result = await dialogueThreads(db, 'chat1', { includePrivate: true })
    expect(result.threads.map(t => t.title)).toContain('Private')
    expect(result.threads.map(t => t.title)).toContain('Public')
  })

  it('does not return threads from other chats', async () => {
    const db = openTestDb()
    const store = makeThreadsStore(db)
    await store.create({ chatId: 'chat1', title: 'Chat1Thread', summary: '', facets: ['task'], tags: [], private: false, episodes: [] })
    await store.create({ chatId: 'chat2', title: 'Chat2Thread', summary: '', facets: ['task'], tags: [], private: false, episodes: [] })

    const result = await dialogueThreads(db, 'chat1', { includePrivate: false })
    expect(result.threads.map(t => t.title)).toEqual(['Chat1Thread'])
  })
})

// ── dialogueSearch tests ──────────────────────────────────────────────

describe('dialogueSearch', () => {
  it('returns matching messages (case-insensitive substring)', async () => {
    const db = openTestDb()
    const store = makeMessagesStore(db)
    await store.append({ id: 'm1', chatId: 'chat1', ts: '2026-01-01T00:00:00Z', direction: 'in', kind: 'text', text: '你好 ilink', source: 'live' })
    await store.append({ id: 'm2', chatId: 'chat1', ts: '2026-01-01T00:00:01Z', direction: 'out', kind: 'text', text: '回复一下', source: 'live' })
    await store.append({ id: 'm3', chatId: 'chat1', ts: '2026-01-01T00:00:02Z', direction: 'in', kind: 'text', text: 'ilink 又来了', source: 'live' })

    const result = await dialogueSearch(db, 'chat1', 'ilink', 10)
    expect(result.hits).toHaveLength(2)
    expect(result.hits.every(h => h.text.includes('ilink'))).toBe(true)
  })

  it('does not return results from other chats', async () => {
    const db = openTestDb()
    const store = makeMessagesStore(db)
    await store.append({ id: 'm1', chatId: 'chat1', ts: '2026-01-01T00:00:00Z', direction: 'in', kind: 'text', text: 'ilink msg', source: 'live' })
    await store.append({ id: 'm2', chatId: 'chat2', ts: '2026-01-01T00:00:00Z', direction: 'in', kind: 'text', text: 'ilink msg', source: 'live' })

    const result = await dialogueSearch(db, 'chat1', 'ilink', 10)
    expect(result.hits).toHaveLength(1)
    expect(result.hits[0]!.chatId).toBe('chat1')
  })

  it('returns empty hits when query does not match anything', async () => {
    const db = openTestDb()
    await seedMessages(db, 'chat1', 5)
    const result = await dialogueSearch(db, 'chat1', 'xyznonexistent', 10)
    expect(result.hits).toHaveLength(0)
  })

  it('respects limit', async () => {
    const db = openTestDb()
    const store = makeMessagesStore(db)
    for (let i = 0; i < 10; i++) {
      await store.append({ id: `m${i}`, chatId: 'chat1', ts: new Date(1_700_000_000_000 + i * 1000).toISOString(), direction: 'in', kind: 'text', text: `needle-${i}`, source: 'live' })
    }
    const result = await dialogueSearch(db, 'chat1', 'needle', 3)
    expect(result.hits).toHaveLength(3)
  })
})

// ── dialogueThreadDetail tests ────────────────────────────────────────

describe('dialogueThreadDetail', () => {
  it('returns null for unknown thread id', async () => {
    const db = openTestDb()
    const result = await dialogueThreadDetail(db, 'thr_unknown')
    expect(result).toBeNull()
  })

  it('returns thread with episodes and messages within each episode range', async () => {
    const db = openTestDb()
    const tStore = makeThreadsStore(db)
    const mStore = makeMessagesStore(db)

    // Insert messages spanning 3 time slots
    const base = 1_700_000_000_000
    for (let i = 0; i < 9; i++) {
      await mStore.append({
        id: `msg-${i}`,
        chatId: 'chat1',
        ts: new Date(base + i * 60_000).toISOString(), // 1min apart
        direction: 'in', kind: 'text', text: `msg ${i}`, source: 'live',
      })
    }

    // Thread covers messages 0-2 (episode 1) and 5-7 (episode 2)
    const ep1from = new Date(base).toISOString()
    const ep1to   = new Date(base + 2 * 60_000).toISOString()
    const ep2from = new Date(base + 5 * 60_000).toISOString()
    const ep2to   = new Date(base + 7 * 60_000).toISOString()

    const id = await tStore.create({
      chatId: 'chat1',
      title: 'Test Thread',
      summary: 'A test',
      facets: ['task'],
      tags: [],
      private: false,
      episodes: [
        { from_ts: ep1from, to_ts: ep1to },
        { from_ts: ep2from, to_ts: ep2to },
      ],
    })

    const result = await dialogueThreadDetail(db, id)
    expect(result).not.toBeNull()
    expect(result!.thread.id).toBe(id)
    expect(result!.thread.title).toBe('Test Thread')
    expect(result!.episodes).toHaveLength(2)

    // Episode 1: msgs 0,1,2
    expect(result!.episodes[0]!.messages).toHaveLength(3)
    expect(result!.episodes[0]!.from_ts).toBe(ep1from)
    expect(result!.episodes[0]!.to_ts).toBe(ep1to)

    // Episode 2: msgs 5,6,7
    expect(result!.episodes[1]!.messages).toHaveLength(3)
    expect(result!.episodes[1]!.from_ts).toBe(ep2from)
    expect(result!.episodes[1]!.to_ts).toBe(ep2to)
  })

  it('returns empty episodes array when thread has no episodes', async () => {
    const db = openTestDb()
    const tStore = makeThreadsStore(db)
    const id = await tStore.create({
      chatId: 'chat1', title: 'No Eps', summary: '', facets: ['task'], tags: [], private: false, episodes: [],
    })
    const result = await dialogueThreadDetail(db, id)
    expect(result).not.toBeNull()
    expect(result!.episodes).toHaveLength(0)
  })

  it('caps episode messages at 200', async () => {
    const db = openTestDb()
    const tStore = makeThreadsStore(db)
    const mStore = makeMessagesStore(db)
    const base = 1_700_000_000_000
    for (let i = 0; i < 250; i++) {
      await mStore.append({
        id: `msgbig-${i}`,
        chatId: 'chat1',
        ts: new Date(base + i * 1000).toISOString(),
        direction: 'in', kind: 'text', text: `msg ${i}`, source: 'live',
      })
    }
    const from_ts = new Date(base).toISOString()
    const to_ts = new Date(base + 249 * 1000).toISOString()
    const id = await tStore.create({
      chatId: 'chat1', title: 'BigEp', summary: '', facets: ['task'], tags: [], private: false,
      episodes: [{ from_ts, to_ts }],
    })
    const result = await dialogueThreadDetail(db, id)
    expect(result!.episodes[0]!.messages.length).toBeLessThanOrEqual(200)
  })
})

describe('dialogue lock', () => {
  it('set → unlock roundtrip succeeds with correct passphrase', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dlock-'))
    dialogueLockSet(dir, 'hunter2')
    expect(dialogueUnlock(dir, 'hunter2')).toEqual({ ok: true })
  })

  it('unlock fails with wrong passphrase', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dlock-wrong-'))
    dialogueLockSet(dir, 'correct horse')
    expect(dialogueUnlock(dir, 'battery staple')).toEqual({ ok: false })
  })

  it('unlock with no lock configured returns no_lock_configured', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dlock-none-'))
    expect(dialogueUnlock(dir, 'anything')).toEqual({ ok: false, error: 'no_lock_configured' })
  })

  it('set persists a salt:hexhash and a fresh salt each time', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dlock-salt-'))
    dialogueLockSet(dir, 'p')
    const first = loadAgentConfig(dir).dialogue_lock_hash
    dialogueLockSet(dir, 'p')
    const second = loadAgentConfig(dir).dialogue_lock_hash
    expect(first).toMatch(/^[0-9a-f]+:[0-9a-f]+$/)
    expect(first).not.toBe(second) // different salt → different stored hash
    // both still verify
    expect(dialogueUnlock(dir, 'p')).toEqual({ ok: true })
  })

  it('set preserves other agent-config fields', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dlock-preserve-'))
    saveAgentConfig(dir, { provider: 'codex', dangerouslySkipPermissions: false, autoStart: false, closeStopsDaemon: true, bot_name: '小助手' })
    dialogueLockSet(dir, 'secret')
    const cfg = loadAgentConfig(dir)
    expect(cfg.provider).toBe('codex')
    expect(cfg.bot_name).toBe('小助手')
    expect(cfg.closeStopsDaemon).toBe(true)
    expect(dialogueUnlock(dir, 'secret')).toEqual({ ok: true })
  })
})
