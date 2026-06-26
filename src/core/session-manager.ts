import type { ProviderId, SessionStore } from './session-store'
import type { AgentEvent, AgentSession } from './agent-provider'
import type { ProviderRegistry } from './provider-registry'
import { tierNameFromProfile, sessionAuthEnv, type TierProfile, type UserTier } from './user-tier'
import type { PermissionMode } from './capability-matrix'
import { log } from '../lib/log'

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
   * (alias, provider, chatId) and passes it back as `resume` on the next
   * spawn — slashing daemon-restart cold-start from ~10 s to <3 s.
   */
  sessionStore?: SessionStore
  /** Stored session_id older than this is treated as stale. Default 7 d. */
  resumeTTLMs?: number
  /**
   * Called whenever a session is released — by the coordinator (timeout /
   * auth-fail self-heal) OR internally (LRU `enforceCapacity`, idle
   * `sweepIdle`, `shutdown`). Wired to the internal-api token registry so the
   * session's per-session auth token is revoked, NOT just the coordinator's
   * explicit releases. `sessionKey` is `provider/alias/chatId` (matches the
   * coordinator's mint key). Centralising here is the single chokepoint that
   * covers every eviction path. Optional — omitted when no registry is wired.
   */
  invalidateSessionToken?: (sessionKey: string) => void
  /**
   * Mint a per-session internal-api token for (tier, sessionKey), wired to the
   * token registry. Called once per real spawn; the tier is recovered from the
   * acquire's tierProfile. Paired with `invalidateSessionToken` at release.
   */
  mintSessionToken?: (tier: UserTier, sessionKey: string) => string
  /**
   * Assemble the per-session system prompt for (providerId, tierProfile),
   * called ONCE per real spawn (cache miss) — the daemon owns prompt content
   * (provider/peer/companion/delegate config + tier-gated sections), the
   * provider just injects the returned string via its transport. Mirrors the
   * `mcpEnv` seam. Omitted in tests/embeddings → `appendInstructions` is left
   * off the SpawnContext entirely.
   */
  buildInstructions?: (providerId: ProviderId, tierProfile: TierProfile) => string
}

/**
 * Options-object argument to `SessionManager.acquire`. The triple
 * (providerId, alias, chatId) is the cache + in-flight key — two chats
 * on the same alias+provider get independent sessions (separate
 * session_ids, separate jsonl files). `tierProfile` is forwarded to
 * `provider.spawn` so the SDK boots with the right permission knobs for
 * this particular chat's caller.
 */
export interface AcquireRequest {
  alias: string
  path: string
  providerId: ProviderId
  chatId: string
  tierProfile: TierProfile
  /**
   * Daemon-wide permission mode. Forwarded into `provider.spawn`'s
   * SpawnContext so providers can honor `--dangerously` independently of
   * tier (see RFC 05 §2.1). When dangerously, every provider's
   * translation short-circuits to its SDK-level bypass equivalent
   * (claude → bypassPermissions, codex → danger-full-access + never).
   */
  permissionMode: PermissionMode
}

/**
 * Options-object argument for the read/write methods that consult the
 * cache but don't need a path/tier (release, isInFlight). Same triple
 * as `AcquireRequest` minus the spawn-time-only fields.
 */
export interface InFlightKey {
  alias: string
  providerId: ProviderId
  chatId: string
}

export interface SessionHandle {
  readonly alias: string
  readonly path: string
  readonly providerId: ProviderId
  lastUsedAt: number
  dispatch(text: string): AsyncIterable<AgentEvent>
  /**
   * Interrupt the in-flight dispatch (if any) on this session. Forwards
   * to the underlying `AgentSession.cancel?.()` — see that interface for
   * provider-specific semantics. Always present on a real handle (the
   * wrapper here no-ops when the session itself doesn't implement
   * cancel). Marked optional so ad-hoc test mocks of SessionHandle can
   * omit it; production code should treat it as always-present.
   */
  cancel?(): Promise<void>
  close(): Promise<void>
}

interface Internal {
  handle: SessionHandle
  session: AgentSession
  chatId: string
}

/** Composite key for the (provider, alias, chatId) session map. */
function sessionKey(k: { alias: string; providerId: ProviderId; chatId: string }): string {
  return `${k.providerId}|${k.alias}|${k.chatId}`
}

