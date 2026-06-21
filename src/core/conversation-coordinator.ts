/**
 * conversation-coordinator — replaces the straight-line routeInbound
 * with mode-aware dispatch (RFC 03 §3.2 / §4).
 *
 * For each inbound, the coordinator:
 *   1. Resolves the chat's project alias via the project resolver.
 *   2. Looks up the chat's persisted Mode (or falls back to the daemon
 *      default — a solo mode using the bootstrap-time provider).
 *   3. Acquires the participant session(s) from SessionManager keyed by
 *      (provider, alias).
 *   4. Dispatches per the mode's semantics.
 *
 * All Mode variants are implemented: `solo` (single provider), `parallel`
 * (`/both` — concurrent replies), `primary_tool` (`/cc + codex` — one drives,
 * the other is exposed as a tool), and `chatroom` (`/chat` — moderated
 * round-table).
 */
import type { SessionManager } from './session-manager'
import type { ConversationStore } from './conversation-store'
import type { ProviderRegistry } from './provider-registry'
import type { Mode, ProviderId } from './conversation'
import type { InboundMsg } from './prompt-format'
import { evaluateRound as evaluateModeratorRound, type ModeratorDecision, type ChatroomEntry } from './chatroom-moderator'
import { assertSupported, UnsupportedCombinationError, type PermissionMode } from './capability-matrix'
import { collectTurn, TURN_TIMEOUT_CODE, type TurnSummary } from './agent-provider'
import { resolveEffectiveTier, TIER_PROFILES } from './user-tier'
import type { Access } from '../lib/access'

/**
 * Structured, per-turn outcome record — the AI-native observability surface.
 * Emitted once per solo dispatch via `ConversationCoordinatorDeps.recordTurn`.
 * The daemon stores a ring of these (and/or exposes them on internal-api) so
 * a human — or an LLM diagnosing the daemon — can answer "what happened to
 * this chat's last turn" without grepping free-text logs. `outcome` is the
 * causal verdict; `error` carries the detail for `timeout`/`error` cases.
 */
export interface TurnRecord {
  chatId: string
  provider: ProviderId
  alias: string
  mode: Mode['kind']
  /** Epoch ms when the dispatch began (clock from `deps.now`). */
  startedAt: number
  /** Epoch ms when the dispatch settled. */
  endedAt: number
  durationMs: number
  outcome: 'completed' | 'timeout' | 'auth_failed' | 'error'
  replyToolCalled: boolean
  /** Count of assistant text chunks produced this turn. */
  textChunks: number
  /** Failure detail for `timeout` / `error` outcomes; undefined otherwise. */
  error?: string
}

export interface ConversationCoordinatorDeps {
  resolveProject(chatId: string): { alias: string; path: string } | null
  manager: Pick<SessionManager, 'acquire'> & Partial<Pick<SessionManager, 'release'>>
  conversationStore: Pick<ConversationStore, 'get' | 'set' | 'setParticipants'>
  registry: Pick<ProviderRegistry, 'has' | 'list' | 'get'>
  /**
   * Default provider id for chats with no explicit Mode set. Mirrors
   * the daemon's agent-config.provider — i.e. on a fresh install
   * everything answers under whichever provider the user picked at
   * setup time, until they say `/cc` or `/codex` to override per-chat.
   */
  defaultProviderId: ProviderId
  /**
   * Default provider ids for primary_tool peer validation. Defaults to
   * `['claude', 'codex']` — the two providers shipped before cursor.
   * Used ONLY by validateMode for primary_tool (the peer must be one
   * of these). For parallel/chatroom, the active set is resolved
   * per-dispatch from Mode.participants (or the registry as a fallback)
   * via resolveParticipants — this dep is NOT consulted there.
   */
  parallelProviders?: ProviderId[]
  /**
   * Maximum inter-agent rounds for chatroom mode (RFC 03 §4.4). Default 4.
   * Counts each speaker turn after the initial user turn. When hit, the
   * loop forces termination and the moderator's final-round prompt asks
   * the last speaker to summarize with a 🎯 prefix.
   */
  chatroomMaxRounds?: number
  /**
   * Permission mode — 'strict' (default, per-tool relay) or 'dangerously'
   * (bypass all permission prompts). Computed once at bootstrap from
   * `dangerouslySkipPermissions`. Threaded into assertSupported() at
   * dispatch entry and used by capability-matrix to gate combinations.
   */
  permissionMode: PermissionMode
  /**
   * Per-turn watchdog (ms). When set, every solo turn is bounded: if the
   * agent stream goes silent this long, the turn is abandoned, the wedged
   * session is released (self-heal — next message gets a fresh subprocess),
   * and the user is told to retry. Omit to disable (legacy unbounded
   * behaviour — used by tests that don't exercise the timeout path).
   * Bootstrap wires this from config so the daemon never wedges on a
   * stalled SDK subprocess. See [[TURN_TIMEOUT_CODE]].
   */
  turnTimeoutMs?: number
  /**
   * Sink for the per-turn structured record (see [[TurnRecord]]). Optional —
   * tests and minimal embeddings can omit it. Bootstrap wires it to a daemon
   * ring buffer surfaced on internal-api for diagnosis/self-healing.
   */
  recordTurn?: (record: TurnRecord) => void
  format: (msg: InboundMsg) => string
  sendAssistantText?: (chatId: string, text: string) => Promise<void>
  /**
   * Optional `fields` arg lands in the JSONL sidecar (channel.log.jsonl)
   * for programmatic consumers. Stubs that don't care can ignore it
   * (third arg is optional in the daemon's real `log` impl too).
   */
  log: (tag: string, line: string, fields?: Record<string, unknown>) => void
  /**
   * One-shot Claude Haiku eval used by the chatroom moderator (v0.5.8).
   * Bootstrap wires this to `query()` from `@anthropic-ai/claude-agent-sdk`
   * with model='claude-haiku-4-5' + maxTurns=1. Test stubs return mock
   * decisions directly. Each /chat dispatch calls this 3-5×.
   *
   * Optional so existing test fixtures (most don't exercise /chat) don't
   * have to provide a stub. If the chatroom path runs without it, the
   * moderator fallback always picks alternation + a generic prompt — the
   * loop still functions, just without LLM-quality routing decisions.
   */
  haikuEval?: (prompt: string) => Promise<string>
  /**
   * Throttle window (ms) for the per-provider "登录已过期" notice the coordinator
   * emits when a provider reports `errorCode: 'auth_failed'`. The first
   * failure in a chat sends one notice; further failures within this
   * window are silent (avoids spamming the user while their AI session
   * is broken). Default: 60 min.
   */
  authFailNotifyThrottleMs?: number
  /**
   * Clock injection — used by the auth-failed notice throttle so tests
   * can drive virtual time without `vi.useFakeTimers()`. Defaults to
   * `Date.now`.
   */
  now?: () => number
  /**
   * Loads the current access.json snapshot. Called once per dispatch to
   * resolve the inbound chatId's tier (`resolveTier(chatId, access)`) →
   * `TIER_PROFILES[tier]` → handed to `manager.acquire({tierProfile})`.
   * The real impl (src/lib/access.ts) maintains a 5s TTL cache so this
   * is cheap to call per message; tests can pass a constant lambda.
   */
  loadAccess: () => Access
}

