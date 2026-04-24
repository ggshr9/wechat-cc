/**
 * Per-bot session state tracker.
 *
 * Persists at ~/.claude/channels/wechat/session-state.json — survives daemon
 * restart so an expired bot stays flagged even if we don't immediately get
 * around to cleaning it up. Read by the admin /health command (pull-based);
 * no proactive push on expiry (decision 2026-04-24).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface BotSessionState {
  status: 'expired'
  first_seen_expired_at: string  // ISO 8601
  last_reason?: string           // e.g. 'ilink/getupdates errcode=-14'
}

export interface ExpiredBot {
  id: string
  first_seen_expired_at: string
  last_reason?: string
}

export interface SessionStateStore {
  /** Returns true iff this bot has been flagged expired. */
  isExpired(botId: string): boolean
  /** Flag a bot expired. Returns true on state transition, false if already expired. */
  markExpired(botId: string, reason?: string): boolean
  /** Enumerate currently-expired bots. */
  listExpired(): ExpiredBot[]
  /** Remove a bot's entry (e.g. after admin cleanup or a successful re-scan). */
  clear(botId: string): void
  /** Flush pending writes (for graceful shutdown). */
  flush(): Promise<void>
}

interface StoredShape {
  version: 1
  bots: Record<string, BotSessionState>
}

export function makeSessionStateStore(
  filePath: string,
  opts: { debounceMs: number },
): SessionStateStore {
  let data: StoredShape = { version: 1, bots: {} }
  let dirty = false
  let timer: ReturnType<typeof setTimeout> | null = null

  if (existsSync(filePath)) {
    try {
      const raw = readFileSync(filePath, 'utf8')
      const parsed = JSON.parse(raw) as Partial<StoredShape>
      if (parsed && typeof parsed === 'object' && parsed.bots && typeof parsed.bots === 'object') {
        data = { version: 1, bots: parsed.bots as Record<string, BotSessionState> }
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
    isExpired(botId) {
      return data.bots[botId]?.status === 'expired'
    },

    markExpired(botId, reason) {
      if (data.bots[botId]?.status === 'expired') return false
      data.bots[botId] = {
        status: 'expired',
        first_seen_expired_at: new Date().toISOString(),
        ...(reason ? { last_reason: reason } : {}),
      }
      markDirty()
      return true
    },

    listExpired() {
      const out: ExpiredBot[] = []
      for (const [id, state] of Object.entries(data.bots)) {
        if (state.status === 'expired') {
          out.push({
            id,
            first_seen_expired_at: state.first_seen_expired_at,
            ...(state.last_reason ? { last_reason: state.last_reason } : {}),
          })
        }
      }
      // sort by first_seen_expired_at ascending (oldest first)
      out.sort((a, b) => a.first_seen_expired_at.localeCompare(b.first_seen_expired_at))
      return out
    },

    clear(botId) {
      if (!(botId in data.bots)) return
      delete data.bots[botId]
      markDirty()
    },

    async flush() {
      if (timer) { clearTimeout(timer); timer = null }
      await writeNow()
    },
  }
}