export class SessionManager {
  private readonly opts: SessionManagerOptions
  private readonly sessions = new Map<string, Internal>()
  // In-flight spawn promises keyed by (provider, alias, chatId). acquire()
  // inserts the spawn promise here BEFORE awaiting provider.spawn(), so a
  // second concurrent acquire on the same triple returns the in-flight
  // promise instead of forking a duplicate subprocess. Without this, the
  // companion tick + an inbound message racing on the same chat would both
  // miss the cache and both spawn — first one ends up orphaned.
  private readonly pending = new Map<string, Promise<SessionHandle>>()
  // In-flight dispatch counter keyed by (provider, alias, chatId). Each
  // dispatch() iterator increments on first .next() entry and decrements
  // in its finally block. sweepIdle skips any session with count > 0 — a
  // 30 min+ turn must not be killed mid-stream just because lastUsedAt
  // looks stale. release() / shutdown / enforceCapacity ignore the counter
  // (those are operator-triggered or capacity-enforced and must be
  // unconditional).
  private readonly inFlight = new Map<string, number>()

  constructor(opts: SessionManagerOptions) {
    this.opts = opts
  }

  /**
   * Get or spawn an agent session for (providerId, alias, chatId). The
   * same call with different providerIds returns independent sessions
   * — supports RFC 03 P2 solo-mode where chat A is on claude and chat B
   * is on codex but both reference the same project. Different chatIds
   * on the same (alias, provider) also return independent sessions —
   * required for per-chat tier policy + per-chat conversation isolation.
   */
  async acquire(req: AcquireRequest): Promise<SessionHandle> {
    const k = sessionKey({ alias: req.alias, providerId: req.providerId, chatId: req.chatId })
    const existing = this.sessions.get(k)
    if (existing) {
      existing.handle.lastUsedAt = Date.now()
      return existing.handle
    }
    const inFlight = this.pending.get(k)
    if (inFlight) return inFlight
    const promise = this.spawn(req).finally(() => {
      this.pending.delete(k)
    })
    this.pending.set(k, promise)
    return promise
  }

  private async spawn(req: AcquireRequest): Promise<SessionHandle> {
    const entry = this.opts.registry.get(req.providerId)
    if (!entry) throw new Error(`unknown provider: ${req.providerId} (registered: ${this.opts.registry.list().join(', ')})`)
    const { provider, opts: regOpts } = entry

    // Check for a recent session_id to resume — cut cold-start latency.
    const ttl = this.opts.resumeTTLMs ?? 7 * 24 * 60 * 60_000
    const record = this.opts.sessionStore?.get({ alias: req.alias, provider: req.providerId, chatId: req.chatId }) ?? null
    let resumeSessionId: string | undefined
    if (record) {
      const age = Date.now() - Date.parse(record.last_used_at)
      const jsonlStillThere = regOpts.canResume(req.path, record.session_id)
      if (age < ttl && jsonlStillThere) {
        resumeSessionId = record.session_id
        log('SESSION_RESUME', `alias=${req.alias} chat=${req.chatId} sid=${record.session_id} provider=${req.providerId} age=${Math.round(age / 1000)}s`)
      } else {
        // stale — forget THIS (provider, chatId) row only. delete() would
        // also wipe sibling rows for the same chat under other providers.
        this.opts.sessionStore?.deleteOne({ alias: req.alias, provider: req.providerId, chatId: req.chatId })
      }
    }

    const project = { alias: req.alias, path: req.path }
    // Mint the per-session auth token HERE — once per real spawn (cache miss),
    // not per dispatch. The token's tier is recovered from the resolved
    // tierProfile; its key matches release-time invalidation (provider/alias/
    // chatId). Minting in the coordinator instead would re-mint on every cache
    // hit (acquire ignores it), leaking one registered-but-unused token per
    // dispatch into the registry.
    const tokenKey = `${req.providerId}/${req.alias}/${req.chatId}`
    const tier = tierNameFromProfile(req.tierProfile)
    const sessionToken = this.opts.mintSessionToken?.(tier, tokenKey)
    // Compute the per-spawn MCP env overlay ONCE here (the daemon owns the
    // tier→env policy); providers merge it blindly into their MCP children.
    const mcpEnv = sessionAuthEnv(tier, sessionToken)
    // Assemble the per-session system prompt the same place + same way as
    // mcpEnv: daemon-owned, computed once per spawn, forwarded for the provider
    // to inject. Conditionally spread so non-wired callers (tests/embeddings)
    // leave the field off entirely.
    const appendInstructions = this.opts.buildInstructions?.(req.providerId, req.tierProfile)
    let session: AgentSession
    try {
      session = await provider.spawn(project, {
        ...(resumeSessionId ? { resumeSessionId } : {}),
        tierProfile: req.tierProfile,
        permissionMode: req.permissionMode,
        // Forward chatId so the Claude provider can bake it into a
        // per-session canUseTool closure (see bootstrap/index.ts).
        chatId: req.chatId,
        mcpEnv,
        ...(appendInstructions !== undefined ? { appendInstructions } : {}),
      })
    } catch (err) {
      // spawn failed → the session is never cached, so release() never runs
      // and the just-minted token would leak in the registry forever. Revoke
      // it on the error path before propagating.
      this.opts.invalidateSessionToken?.(tokenKey)
      throw err
    }

    const sessionStore = this.opts.sessionStore
    const k = sessionKey({ alias: req.alias, providerId: req.providerId, chatId: req.chatId })
    const inFlight = this.inFlight
    const handle: SessionHandle = {
      alias: req.alias,
      path: req.path,
      providerId: req.providerId,
      lastUsedAt: Date.now(),
      dispatch(text: string): AsyncIterable<AgentEvent> {
        handle.lastUsedAt = Date.now()
        const inner = session.dispatch(text)
        // Track in-flight under (provider, alias, chatId) so sweepIdle
        // can skip busy sessions. Wrap unconditionally — even when
        // sessionStore is absent — otherwise an iterator started without
        // persistence won't bump the counter and a long turn gets evicted
        // mid-stream.
        return {
          async *[Symbol.asyncIterator]() {
            inFlight.set(k, (inFlight.get(k) ?? 0) + 1)
            try {
              for await (const ev of inner) {
                yield ev
                if (ev.kind === 'result' && ev.sessionId && sessionStore) {
                  sessionStore.set({ alias: req.alias, provider: req.providerId, chatId: req.chatId, sessionId: ev.sessionId })
                }
              }
            } finally {
              const n = inFlight.get(k) ?? 1
              if (n <= 1) inFlight.delete(k)
              else inFlight.set(k, n - 1)
            }
          },
        }
      },
      async cancel() {
        await session.cancel?.()
      },
      async close() {
        await session.close()
      },
    }

    this.sessions.set(k, { handle, session, chatId: req.chatId })
    await this.enforceCapacity()
    return handle
  }

