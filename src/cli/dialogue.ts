/**
 * dialogue.ts — backfill CLI helpers.
 *
 * Imports conversation history from agent session JSONLs into the `messages`
 * SQLite table. Two sources are supported:
 *
 *   1. Claude session JSONLs: ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
 *      Shape: { type: 'user'|'assistant', message: { content }, timestamp }
 *      Walker: given a directory of *.jsonl files (produced by caller from
 *      resolveProjectJsonlPath or a test tmpdir), parse each line.
 *
 *   2. Codex rollout JSONLs: ~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<id>.jsonl
 *      Conversion via readCodexJsonlAsClaudeTurns from codex-jsonl.ts.
 *      Walker: recursive depth-3 scan (year/month/day) for rollout-*.jsonl.
 *
 * Implementation note: the existing `sessions read-jsonl` CLI command in
 * cli.ts uses the same JSON shape for claude JSONLs (line-by-line JSON.parse),
 * but that parsing is inlined in the command run() and is not exported. This
 * module reimplements the parser standalone — kept intentionally minimal so
 * it can be unit-tested without the full sessions machinery.
 *
 * The codex path reuses readCodexJsonlAsClaudeTurns (already exported) to
 * avoid duplicating the codec logic.
 */

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Db } from '../lib/db'
import { makeMessagesStore, type MessageRecord } from '../lib/messages-store'
import { makeThreadsStore, type ThreadRecord, type Facet } from '../lib/threads-store'

// ── Types ─────────────────────────────────────────────────────────────

export interface SimpleTurn {
  type: 'user' | 'assistant'
  ts: string
  text: string
}

// ── claude JSONL parser ───────────────────────────────────────────────

/**
 * Parse one line from a claude session JSONL.
 * Returns null for lines that don't carry displayable text (tool calls,
 * summary entries, lines with missing timestamp, etc.).
 */
function parseClaudeJsonlLine(line: string): SimpleTurn | null {
  try {
    const o = JSON.parse(line) as Record<string, unknown>
    const ts = typeof o.timestamp === 'string' ? o.timestamp : null
    if (!ts) return null
    if (o.type === 'user') {
      const m = o.message as { content?: unknown } | undefined
      const text = typeof m?.content === 'string' ? m.content : null
      return text ? { type: 'user', ts, text } : null
    }
    if (o.type === 'assistant') {
      const m = o.message as { content?: Array<{ type: string; text?: string }> } | undefined
      const text = (m?.content ?? [])
        .filter(b => b.type === 'text')
        .map(b => b.text ?? '')
        .join('\n')
      return text ? { type: 'assistant', ts, text } : null
    }
    return null
  } catch {
    return null
  }
}

// ── Public helpers ────────────────────────────────────────────────────

/**
 * Map one SimpleTurn to MessageRecord[]. The idx parameter is the line
 * position counter and is baked into the record id — it must be stable
 * across reruns (the same position always produces the same id).
 */
export function claudeTurnToMessages(
  turn: SimpleTurn,
  chatId: string,
  sessionKey: string,
  idx: number,
): MessageRecord[] {
  return [
    {
      id: `bf:claude:${sessionKey}:${idx}`,
      chatId,
      ts: turn.ts,
      direction: turn.type === 'user' ? 'in' : 'out',
      kind: 'text',
      text: turn.text,
      ...(turn.type === 'assistant' ? { provider: 'claude' } : {}),
      source: 'backfill:claude',
    },
  ]
}

/**
 * Import all *.jsonl files in `dir` into the messages table, attributing
 * them to `chatId`. Uses INSERT OR IGNORE so reruns are safe.
 *
 * @param dryRun When true, parse and count but write nothing.
 */