/** User-facing notice when a provider reports auth_failed.
 *  Per-provider phrasing: the user already authenticated once; the
 *  session lapsed and they need to re-run the provider's login command
 *  on the same machine. */
function authFailNotice(providerId: ProviderId): string {
  if (providerId === 'codex') return '⚠ Codex 登录已过期，请在电脑上跑 `codex login` 后再发消息。'
  return '⚠ Claude 登录已过期，请在电脑上跑 `claude login` 后再发消息。'
}

export interface ConversationCoordinator {
  dispatch(msg: InboundMsg): Promise<void>
  /**
   * Get the effective mode for a chat — persisted value, or the daemon
   * default if none. Used by mode-commands to render `/mode` status.
   */
  getMode(chatId: string): Mode
  /**
   * Set the mode for a chat. Validates that any ProviderId mentioned in
   * the mode is actually registered. As a side effect: clears any
   * chatroom-specific per-chat memory when the chat exits chatroom
   * (RFC 03 review #3 partial — full session release is left to LRU /
   * idle eviction because the (alias, providerId) key is shared across
   * chats and per-chat release would leak across boundaries).
   */
  setMode(chatId: string, mode: Mode): void
  /**
   * Abort an in-flight chatroom dispatch loop for this chat (RFC 03
   * review #11). Returns true iff a loop was actually in flight and
   * was signalled. Other-mode dispatches are not preemptable (they're
   * single-turn).
   */
  cancel(chatId: string): boolean
}

