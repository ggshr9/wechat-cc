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
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface SessionRecord {
  session_id: string
  last_used_at: string  // ISO
}

export interface SessionStore {
  get(alias: string): SessionRecord | null
  set(alias: string, sessionId: string): void
  delete(alias: string): void
  all(): Record<string, SessionRecord>
  flush(): Promise<void>
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
    get(alias) {
      return data.sessions[alias] ?? null
    },
    set(alias, sessionId) {
      const existing = data.sessions[alias]
      const now = new Date().toISOString()
      if (existing && existing.session_id === sessionId) {
        // same session → just bump timestamp
        existing.last_used_at = now
      } else {
        data.sessions[alias] = { session_id: sessionId, last_used_at: now }
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
