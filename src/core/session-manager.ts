import type { SessionStore } from './session-store'
import type { AgentProvider, AgentResult, AgentSession } from './agent-provider'

export interface SessionManagerOptions {
  maxConcurrent: number
  idleEvictMs: number
  provider: AgentProvider
  /**
   * When present, the manager persists the SDK-reported session_id per
   * alias and passes it back as `resume` on the next spawn — slashing
   * daemon-restart cold-start from ~10 s to <3 s. Absent → disabled.
   */
  sessionStore?: SessionStore
  /**
   * Optional disk check for the resume candidate. The SDK stores its
   * conversation history as jsonl under `~/.claude/projects/<cwd>/<id>.jsonl`;
   * if the file is gone (user wiped history or Claude Code rotated), we
   * can't resume — fall back to fresh. Absent → skip this safety.
   */
  canResume?: (cwd: string, sessionId: string) => boolean
  /** Stored session_id older than this is treated as stale. Default 7 d. */
  resumeTTLMs?: number
}

export interface SessionHandle {
  readonly alias: string
  readonly path: string
  lastUsedAt: number
  dispatch(text: string): Promise<{ assistantText?: string[] } | void>
  close(): Promise<void>
  onAssistantText(cb: (text: string) => void): () => void
  onResult(cb: (r: { session_id: string; num_turns: number; duration_ms: number }) => void): () => void
}

interface Internal {
  handle: SessionHandle
  session: AgentSession
}

export class SessionManager {
  private readonly opts: SessionManagerOptions
  private readonly sessions = new Map<string, Internal>()

  constructor(opts: SessionManagerOptions) {
    this.opts = opts
  }

  async acquire(alias: string, path: string): Promise<SessionHandle> {
    const existing = this.sessions.get(alias)
    if (existing) {
      existing.handle.lastUsedAt = Date.now()
      return existing.handle
    }
    return this.spawn(alias, path)
  }

  private async spawn(alias: string, path: string): Promise<SessionHandle> {
    // Check for a recent session_id to resume — cut cold-start latency.
    const ttl = this.opts.resumeTTLMs ?? 7 * 24 * 60 * 60_000
    const record = this.opts.sessionStore?.get(alias) ?? null
    let resumeSessionId: string | undefined
    if (record) {
      const age = Date.now() - Date.parse(record.last_used_at)
      const jsonlStillThere = this.opts.canResume
        ? this.opts.canResume(path, record.session_id)
        : true
      if (age < ttl && jsonlStillThere) {
        resumeSessionId = record.session_id
        console.error(`wechat channel: [SESSION_RESUME] alias=${alias} sid=${record.session_id} age=${Math.round(age / 1000)}s`)
      } else {
        // stale — forget so we don't keep retrying
        this.opts.sessionStore?.delete(alias)
      }
    }

    const project = { alias, path }
    const session = resumeSessionId
      ? await this.opts.provider.spawn(project, { resumeSessionId })
      : await this.opts.provider.spawn(project)

    const handle: SessionHandle = {
      alias,
      path,
      lastUsedAt: Date.now(),
      async dispatch(text: string) {
        await session.dispatch(text)
        handle.lastUsedAt = Date.now()
      },
      async close() {
        await session.close()
      },
      onAssistantText(cb) { return session.onAssistantText(cb) },
      onResult(cb) { return session.onResult(cb) },
    }

    session.onResult((r: AgentResult) => {
      if (r.session_id && this.opts.sessionStore) {
        this.opts.sessionStore.set(alias, r.session_id)
      }
    })

    this.sessions.set(alias, { handle, session })
    await this.enforceCapacity()
    return handle
  }

  async release(alias: string): Promise<void> {
    const s = this.sessions.get(alias)
    if (!s) return
    this.sessions.delete(alias)
    await s.handle.close()
  }

  list() {
    return Array.from(this.sessions.values()).map(s => ({
      alias: s.handle.alias,
      path: s.handle.path,
      lastUsedAt: s.handle.lastUsedAt,
    }))
  }

  async shutdown(): Promise<void> {
    const aliases = Array.from(this.sessions.keys())
    await Promise.all(aliases.map(a => this.release(a)))
  }

  private async enforceCapacity(): Promise<void> {
    while (this.sessions.size > this.opts.maxConcurrent) {
      const lru = this.pickLru()
      if (!lru) break
      await this.release(lru)
    }
  }

  private pickLru(): string | null {
    let worstAlias: string | null = null
    let worstAt = Infinity
    for (const [alias, s] of this.sessions) {
      if (s.handle.lastUsedAt < worstAt) { worstAt = s.handle.lastUsedAt; worstAlias = alias }
    }
    return worstAlias
  }

  async sweepIdle(): Promise<void> {
    const now = Date.now()
    for (const [alias, s] of Array.from(this.sessions.entries())) {
      if (now - s.handle.lastUsedAt >= this.opts.idleEvictMs) {
        await this.release(alias)
      }
    }
  }
}