export function createConversationCoordinator(deps: ConversationCoordinatorDeps): ConversationCoordinator {
  function defaultMode(): Mode {
    return { kind: 'solo', provider: deps.defaultProviderId }
  }

  function getMode(chatId: string): Mode {
    const persisted = deps.conversationStore.get(chatId)
    return persisted?.mode ?? defaultMode()
  }

  const parallelProviders: ProviderId[] = deps.parallelProviders ?? ['claude', 'codex']
  const chatroomMaxRounds = deps.chatroomMaxRounds ?? 4

  /**
   * Resolve the active participant set for a parallel/chatroom dispatch.
   *
   * Priority:
   *   1. Explicit mode.participants (the user wrote `/chat claude codex cursor`).
   *   2. Legacy backfill — chat row pre-dates the participants column;
   *      use the first 2 registered providers and persist so the user's
   *      "this chat was 2-way" expectation survives a future operator
   *      install of a 3rd provider.
   *   3. Fresh-chat fallback — no row yet; use the full registry.list().
   *
   * Then filter against the current registry (silently drop providers
   * that vanished from the registry post-persist), and hard-cap at 3
   * in P1 with a log warning if exceeded.
   *
   * Returns the resolved list (≥0 elements). Caller is responsible for
   * the ≤1 → solo+default degradation; this helper does not throw.
   */
  function resolveParticipants(
    mode: (Mode & { kind: 'parallel' | 'chatroom' }),
    chatId: string,
  ): ProviderId[] {
    let list: ProviderId[]
    if (mode.participants !== undefined) {
      list = mode.participants
    } else if (deps.conversationStore.get(chatId)?.mode) {
      // Row exists with no participants — legacy. Backfill to first-two.
      list = deps.registry.list().slice(0, 2)
      // Persist so this is a one-shot. setParticipants is a no-op if the
      // row doesn't have parallel/chatroom kind, but we just read it as
      // parallel/chatroom so the call is safe.
      try {
        deps.conversationStore.setParticipants(chatId, list)
        deps.log('COORDINATOR', `chat=${chatId} legacy ${mode.kind} backfilled participants=${list.join(',')}`)
      } catch (err) {
        deps.log('COORDINATOR', `chat=${chatId} setParticipants failed: ${err instanceof Error ? err.message : err}`)
      }
    } else {
      // No row yet — first-ever dispatch in this chat under parallel/chatroom.
      list = deps.registry.list()
    }
    const filtered = list.filter(p => deps.registry.has(p))
    if (filtered.length < list.length) {
      deps.log('COORDINATOR', `chat=${chatId} participants filtered ${list.join(',')} → ${filtered.join(',')} (registry: ${deps.registry.list().join(',')})`)
    }
    if (filtered.length > 3) {
      const capped = filtered.slice(0, 3)
      deps.log('COORDINATOR', `chat=${chatId} participants > 3; capping at ${capped.join(',')}`)
      return capped
    }
    return filtered
  }

  const authFailThrottleMs = deps.authFailNotifyThrottleMs ?? 60 * 60_000
  const nowMs = deps.now ?? Date.now
  // chatId → last-notice-at; used to throttle the auth_failed notice.
  const authFailLastNotifyAt = new Map<string, number>()

  /** On auth_failed: release the in-memory session (so the next dispatch
   *  starts a fresh subprocess that re-reads keychain — self-heal without
   *  waiting for an idle gap that a busy chat never reaches), then send
   *  one throttled neutral notice. On throttle the chat is silent — the
   *  user already saw the notice within the window. */
  async function handleAuthFailed(chatId: string, alias: string, providerId: ProviderId, summary: TurnSummary): Promise<void> {
    deps.log('AUTH_FAILED', `chat=${chatId} alias=${alias} provider=${providerId} message=${JSON.stringify((summary.error ?? '').slice(0, 200))}`, {
      event: 'auth_failed',
      chat_id: chatId,
      project_alias: alias,
      provider: providerId,
    })
    // Release is best-effort — if it throws we still want to send the user
    // notice. release() being absent from the manager dep (e.g. in test
    // fixtures that don't exercise the recycle path) is also tolerated.
    try {
      // Release the same session triple that dispatchSolo/Parallel/Chatroom
      // registered under (per-chat now since Task 10). A fresh dispatch in
      // this chat re-acquires from a clean subprocess that re-reads
      // keychain creds.
      await deps.manager.release?.({ alias, providerId, chatId })
    } catch (err) {
      deps.log('AUTH_FAILED', `release ${alias}/${providerId} threw: ${err instanceof Error ? err.message : err}`)
    }
    const last = authFailLastNotifyAt.get(chatId) ?? 0
    if (nowMs() - last < authFailThrottleMs) return
    authFailLastNotifyAt.set(chatId, nowMs())
    await deps.sendAssistantText?.(chatId, authFailNotice(providerId))
  }

  /** On a per-turn watchdog timeout: the agent stream stalled silently.
   *  Release the (now-poisoned) session so the NEXT message in this chat
   *  re-acquires a fresh subprocess instead of throwing "previous dispatch
   *  still in flight" forever — same self-heal shape as [[handleAuthFailed]].
   *  Then tell the user to retry. Unlike auth_failed this is not throttled:
   *  a timeout is a one-off transient, and the user needs to know their
   *  message was dropped, not silently swallowed. */
  async function handleTurnTimeout(chatId: string, alias: string, providerId: ProviderId, summary: TurnSummary): Promise<void> {
    deps.log('TURN_TIMEOUT', `chat=${chatId} alias=${alias} provider=${providerId} ${summary.error ?? ''}`, {
      event: 'turn_timeout',
      chat_id: chatId,
      project_alias: alias,
      provider: providerId,
    })
    try {
      await deps.manager.release?.({ alias, providerId, chatId })
    } catch (err) {
      deps.log('TURN_TIMEOUT', `release ${alias}/${providerId} threw: ${err instanceof Error ? err.message : err}`)
    }
    await deps.sendAssistantText?.(chatId, '⏱ 处理超时了，刚才那条没能回复，请稍后重发一次。')
  }
  // v0.5.9 — chatroom is now a persistent session per chatId. History
  // accumulates across user messages until the user switches mode away
  // from chatroom (then we delete the entry). Lets the moderator see the
  // full prior discussion when picking the next speaker / decision.
  // In-memory only (Q4: not persisted across daemon restart — speakers'
  // SDK sessions still continue, the moderator just observes a fresh
  // chatroom from its perspective; minor inconsistency, low cost).
  const chatroomHistories = new Map<string, ChatroomEntry[]>()
  // RFC 03 review #11 — per-chat AbortController for in-flight chatroom
  // loops. dispatchChatroom registers; coordinator.cancel() signals; /stop
  // in mode-commands triggers cancel before flipping mode.
  const inFlightAborters = new Map<string, AbortController>()
  // PR C2 — per-chat promise that resolves when the active dispatchChatroom
  // call has finished its finally block (history persisted, aborter slot
  // cleared). A NEW chatroom dispatch in the same chat awaits this so the
  // "latest user msg wins" preempt path doesn't race the prior loop's
  // history.set with its own snapshot read.
  const inFlightDispatchPromises = new Map<string, Promise<void>>()

  function validateMode(mode: Mode): void {
    // Reject unknown providers up front so the caller (mode-commands or
    // a programmatic setter) gets a clear error instead of a downstream
    // "unknown provider" from acquire().
    if (mode.kind === 'solo') {
      if (!deps.registry.has(mode.provider)) {
        throw new Error(`unknown provider: ${mode.provider} (registered: ${deps.registry.list().join(', ')})`)
      }
    }
    if (mode.kind === 'primary_tool') {
      if (!deps.registry.has(mode.primary)) {
        throw new Error(`unknown primary provider: ${mode.primary}`)
      }
      // The peer (other registered provider) must also be available so
      // delegate-mcp can actually do something. parallelProviders is
      // also the "all participating providers" set for primary_tool.
      const missing = parallelProviders.filter(p => !deps.registry.has(p))
      if (missing.length > 0) {
        throw new Error(`mode 'primary_tool' requires both providers ${parallelProviders.join(', ')}; missing: ${missing.join(', ')}`)
      }
    }
    if (mode.kind === 'parallel' || mode.kind === 'chatroom') {
      // Explicit participants must all be registered. Undefined defers
      // to dispatch-time resolution (resolveParticipants).
      if (mode.participants !== undefined) {
        const unknown = mode.participants.filter(p => !deps.registry.has(p))
        if (unknown.length > 0) {
          throw new Error(`mode '${mode.kind}' has unknown providers: ${unknown.join(', ')} (registered: ${deps.registry.list().join(', ')})`)
        }
        if (mode.participants.length < 2) {
          throw new Error(`mode '${mode.kind}' requires ≥2 participants; got ${mode.participants.length}`)
        }
      }
      // No else — undefined is fine; resolveParticipants handles fresh
      // and legacy chats.
    }
  }

  async function dispatchSolo(
    msg: InboundMsg,
    proj: { alias: string; path: string },
    providerId: ProviderId,
  ): Promise<void> {
    const tier = resolveEffectiveTier(msg.chatId, deps.loadAccess(), deps.permissionMode)
    const tierProfile = TIER_PROFILES[tier]
    deps.log('COORDINATOR', `solo chat=${msg.chatId} → project=${proj.alias} provider=${providerId} tier=${tier}`, {
      event: 'dispatch_solo',
      chat_id: msg.chatId,
      project_alias: proj.alias,
      provider: providerId,
      tier,
    })
    // One structured TurnRecord is emitted per dispatch in the finally
    // below — exactly once, on every path (completed / timeout / auth /
    // unexpected throw). This is the AI-legible / human-legible trace that
    // makes "why did chat X stop replying at HH:MM" a query, not a log dig.
    const startedAt = nowMs()
    let outcome: TurnRecord['outcome'] = 'error'
    let summary: TurnSummary | undefined
    try {
      const handle = await deps.manager.acquire({
        alias: proj.alias,
        path: proj.path,
        providerId,
        chatId: msg.chatId,
        tierProfile,
        permissionMode: deps.permissionMode,
      })
      const text = deps.format(msg)
      summary = await collectTurn(handle.dispatch(text), { timeoutMs: deps.turnTimeoutMs })
      const assistantTexts = summary.assistantText
      const replyToolCalled = summary.replyToolCalled

      // Per-turn watchdog fired: the SDK stream went silent. Discard the
      // wedged session and tell the user to retry — must come before the
      // fallback-text path so a stalled turn never leaks a partial reply.
      if (summary.errorCode === TURN_TIMEOUT_CODE) {
        outcome = 'timeout'
        await handleTurnTimeout(msg.chatId, proj.alias, providerId, summary)
        return
      }

      // Structured auth-failure path: provider intercepted the "Not logged in"
      // assistant text and re-emitted it as a coded error. Suppress fallback
      // and send a throttled neutral notice instead — never leak provider
      // failure text to the user.
      if (summary.errorCode === 'auth_failed') {
        outcome = 'auth_failed'
        await handleAuthFailed(msg.chatId, proj.alias, providerId, summary)
        return
      }

      outcome = summary.error ? 'error' : 'completed'

      // Same fallback semantics as the legacy routeInbound: only forward
      // raw assistant text when the agent did NOT call a reply-family
      // tool this turn. Prevents the duplicate-message footgun while
      // protecting users from a forgetful agent that describes an image
      // in plain text without ever calling reply.
      if (replyToolCalled || assistantTexts.length === 0) return
      deps.log('FALLBACK_REPLY', `chat=${msg.chatId} project=${proj.alias} provider=${providerId} chunks=${assistantTexts.length} preview=${JSON.stringify(assistantTexts[0]?.slice(0, 80) ?? '')}`)
      for (const t of assistantTexts) {
        await deps.sendAssistantText?.(msg.chatId, t)
      }
    } finally {
      const endedAt = nowMs()
      deps.recordTurn?.({
        chatId: msg.chatId,
        provider: providerId,
        alias: proj.alias,
        mode: 'solo',
        startedAt,
        endedAt,
        durationMs: endedAt - startedAt,
        outcome,
        replyToolCalled: summary?.replyToolCalled ?? false,
        textChunks: summary?.assistantText.length ?? 0,
        error: summary?.error,
      })
    }
  }

  /**
   * RFC 03 §4.4 chatroom mode (v0.5.8 rewrite — moderator-driven).
   *
   * Through v0.5.7 the chatroom was self-routing via @-tags in speakers'
   * outputs. That fought the model's training prior toward "give the
   * user a complete answer", so both agents typically @user'd directly
   * and /chat looked indistinguishable from /both. Now a separate
   * claude-haiku-4-5 moderator (one-shot eval per round) decides who
   * speaks next and crafts a targeted prompt — same architecture as
   * AutoGen's GroupChatManager, CrewAI hierarchical mode, and Anthropic's
   * orchestrator-worker pattern.
   *
   * Sequence per round:
   *   1. moderator.evaluateRound(...) → {action, speaker, prompt}
   *   2. If action='end' → break.
   *   3. Else dispatch the prompt to the picked speaker's session.
   *   4. Stream their output to user with [Display] prefix and append
   *      to history.
   *   5. Loop until end / max_rounds / abort.
   *
   * Costs ~3-5 haiku evals per /chat (~$0.01-0.05), latency overhead
   * ~5-10s. The trade is worth it for actual back-and-forth instead of
   * /both-with-extra-steps.
   */
  async function dispatchChatroom(
    msg: InboundMsg,
    proj: { alias: string; path: string },
    participants: ProviderId[],
  ): Promise<void> {
    // P3 — N participants. Coordinator's resolveParticipants enforces ≥2
    // and ≤3. Empty/single is degraded to solo upstream.

    // PR C2 — preempt any in-flight dispatch for this same chat. Without
    // this, two rapid messages produce concurrent loops that race on
    // chatroomHistories.set (last writer wins → lost user msgs).
    //
    // Loop is required for ≥3 rapid dispatches: when B and C both arrive
    // while A is in flight, both read A as their prior and both await A.
    // After A finishes, both wake; if only the FIRST checks-and-claims
    // the slot, the SECOND would silently overwrite without aborting. We
    // re-read after each await so each new wave gets preempted by the
    // next arrival, all the way until the slot is empty (in single-
    // threaded-JS sense — guaranteed by the synchronous map set below).
    // Loop is required for ≥3 rapid dispatches: when B and C both arrive
    // while A is in flight, both read A as their prior and both await A.
    // After A finishes, both wake; if only the FIRST checks-and-claims
    // the slot, the SECOND would silently overwrite without aborting. We
    // re-read after each await so each new wave gets preempted by the
    // next arrival, all the way until the slot is empty (in single-
    // threaded-JS sense — guaranteed by the synchronous map set below).
    while (true) {
      const priorAborter = inFlightAborters.get(msg.chatId)
      const priorPromise = inFlightDispatchPromises.get(msg.chatId)
      if (!priorAborter) break
      deps.log('COORDINATOR_CHATROOM', `chat=${msg.chatId} → preempting prior in-flight dispatch`)
      priorAborter.abort()
      if (priorPromise) {
        try { await priorPromise } catch { /* prior dispatch's own error path */ }
      }
    }

    // RFC 03 review #11 — per-chat AbortController so /stop can preempt
    // an in-flight loop. Single-flight per chat (see preempt step above).
    const aborter = new AbortController()
    inFlightAborters.set(msg.chatId, aborter)

    let dispatchResolve!: () => void
    const dispatchPromise = new Promise<void>(resolve => { dispatchResolve = resolve })
    inFlightDispatchPromises.set(msg.chatId, dispatchPromise)

    // Tier is derived once at dispatch entry — both speaker turns within
    // the same /chat originate from the same chatId so they share the
    // same tier profile. (Re-resolving per round would let an access.json
    // edit mid-loop take effect; we prefer consistency within one user
    // turn.)
    const tier = resolveEffectiveTier(msg.chatId, deps.loadAccess(), deps.permissionMode)
    const tierProfile = TIER_PROFILES[tier]

    // v0.5.9 — chatroom is a persistent session. Pull existing history
    // (from prior user msgs in this chatroom), append the new user msg,
    // and let the moderator see the whole sequence.
    //
    // PR C1 — shallow-copy the stored array before mutating so each
    // dispatch operates on its own snapshot. The preempt step above
    // additionally serialises overlapping dispatches per chat, so the
    // snapshot we read here is the latest persisted history.
    const history: ChatroomEntry[] = [...(chatroomHistories.get(msg.chatId) ?? [])]
    history.push({ role: 'user', text: deps.format(msg) })

    deps.log('COORDINATOR', `chatroom chat=${msg.chatId} → start participants=${participants.join(',')} max=${chatroomMaxRounds} history=${history.length} tier=${tier}`)

    try {
    for (let round = 1; round <= chatroomMaxRounds; round++) {
      if (aborter.signal.aborted) {
        deps.log('COORDINATOR_CHATROOM', `chat=${msg.chatId} aborted at round ${round}`)
        await deps.sendAssistantText?.(msg.chatId, '⏸ chatroom 已收到 /stop，提前终止本轮（已派出的 turn 无法撤回）。')
        break
      }

      // Moderator picks who speaks next + crafts their prompt.
      // Without a haikuEval dep we always hit the fallback (forced
      // alternation, generic prompt) — keeps the loop functional but
      // loses the targeted-prompt benefit. Bootstrap wires the real one.
      const haikuEval = deps.haikuEval ?? (async () => {
        throw new Error('haikuEval not wired')
      })
      let decision: ModeratorDecision
      try {
        decision = await evaluateModeratorRound(
          {
            history,
            round,
            maxRounds: chatroomMaxRounds,
            participants,
          },
          { haikuEval, log: deps.log },
        )
      } catch (err) {
        // evaluateRound has its own fallbacks; if even those throw we
        // bail to user-facing error rather than silently hanging.
        const reason = err instanceof Error ? err.message : String(err)
        deps.log('COORDINATOR_CHATROOM', `moderator threw: ${reason}; ending chatroom`)
        await deps.sendAssistantText?.(msg.chatId, `[chatroom] 主持人调用失败：${reason}`)
        break
      }

      if (decision.action === 'end') {
        deps.log('COORDINATOR_CHATROOM', `chat=${msg.chatId} round=${round} moderator end (${decision.reasoning ?? '—'})`)
        break
      }

      const { speaker, prompt } = decision
      const isFinalRound = round === chatroomMaxRounds
      deps.log('COORDINATOR_CHATROOM', `round=${round} speaker=${speaker} final=${isFinalRound} (mod: ${decision.reasoning ?? '—'})`)

      // Belt-and-suspenders coda. The moderator's instructions already tell
      // it to append "use plain text, don't call reply tool" to every
      // generated prompt, but we re-append unconditionally here so even a
      // moderator that forgets (or a fallback decision that didn't run
      // through MODERATOR_INSTRUCTIONS) still pins the speaker to plain
      // text. Mixing reply-tool turns with plain-text turns produced the
      // visual inconsistency users flagged on 2026-05-06.
      const promptWithCoda = prompt.includes('不要调 reply 工具')
        ? prompt
        : `${prompt}\n\n[chatroom 模式]：请用纯文本回复，不要调 reply 工具。daemon 会自动加 [Display] 前缀转发给用户。`

      // Re-inject the structural metadata moderator paraphrase tends to
      // strip. Solo / parallel dispatch format(msg) directly so the
      // <wechat chat_id="..."> envelope reaches the speaker, but chatroom
      // funnels through haiku-4-5 which keeps the conversational meaning
      // and drops the identifiers + attachment markers (2026-05-08 audit).
      //
      // Two pieces always matter to the speaker in chatroom mode:
      //   1. chat_id — needed to namespace memory_*, set_user_name, etc.
      //      The speaker session is per-(provider, alias) and may serve
      //      multiple chats, so it can't infer this from session state.
      //   2. attachment markers — the speaker has Read/Bash but no path
      //      to open without an explicit `[image:/abs/path]` line.
      //
      // Dedup against whatever the moderator did happen to keep so we
      // never double-print the same marker.
      const contextLines: string[] = []
      const chatHeader = `[chat_id:${msg.chatId}]`
      if (!promptWithCoda.includes(chatHeader)) contextLines.push(chatHeader)
      const attachmentMarkers = (msg.attachments ?? [])
        .map(a => `[${a.kind}:${a.path}]`)
        .filter(m => !promptWithCoda.includes(m))
      if (attachmentMarkers.length > 0) {
        contextLines.push('附件（用户消息中带的，可用 Read/Bash 打开）：')
        contextLines.push(...attachmentMarkers)
      }
      const dispatchedPrompt = contextLines.length > 0
        ? `${promptWithCoda}\n\n${contextLines.join('\n')}`
        : promptWithCoda

      let result: TurnSummary
      try {
        const handle = await deps.manager.acquire({
          alias: proj.alias,
          path: proj.path,
          providerId: speaker,
          chatId: msg.chatId,
          tierProfile,
          permissionMode: deps.permissionMode,
        })
        // PR C2 — propagate the chatroom aborter into the speaker turn so
        // /stop (and "new dispatch preempts prior") interrupt mid-stream
        // rather than waiting for the current speaker turn to drain.
        // Best effort — providers without cancel() still get aborted at
        // the next round-entry check at the top of the loop.
        const onAbort = () => { void handle.cancel?.() }
        aborter.signal.addEventListener('abort', onAbort, { once: true })
        // WHATWG: addEventListener on an already-aborted signal does NOT
        // retroactively fire the handler. If abort landed between the
        // `await acquire` above and this line, we'd skip the mid-stream
        // cancel and the speaker turn would run to natural completion.
        // Fire onAbort manually in that case.
        if (aborter.signal.aborted) onAbort()
        try {
          result = await collectTurn(handle.dispatch(dispatchedPrompt), { timeoutMs: deps.turnTimeoutMs })
        } finally {
          aborter.signal.removeEventListener('abort', onAbort)
        }
      } catch (err) {
        // If we cancelled this turn ourselves, that's a clean exit — the
        // user already saw the abort notice and any "[Display] (error)"
        // we'd send would be noise.
        if (aborter.signal.aborted) {
          deps.log('COORDINATOR_CHATROOM', `speaker=${speaker} round=${round} aborted mid-stream — suppressing error reply`)
          break
        }
        const reason = err instanceof Error ? err.message : String(err)
        deps.log('COORDINATOR_CHATROOM', `speaker=${speaker} round=${round} threw: ${reason}`)
        const dn = deps.registry.get(speaker)?.opts.displayName ?? speaker
        await deps.sendAssistantText?.(msg.chatId, `[${dn}] (chatroom error: ${reason})`)
        break
      }

      // Auth-fail self-heal — same shape as solo/parallel. Releasing the
      // speaker's session means a follow-up /chat dispatch starts from a
      // fresh subprocess. Ending the loop here is the safe call: the user
      // already got the neutral notice from handleAuthFailed and the
      // moderator's next pick is unreliable while credentials are stale.
      if (result.errorCode === 'auth_failed') {
        await handleAuthFailed(msg.chatId, proj.alias, speaker, result)
        break
      }

      // Watchdog fired: the speaker stalled silently. Release its session and
      // end the loop — the moderator's next pick is unreliable while a speaker
      // is wedged, same call we make on auth_failed.
      if (result.errorCode === TURN_TIMEOUT_CODE) {
        await handleTurnTimeout(msg.chatId, proj.alias, speaker, result)
        break
      }

      // If the speaker called the reply tool despite chatroom mode, the
      // text already went out via internal-api with the [Display] prefix.
      // Skip our own forwarding (would double-send) but still record
      // their output in history so the next moderator round sees it.
      if (result.replyToolCalled) {
        deps.log('COORDINATOR_CHATROOM', `speaker=${speaker} round=${round} replyToolCalled — skipping our forward`)
        history.push({ role: 'speaker', speaker, text: result.assistantText.join('\n').trim() || '(reply tool used)' })
        continue
      }

      const allText = result.assistantText.join('\n').trim()
      if (allText.length === 0) {
        deps.log('COORDINATOR_CHATROOM', `speaker=${speaker} round=${round} produced no assistant text — ending`)
        break
      }
      const dn = deps.registry.get(speaker)?.opts.displayName ?? speaker
      // Final-round visual marker: leading 🎯 if the speaker didn't add
      // it themselves (the moderator's prompt asks them to). Single emoji
      // signals "this turn is the synthesis / takeaway" without the heavy
      // "[· 终局]" framing the user found dramatic.
      const renderedText = isFinalRound && !allText.startsWith('🎯')
        ? `🎯 ${allText}`
        : allText
      await deps.sendAssistantText?.(msg.chatId, `[${dn}] ${renderedText}`)
      history.push({ role: 'speaker', speaker, text: allText })
    }

    // PR C1 — if the loop ended before any speaker turn responded to this
    // dispatch's user msg (early abort, auth_failed at round 1, speaker
    // threw, etc.), drop the orphaned user entry so the next dispatch
    // doesn't show the moderator a history that ends in two consecutive
    // user entries.
    const last = history[history.length - 1]
    if (last && last.role === 'user') {
      history.pop()
      deps.log('COORDINATOR_CHATROOM', `chat=${msg.chatId} → dropped orphan user entry (no speaker turn produced)`)
    }

    // Persist the (possibly extended) chatroom history back to the map.
    chatroomHistories.set(msg.chatId, history)
    deps.log('COORDINATOR', `chatroom chat=${msg.chatId} → done; history=${history.length}`)
    } finally {
      if (inFlightAborters.get(msg.chatId) === aborter) {
        inFlightAborters.delete(msg.chatId)
      }
      if (inFlightDispatchPromises.get(msg.chatId) === dispatchPromise) {
        inFlightDispatchPromises.delete(msg.chatId)
      }
      dispatchResolve()
    }
  }

  /**
   * RFC 03 §4.3 parallel mode: fan out the same inbound to every
   * registered parallel provider concurrently. Both handles dispatch
   * independently; if one throws the other's reply still goes through
   * (Promise.allSettled). When a provider DID call its reply tool the
   * prefix is added at the internal-api layer (using participant_tag).
   * When a provider DIDN'T call reply but emitted assistant text, the
   * fallback path here adds the prefix in front of each chunk.
   */
  async function dispatchParallel(
    msg: InboundMsg,
    proj: { alias: string; path: string },
    participants: ProviderId[],
  ): Promise<void> {
    const tier = resolveEffectiveTier(msg.chatId, deps.loadAccess(), deps.permissionMode)
    const tierProfile = TIER_PROFILES[tier]
    deps.log('COORDINATOR', `parallel chat=${msg.chatId} → project=${proj.alias} providers=${participants.join(',')} tier=${tier}`)
    const handles = await Promise.all(
      participants.map(p => deps.manager.acquire({
        alias: proj.alias,
        path: proj.path,
        providerId: p,
        chatId: msg.chatId,
        tierProfile,
        permissionMode: deps.permissionMode,
      })),
    )
    const text = deps.format(msg)
    const settled = await Promise.allSettled(handles.map(h => collectTurn(h.dispatch(text), { timeoutMs: deps.turnTimeoutMs })))

    for (let i = 0; i < settled.length; i++) {
      const r = settled[i]!
      const providerId = participants[i]!
      if (r.status === 'rejected') {
        deps.log('COORDINATOR_PARALLEL', `provider=${providerId} threw: ${r.reason instanceof Error ? r.reason.message : r.reason}`)
        continue
      }
      // Watchdog fired for this participant — release its wedged session and
      // notify; the other provider's reply (handled below) still goes out.
      if (r.value.errorCode === TURN_TIMEOUT_CODE) {
        await handleTurnTimeout(msg.chatId, proj.alias, providerId, r.value)
        continue
      }
      // Same self-heal as solo: the failing provider's session is released
      // so the next /both dispatch spawns a fresh subprocess. handleAuthFailed
      // also fires (one throttled neutral notice across both providers per
      // chat per hour). The other provider's reply (if any) still goes
      // through below — partial reply is better than no reply.
      if (r.value.errorCode === 'auth_failed') {
        await handleAuthFailed(msg.chatId, proj.alias, providerId, r.value)
        continue
      }
      const { assistantText, replyToolCalled } = r.value
      if (replyToolCalled || assistantText.length === 0) continue
      // Provider didn't call reply tool — fall back to forwarding raw
      // assistant text, prefixed so the user can tell who said what.
      const dn = deps.registry.get(providerId)?.opts.displayName ?? providerId
      deps.log('FALLBACK_REPLY', `chat=${msg.chatId} provider=${providerId} chunks=${assistantText.length} (parallel)`)
      for (const t of assistantText) {
        await deps.sendAssistantText?.(msg.chatId, `[${dn}] ${t}`)
      }
    }
  }

  return {
    getMode,
    setMode(chatId, mode) {
      validateMode(mode)
      const oldMode = getMode(chatId)
      deps.conversationStore.set(chatId, mode)
      // v0.5.9 — clear chatroom history when leaving chatroom mode.
      // Switching back later starts a fresh chatroom session, matching
      // the "left the room, came back" mental model. Cross-chat session
      // release is left to LRU / idle eviction because the
      // (alias, providerId) key is shared across chats; per-chat release
      // would interfere.
      if (oldMode.kind === 'chatroom' && mode.kind !== 'chatroom') {
        chatroomHistories.delete(chatId)
      }
    },
    cancel(chatId) {
      const ac = inFlightAborters.get(chatId)
      if (!ac) return false
      ac.abort()
      // delete is done in dispatchChatroom's finally; double-delete is harmless.
      return true
    },
    async dispatch(msg) {
      const proj = deps.resolveProject(msg.chatId)
      if (!proj) {
        deps.log('COORDINATOR', `drop: no project for chat=${msg.chatId}`)
        return
      }
      const mode = getMode(msg.chatId)

      // For parallel/chatroom, resolve the active participant set once.
      // Then degrade-to-solo if the set is ≤1 (no point fanning out to 0
      // or N=1) and use the resolved set for the capability-matrix check.
      let participants: ProviderId[] | null = null
      if (mode.kind === 'parallel' || mode.kind === 'chatroom') {
        participants = resolveParticipants(mode, msg.chatId)
        if (participants.length === 0) {
          deps.log('COORDINATOR', `chat=${msg.chatId} ${mode.kind} resolved to empty participants; falling back to solo+${deps.defaultProviderId}`)
          return dispatchSolo(msg, proj, deps.defaultProviderId)
        }
        if (participants.length === 1) {
          deps.log('COORDINATOR', `chat=${msg.chatId} ${mode.kind} resolved to single participant ${participants[0]}; degrading to solo`)
          return dispatchSolo(msg, proj, participants[0]!)
        }
      }

      // Capability-matrix guard: reject forbidden (mode × provider × permissionMode)
      // combinations before any session is acquired. All current rows have
      // forbidden=false so this is a forward-looking safety net — it will fire
      // when a row is explicitly marked forbidden in a future policy tightening.
      // Unknown providers (not in the matrix) are silently passed through —
      // the coordinator's own fallback logic handles unregistered providers.
      const providersInUse: ProviderId[] =
        mode.kind === 'solo' ? [mode.provider] :
        mode.kind === 'primary_tool' ? [mode.primary] :
        participants!  // parallel/chatroom — never null here due to early-return above
      for (const p of providersInUse) {
        try {
          assertSupported(mode.kind, p, deps.permissionMode)
        } catch (err) {
          // Re-throw only explicit policy violations (forbidden=true rows).
          // Let unknown-provider errors pass — they're handled downstream
          // by the mode-specific fallback paths in the switch below.
          if (err instanceof UnsupportedCombinationError) throw err
        }
      }

      switch (mode.kind) {
        case 'solo': {
          if (!deps.registry.has(mode.provider)) {
            // Persisted mode references a provider that's no longer
            // registered (e.g. user removed agent). Fall back to default
            // and log loudly so we notice.
            deps.log('COORDINATOR', `chat=${msg.chatId} persisted provider '${mode.provider}' not registered; falling back to ${deps.defaultProviderId}`)
            return dispatchSolo(msg, proj, deps.defaultProviderId)
          }
          return dispatchSolo(msg, proj, mode.provider)
        }
        case 'parallel': {
          return dispatchParallel(msg, proj, participants!)
        }
        case 'primary_tool': {
          // RFC 03 P4 — dispatch to the primary; the peer is reachable
          // via the delegate-mcp tool that's already loaded in the
          // primary's session config. Behaviourally identical to
          // solo+primary at the dispatch layer; the difference is the
          // user's framing (they signalled they want the other AI as
          // a tool) and how the agent uses delegate_<peer>.
          if (!deps.registry.has(mode.primary)) {
            deps.log('COORDINATOR', `chat=${msg.chatId} primary_tool primary '${mode.primary}' not registered; falling back to solo+${deps.defaultProviderId}`)
            return dispatchSolo(msg, proj, deps.defaultProviderId)
          }
          return dispatchSolo(msg, proj, mode.primary)
        }
        case 'chatroom': {
          return dispatchChatroom(msg, proj, participants!)
        }
      }
    },
  }
}