  async release(k: InFlightKey): Promise<void> {
    const key = sessionKey(k)
    const s = this.sessions.get(key)
    if (!s) return
    this.sessions.delete(key)
    // Revoke the session's auth token on EVERY release path (coordinator +
    // internal LRU/idle/shutdown eviction). The token key matches what the
    // coordinator minted: provider/alias/chatId (NOT the cache `sessionKey`).
    this.opts.invalidateSessionToken?.(`${k.providerId}/${k.alias}/${k.chatId}`)
    await s.handle.close()
  }

  /**
   * True when (alias, providerId, chatId) has at least one dispatch
   * iterator currently running. Caller can use this to gate background
   * work (companion ticks, etc.) so it doesn't contend with a
   * user-initiated turn on the same session. Counter is incremented at
   * iterator entry and decremented in finally — accurate without
   * external locking.
   */
  isInFlight(k: InFlightKey): boolean {
    return (this.inFlight.get(sessionKey(k)) ?? 0) > 0
  }

  list() {
    return Array.from(this.sessions.values()).map(s => ({
      alias: s.handle.alias,
      path: s.handle.path,
      providerId: s.handle.providerId,
      chatId: s.chatId,
      lastUsedAt: s.handle.lastUsedAt,
    }))
  }

  async shutdown(): Promise<void> {
    const entries = Array.from(this.sessions.values())
    await Promise.all(entries.map(s => this.release({
      alias: s.handle.alias,
      providerId: s.handle.providerId,
      chatId: s.chatId,
    })))
  }

  private async enforceCapacity(): Promise<void> {
    while (this.sessions.size > this.opts.maxConcurrent) {
      const lru = this.pickLru()
      if (!lru) break
      await this.release(lru)
    }
  }

  private pickLru(): InFlightKey | null {
    let worst: InFlightKey | null = null
    let worstAt = Infinity
    for (const s of this.sessions.values()) {
      if (s.handle.lastUsedAt < worstAt) {
        worstAt = s.handle.lastUsedAt
        worst = { alias: s.handle.alias, providerId: s.handle.providerId, chatId: s.chatId }
      }
    }
    return worst
  }

  async sweepIdle(): Promise<void> {
    const now = Date.now()
    for (const s of Array.from(this.sessions.values())) {
      // Never evict a session with an active dispatch — killing it mid-
      // stream would leave the coordinator's collectTurn loop hanging on
      // a queue that's about to be nulled out.
      const k = sessionKey({ alias: s.handle.alias, providerId: s.handle.providerId, chatId: s.chatId })
      if ((this.inFlight.get(k) ?? 0) > 0) continue
      if (now - s.handle.lastUsedAt >= this.opts.idleEvictMs) {
        await this.release({ alias: s.handle.alias, providerId: s.handle.providerId, chatId: s.chatId })
      }
    }
  }
}