export async function backfillFromClaudeJsonl(
  db: Db,
  dir: string,
  chatId: string,
  dryRun = false,
): Promise<{ scanned: number; inserted: number }> {
  const store = makeMessagesStore(db)
  let scanned = 0
  let inserted = 0

  let files: string[]
  try {
    files = readdirSync(dir).filter(f => f.endsWith('.jsonl'))
  } catch {
    return { scanned, inserted }
  }

  for (const f of files) {
    const sessionKey = f.replace(/\.jsonl$/, '')
    const lines = readFileSync(join(dir, f), 'utf8')
      .split('\n')
      .filter(Boolean)
    let idx = 0
    for (const line of lines) {
      idx++
      const turn = parseClaudeJsonlLine(line)
      if (!turn) continue
      scanned++
      if (dryRun) continue
      const before = db.query<{ c: number }, []>('SELECT COUNT(*) c FROM messages').get()!.c
      for (const rec of claudeTurnToMessages(turn, chatId, sessionKey, idx)) {
        await store.append(rec)
      }
      const after = db.query<{ c: number }, []>('SELECT COUNT(*) c FROM messages').get()!.c
      inserted += after - before
    }
  }
  return { scanned, inserted }
}

// ── Codex path ────────────────────────────────────────────────────────

/**
 * Walk `codexRoot` (depth 3: year/month/day) for rollout-*.jsonl files,
 * convert each via readCodexJsonlAsClaudeTurns, and import into the
 * messages table with source='backfill:codex'. Idempotent (INSERT OR IGNORE).
 *
 * @param dryRun When true, parse and count but write nothing.
 */
export async function backfillFromCodexJsonl(
  db: Db,
  codexRoot: string,
  chatId: string,
  dryRun = false,
): Promise<{ scanned: number; inserted: number }> {
  const { readCodexJsonlAsClaudeTurns } = await import('../lib/codex-jsonl')
  const store = makeMessagesStore(db)
  let scanned = 0
  let inserted = 0

  if (!existsSync(codexRoot)) return { scanned, inserted }

  // Walk year/month/day (depth ≤ 3, mirrors findCodexRollout layout)
  const rollouts: string[] = []
  try {
    for (const year of safeReaddir(codexRoot)) {
      const yearDir = join(codexRoot, year)
      if (!isDir(yearDir)) continue
      for (const month of safeReaddir(yearDir)) {
        const monthDir = join(yearDir, month)
        if (!isDir(monthDir)) continue
        for (const day of safeReaddir(monthDir)) {
          const dayDir = join(monthDir, day)
          if (!isDir(dayDir)) continue
          for (const file of safeReaddir(dayDir)) {
            if (file.startsWith('rollout-') && file.endsWith('.jsonl')) {
              rollouts.push(join(dayDir, file))
            }
          }
        }
      }
    }
  } catch { /* fall through — partial results fine */ }

  for (const rolloutPath of rollouts) {
    // Use the file basename (without extension) as the stable session key
    const basename = rolloutPath.split('/').pop()!.replace(/\.jsonl$/, '')
    // Parse filename anchor: rollout-YYYY-MM-DDTHH-MM-SS-*.jsonl → ISO ts
    const filenameAnchor = parseRolloutFilenameTs(basename)
    const turns = readCodexJsonlAsClaudeTurns(rolloutPath)
    let idx = 0
    for (const turn of turns) {
      idx++
      const text = turn.message.content.map(b => b.text).join('\n')
      if (!text) continue // skip empty turns before counting
      scanned++
      if (dryRun) continue
      // Timestamp priority:
      //   1. Envelope-level `timestamp` threaded through as turn.ts
      //   2. Filename anchor (rollout-YYYY-MM-DDTHH-MM-SS-*) + microsecond idx offset
      //   3. Skip the turn — no garbage year-0001 timestamps
      let ts: string
      if (turn.ts) {
        ts = turn.ts
      } else if (filenameAnchor) {
        // Add idx microseconds so turns within the same file are sortable.
        const anchorMs = new Date(filenameAnchor).getTime()
        ts = new Date(anchorMs + idx).toISOString()
      } else {
        continue // neither source — skip rather than insert garbage
      }
      const rec: MessageRecord = {
        id: `bf:codex:${basename}:${idx}`,
        chatId,
        ts,
        direction: turn.type === 'user' ? 'in' : 'out',
        kind: 'text',
        text,
        ...(turn.type === 'assistant' ? { provider: 'codex' } : {}),
        source: 'backfill:codex',
      }
      const before = db.query<{ c: number }, []>('SELECT COUNT(*) c FROM messages').get()!.c
      await store.append(rec)
      const after = db.query<{ c: number }, []>('SELECT COUNT(*) c FROM messages').get()!.c
      inserted += after - before
    }
  }
  return { scanned, inserted }
}

