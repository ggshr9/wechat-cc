import type { ProviderId, SessionStore } from './session-store'
import type { AgentResult, AgentSession } from './agent-provider'
import type { ProviderRegistry } from './provider-registry'

export interface SessionManagerOptions {
  maxConcurrent: number
  idleEvictMs: number
  /**
   * Provider catalogue (RFC 03 §3.3 / P2). The manager dispatches each
   * acquire() to the right provider instance based on the providerId
   * argument. Two providers can hold concurrent sessions on the same
   * alias — solo-mode chats on different providers do not interfere.
   */
  registry: ProviderRegistry
  /**
   * When present, the manager persists the SDK-reported session_id per
   * (alias, provider) and passes it back as `resume` on the next spawn
   * — slashing daemon-restart cold-start from ~10 s to <3 s.
   */
  sessionStore?: SessionStore
  /** Stored session_id older than this is treated as stale. Default 7 d. */
  resumeTTLMs?: number
}

export interface SessionHandle {
  readonly alias: string
  readonly path: string
  readonly providerId: ProviderId
  lastUsedAt: number
  dispatch(text: string): Promise<{ assistantText: string[]; replyToolCalled: boolean }>
  close(): Promise<void>
  onAssistantText(cb: (text: string) => void): () => void
  onResult(cb: (r: { session_id: string; num_turns: number; duration_ms: number }) => void): () => void
}

interface Internal {
  handle: SessionHandle
  session: AgentSession
}

/** Composite key for the (provider, alias) session map. */
function key(providerId: ProviderId, alias: string): string {
  return `${providerId}:${alias}`
}

export class SessionManager {
  private readonly opts: SessionManagerOptions
  private readonly sessions = new Map<string, Internal>()
  // In-flight spawn promises keyed by (provider, alias). acquire() inserts
  // the spawn promise here BEFORE awaiting provider.spawn(), so a second
  // concurrent acquire on the same key returns the in-flight promise
  // instead of forking a duplicate subprocess. Without this, the companion
  // tick + an inbound message racing on alias `_default` would both miss
  // the cache and both spawn — first one ends up orphaned.
  private readonly pending = new Map<string, Promise<SessionHandle>>()

  constructor(opts: SessionManagerOptions) {
    this.opts = opts
  }

  /**
   * Get or spawn an agent session for (providerId, alias). The same call
   * with different providerIds returns independent sessions — supports
   * RFC 03 P2 solo-mode where chat A is on claude and chat B is on codex
   * but both reference the same project.
   */
  async acquire(alias: string, path: string, providerId: ProviderId): Promise<SessionHandle> {
    const k = key(providerId, alias)
    const existing = this.sessions.get(k)
    if (existing) {
      existing.handle.lastUsedAt = Date.now()
      return existing.handle
    }
    const inFlight = this.pending.get(k)
    if (inFlight) return inFlight
    const promise = this.spawn(alias, path, providerId).finally(() => {
      this.pending.delete(k)
    })
    this.pending.set(k, promise)
    return promise
  }

  private async spawn(alias: string, path: string, providerId: ProviderId): Promise<SessionHandle> {
    const entry = this.opts.registry.get(providerId)
    if (!entry) throw new Error(`unknown provider: ${providerId} (registered: ${this.opts.registry.list().join(', ')})`)
    const { provider, opts: regOpts } = entry

    // Check for a recent session_id to resume — cut cold-start latency.
    const ttl = this.opts.resumeTTLMs ?? 7 * 24 * 60 * 60_000
    const record = this.opts.sessionStore?.get(alias, providerId) ?? null
    let resumeSessionId: string | undefined
    if (record) {
      const age = Date.now() - Date.parse(record.last_used_at)
      const jsonlStillThere = regOpts.canResume(path, record.session_id)
      if (age < ttl && jsonlStillThere) {
        resumeSessionId = record.session_id
        console.error(`wechat channel: [SESSION_RESUME] alias=${alias} sid=${record.session_id} provider=${providerId} age=${Math.round(age / 1000)}s`)
      } else {
        // stale — forget so we don't keep retrying
        this.opts.sessionStore?.delete(alias)
      }
    }

    const project = { alias, path }
    const session = resumeSessionId
      ? await provider.spawn(project, { resumeSessionId })
      : await provider.spawn(project)

    const handle: SessionHandle = {
      alias,
      path,
      providerId,
      lastUsedAt: Date.now(),
      async dispatch(text: string) {
        const result = await session.dispatch(text)
        handle.lastUsedAt = Date.now()
        return result
      },
      async close() {
        await session.close()
      },
      onAssistantText(cb) { return session.onAssistantText(cb) },
      onResult(cb) { return session.onResult(cb) },
    }

    session.onResult((r: AgentResult) => {
      if (r.session_id && this.opts.sessionStore) {
        this.opts.sessionStore.set(alias, r.session_id, providerId)
      }
    })

    this.sessions.set(key(providerId, alias), { handle, session })
    await this.enforceCapacity()
    return handle
  }

  async release(alias: string, providerId: ProviderId): Promise<void> {
    const k = key(providerId, alias)
    const s = this.sessions.get(k)
    if (!s) return
    this.sessions.delete(k)
    await s.handle.close()
  }

  list() {
    return Array.from(this.sessions.values()).map(s => ({
      alias: s.handle.alias,
      path: s.handle.path,
      providerId: s.handle.providerId,
      lastUsedAt: s.handle.lastUsedAt,
    }))
  }

  async shutdown(): Promise<void> {
    const handles = Array.from(this.sessions.values()).map(s => s.handle)
    await Promise.all(handles.map(h => this.release(h.alias, h.providerId)))
  }

  private async enforceCapacity(): Promise<void> {
    while (this.sessions.size > this.opts.maxConcurrent) {
      const lru = this.pickLru()
      if (!lru) break
      await this.release(lru.alias, lru.providerId)
    }
  }

  private pickLru(): { alias: string; providerId: ProviderId } | null {
    let worst: { alias: string; providerId: ProviderId } | null = null
    let worstAt = Infinity
    for (const s of this.sessions.values()) {
      if (s.handle.lastUsedAt < worstAt) {
        worstAt = s.handle.lastUsedAt
        worst = { alias: s.handle.alias, providerId: s.handle.providerId }
      }
    }
    return worst
  }

  async sweepIdle(): Promise<void> {
    const now = Date.now()
    for (const s of Array.from(this.sessions.values())) {
      if (now - s.handle.lastUsedAt >= this.opts.idleEvictMs) {
        await this.release(s.handle.alias, s.handle.providerId)
      }
    }
  }
}
