/**
 * session-store.ts — persistent alias → session_id map for SDK resume.
 *
 * Daemon restarts drop the in-memory session pool; the first message per
 * alias cold-starts a fresh Claude Agent SDK session (~10s per Spike 1
 * data). This store remembers the last session_id per alias so spawn()
 * can call query({ resume: session_id }) and cut that to <3s.
 *
 * File layout: ~/.claude/channels/wechat/sessions.json
 * Atomic writes (tmp + rename). 500 ms debounce matches other state stores.
 *
 * Provider tagging (RFC 03 P0): each record carries the provider that
 * created the session. session_id strings are NOT interchangeable between
 * `claude` and `codex` (Claude jsonl path vs Codex `~/.codex/sessions/`),
 * so passing the wrong one to spawn() fails the resume. Records written
 * before the provider field existed are read as `provider='claude'`
 * (matches the v0.x default; safe migration).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export type ProviderId = string  // open string per RFC 03 §3.3 (registry-driven)

export interface SessionRecord {
  session_id: string
  last_used_at: string  // ISO
  /**
   * Which agent provider produced this session_id. Optional in JSON for
   * backward compat with v0.x records — readers must default to 'claude'
   * when missing. New writes always include it.
   */
  provider?: ProviderId
  summary?: string      // 1-line LLM summary, cached
  summary_updated_at?: string  // when summary was last refreshed
}

export interface SessionStore {
  /**
   * Returns the stored record for an alias. When `expectedProvider` is
   * given, the record's provider must match; otherwise returns null
   * (so a daemon configured for codex won't try to resume a claude
   * session_id and vice versa). Records with no provider field are
   * treated as `claude` (v0.x default).
   */
  get(alias: string, expectedProvider?: ProviderId): SessionRecord | null
  set(alias: string, sessionId: string, provider: ProviderId): void
  setSummary(alias: string, summary: string): void
  delete(alias: string): void
  all(): Record<string, SessionRecord>
  flush(): Promise<void>
}

/** v0.x default — records without `provider` belong to this. Stays a literal so future renames flag. */
const LEGACY_PROVIDER: ProviderId = 'claude'

function recordProvider(rec: SessionRecord): ProviderId {
  return rec.provider ?? LEGACY_PROVIDER
}

interface StoredShape {
  version: 1
  sessions: Record<string, SessionRecord>
}

export function makeSessionStore(
  filePath: string,
  opts: { debounceMs: number },
): SessionStore {
  let data: StoredShape = { version: 1, sessions: {} }
  let dirty = false
  let timer: ReturnType<typeof setTimeout> | null = null

  if (existsSync(filePath)) {
    try {
      const raw = readFileSync(filePath, 'utf8')
      const parsed = JSON.parse(raw) as Partial<StoredShape>
      if (parsed && typeof parsed === 'object' && parsed.sessions && typeof parsed.sessions === 'object') {
        data = { version: 1, sessions: parsed.sessions as Record<string, SessionRecord> }
      }
    } catch { /* corrupt — start empty */ }
  }

  async function writeNow(): Promise<void> {
    if (!dirty) return
    const dir = dirname(filePath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
    const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`
    writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
    renameSync(tmp, filePath)
    dirty = false
  }

  function markDirty(): void {
    dirty = true
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => { timer = null; void writeNow() }, opts.debounceMs)
  }

  return {
    get(alias, expectedProvider) {
      const rec = data.sessions[alias]
      if (!rec) return null
      if (expectedProvider && recordProvider(rec) !== expectedProvider) {
        // Wrong provider for this caller — treat as cache miss. We
        // intentionally don't delete here; another caller for the matching
        // provider may legitimately want it. Manager-level eviction (which
        // happens on stale-TTL or explicit replace) handles cleanup.
        return null
      }
      return rec
    },
    set(alias, sessionId, provider) {
      const existing = data.sessions[alias]
      const now = new Date().toISOString()
      if (existing && existing.session_id === sessionId && recordProvider(existing) === provider) {
        // same session, same provider → just bump timestamp
        existing.last_used_at = now
        existing.provider = provider  // upgrade legacy records in place
      } else {
        data.sessions[alias] = { session_id: sessionId, last_used_at: now, provider }
      }
      markDirty()
    },
    setSummary(alias, summary) {
      const existing = data.sessions[alias]
      if (!existing) return  // unknown alias — silently skip
      data.sessions[alias] = {
        ...existing,
        summary,
        summary_updated_at: new Date().toISOString(),
      }
      markDirty()
    },
    delete(alias) {
      if (!(alias in data.sessions)) return
      delete data.sessions[alias]
      markDirty()
    },
    all() {
      return { ...data.sessions }
    },
    async flush() {
      if (timer) { clearTimeout(timer); timer = null }
      await writeNow()
    },
  }
}