// ── Query functions ───────────────────────────────────────────────────

export interface TimelineOpts {
  limit: number
  /** Page upward: only messages strictly before this ISO ts. Omit = newest page. */
  beforeTs?: string
}

export interface TimelineResult {
  messages: MessageRecord[]
  hasMore: boolean
}

/**
 * Paged conversation timeline for a chat.
 *
 * Fetches `limit+1` rows from the messages store to detect whether there is a
 * prior page, then returns at most `limit` rows. hasMore=true means the caller
 * can page further by passing `messages[0].ts` as the next `beforeTs`.
 */
export async function dialogueTimeline(db: Db, chatId: string, opts: TimelineOpts): Promise<TimelineResult> {
  const store = makeMessagesStore(db)
  // Fetch one extra to detect hasMore without a separate COUNT query.
  const rows = await store.listRange(chatId, { limit: opts.limit + 1, beforeTs: opts.beforeTs })
  const hasMore = rows.length > opts.limit
  // rows are in ascending order (newest page = last N rows, oldest = first N).
  // We need to drop the extra row; for upward paging `listRange` with
  // limit+1 returns the `limit+1` oldest matching rows ascending — so the
  // first row is the overflow indicator.
  const messages = hasMore ? rows.slice(1) : rows
  return { messages, hasMore }
}

export interface ThreadsOpts {
  facet?: Facet
  includePrivate: boolean
}

export interface ThreadsResult {
  threads: ThreadRecord[]
}

/**
 * List topic threads for a chat, with optional facet filter and private exclusion.
 *
 * Per-chat thread lists are small so in-JS filtering over store.list() is used
 * (simpler than json_each SQL, per task spec).
 */
export async function dialogueThreads(db: Db, chatId: string, opts: ThreadsOpts): Promise<ThreadsResult> {
  const store = makeThreadsStore(db)
  let threads = await store.list(chatId)
  if (!opts.includePrivate) {
    threads = threads.filter(t => !t.private)
  }
  if (opts.facet !== undefined) {
    threads = threads.filter(t => t.facets.includes(opts.facet!))
  }
  return { threads }
}

export interface SearchResult {
  hits: MessageRecord[]
}

/**
 * Substring search over messages for a chat.
 */
export async function dialogueSearch(db: Db, chatId: string, q: string, limit: number): Promise<SearchResult> {
  const store = makeMessagesStore(db)
  const hits = await store.search(chatId, q, limit)
  return { hits }
}

export interface EpisodeWithMessages {
  from_ts: string
  to_ts: string
  messages: MessageRecord[]
}

export interface ThreadDetailResult {
  thread: ThreadRecord
  episodes: EpisodeWithMessages[]
}

/**
 * Full thread detail: the thread record plus per-episode messages.
 *
 * Returns null when the thread id is unknown.
 * Each episode's messages are fetched using a range query (ts BETWEEN from_ts AND to_ts),
 * capped at 200 rows per episode.
 */
export async function dialogueThreadDetail(db: Db, id: string): Promise<ThreadDetailResult | null> {
  const tStore = makeThreadsStore(db)
  const thread = await tStore.get(id)
  if (!thread) return null

  const mStore = makeMessagesStore(db)
  const MAX_PER_EPISODE = 200

  const episodes: EpisodeWithMessages[] = []
  for (const ep of thread.episodes) {
    // listRange with beforeTs gives messages strictly < beforeTs, ascending.
    // We want messages where ts >= from_ts AND ts <= to_ts. Use a direct
    // SQL query approach: fetch messages with ts <= to_ts using beforeTs just
    // above to_ts, then filter by >= from_ts in JS.
    // To capture to_ts inclusive we need ts < (to_ts + 1ms). ISO strings are
    // lexicographically comparable, so we add 1ms to to_ts.
    const toTsMs = new Date(ep.to_ts).getTime()
    const exclusiveAfter = new Date(toTsMs + 1).toISOString()
    const rows = await mStore.listRange(thread.chatId, {
      limit: MAX_PER_EPISODE,
      beforeTs: exclusiveAfter,
    })
    // Filter to >= from_ts in JS; listRange returns ascending order.
    const messages = rows.filter(m => m.ts >= ep.from_ts)
    episodes.push({ from_ts: ep.from_ts, to_ts: ep.to_ts, messages })
  }

  return { thread, episodes }
}

// ── Dialogue lock (private-thread passphrase) ──────────────────────────
//
// The desktop dialogue page hides private threads behind a passphrase. The
// passphrase is never stored — only a scrypt-derived hash, persisted in
// agent-config.json under `dialogue_lock_hash` as `salt:hexhash` (both hex).
// Verification re-derives the key from the candidate passphrase + stored
// salt and compares constant-time via timingSafeEqual.

import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto'
import { loadAgentConfig, saveAgentConfig } from '../lib/agent-config'

const SCRYPT_KEYLEN = 32

/**
 * Derive a scrypt hash for `passphrase` against `saltHex`, returned as hex.
 */
function deriveHashHex(passphrase: string, saltHex: string): string {
  return scryptSync(passphrase, Buffer.from(saltHex, 'hex'), SCRYPT_KEYLEN).toString('hex')
}

/**
 * Store the scrypt hash of `passphrase` into agent-config.json
 * (`dialogue_lock_hash` = `salt:hexhash`). A fresh random 16-byte salt is
 * generated each time, so re-setting the same passphrase produces a new hash.
 */
export function dialogueLockSet(stateDir: string, passphrase: string): void {
  const saltHex = randomBytes(16).toString('hex')
  const hashHex = deriveHashHex(passphrase, saltHex)
  const config = loadAgentConfig(stateDir)
  saveAgentConfig(stateDir, { ...config, dialogue_lock_hash: `${saltHex}:${hashHex}` })
}

export interface DialogueUnlockResult {
  ok: boolean
  error?: 'no_lock_configured'
}

/**
 * Verify `passphrase` against the stored dialogue lock hash.
 *   - No hash configured  → { ok: false, error: 'no_lock_configured' }
 *   - Correct passphrase  → { ok: true }
 *   - Wrong passphrase    → { ok: false }
 * Comparison is constant-time over the derived key.
 */
export function dialogueUnlock(stateDir: string, passphrase: string): DialogueUnlockResult {
  const config = loadAgentConfig(stateDir)
  const stored = config.dialogue_lock_hash
  if (!stored) return { ok: false, error: 'no_lock_configured' }
  const sep = stored.indexOf(':')
  if (sep <= 0) return { ok: false }
  const saltHex = stored.slice(0, sep)
  const expectedHex = stored.slice(sep + 1)
  let expected: Buffer
  try {
    expected = Buffer.from(expectedHex, 'hex')
  } catch {
    return { ok: false }
  }
  if (expected.length !== SCRYPT_KEYLEN) return { ok: false }
  const candidate = scryptSync(passphrase, Buffer.from(saltHex, 'hex'), SCRYPT_KEYLEN)
  if (candidate.length !== expected.length) return { ok: false }
  return { ok: timingSafeEqual(candidate, expected) }
}

// ── Private helpers ───────────────────────────────────────────────────

function safeReaddir(p: string): string[] {
  try {
    return readdirSync(p)
  } catch {
    return []
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/**
 * Parse the timestamp embedded in a codex rollout filename.
 * Codex names rollouts as `rollout-YYYY-MM-DDTHH-MM-SS-<id>` where the
 * dashes inside the time part replace colons (filesystem-safe). Returns an
 * ISO 8601 string, or null if the filename doesn't match the expected pattern.
 *
 * Example: `rollout-2025-11-25T02-41-55-abc123` → `2025-11-25T02:41:55Z`
 */
function parseRolloutFilenameTs(basename: string): string | null {
  // Match: rollout-YYYY-MM-DDTHH-MM-SS[-<rest>]
  const m = basename.match(/^rollout-(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})(?:[-.]|$)/)
  if (!m) return null
  // m[1] = "YYYY-MM-DDTHH", m[2] = "MM", m[3] = "SS"
  const iso = `${m[1]}:${m[2]}:${m[3]}Z`
  const d = new Date(iso)
  if (isNaN(d.getTime())) return null
  return iso
}
