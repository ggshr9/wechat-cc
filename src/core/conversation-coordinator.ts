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
 * P2 implements `solo` only. The other Mode variants (parallel /
 * primary_tool / chatroom) parse and persist correctly via the store
 * but throw NotImplementedError on dispatch — to be filled in P3-P5.
 */
import type { SessionManager } from './session-manager'
import type { ConversationStore } from './conversation-store'
import type { ProviderRegistry } from './provider-registry'
import type { Mode, ProviderId } from './conversation'
import type { InboundMsg } from './prompt-format'
import { parseAddressing, wrapChatroomTurn, maxRoundsSuffix } from './chatroom-protocol'
import { assertSupported, UnsupportedCombinationError, type PermissionMode } from './capability-matrix'

export class ModeNotImplementedError extends Error {
  constructor(public readonly modeKind: Mode['kind']) {
    super(`mode '${modeKind}' is not yet implemented in this version of wechat-cc`)
    this.name = 'ModeNotImplementedError'
  }
}

export interface ConversationCoordinatorDeps {
  resolveProject(chatId: string): { alias: string; path: string } | null
  manager: Pick<SessionManager, 'acquire'>
  conversationStore: Pick<ConversationStore, 'get' | 'set'>
  registry: Pick<ProviderRegistry, 'has' | 'list' | 'get'>
  /**
   * Default provider id for chats with no explicit Mode set. Mirrors
   * the daemon's agent-config.provider — i.e. on a fresh install
   * everything answers under whichever provider the user picked at
   * setup time, until they say `/cc` or `/codex` to override per-chat.
   */
  defaultProviderId: ProviderId
  /**
   * Provider ids to fan-out to in `parallel` mode (RFC 03 P3). Defaults
   * to `['claude', 'codex']` — the two shipped providers. P3 mode is
   * implicit-2-way; if either id isn't registered the parallel-mode
   * setMode validation rejects up front. Also reused as the chatroom
   * participant set in P5.
   */
  parallelProviders?: ProviderId[]
  /**
   * Maximum inter-agent rounds for chatroom mode (RFC 03 §4.4). Default 4.
   * Counts each speaker turn after the initial user turn. When hit, the
   * loop forces termination and any remaining text gets the
   * maxRoundsSuffix appended for the user.
   */
  chatroomMaxRounds?: number
  /**
   * Permission mode — 'strict' (default, per-tool relay) or 'dangerously'
   * (bypass all permission prompts). Computed once at bootstrap from
   * `dangerouslySkipPermissions`. Threaded into assertSupported() at
   * dispatch entry and used by capability-matrix to gate combinations.
   */
  permissionMode: PermissionMode
  format: (msg: InboundMsg) => string
  sendAssistantText?: (chatId: string, text: string) => Promise<void>
  /**
   * Optional `fields` arg lands in the JSONL sidecar (channel.log.jsonl)
   * for programmatic consumers. Stubs that don't care can ignore it
   * (third arg is optional in the daemon's real `log` impl too).
   */
  log: (tag: string, line: string, fields?: Record<string, unknown>) => void
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
  // Per-chat in-memory state for chatroom: who spoke last, used as the
  // initial speaker for the next round. Volatile across daemon restart
  // (small cost: first chatroom turn after restart goes to default).
  // Cleared by setMode when the chat leaves chatroom mode (RFC 03 review #3).
  const lastChatroomSpeaker = new Map<string, ProviderId>()
  // RFC 03 review #11 — per-chat AbortController for in-flight chatroom
  // loops. dispatchChatroom registers; coordinator.cancel() signals; /stop
  // in mode-commands triggers cancel before flipping mode.
  const inFlightAborters = new Map<string, AbortController>()

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
      // Both modes need every parallel-set provider registered.
      const missing = parallelProviders.filter(p => !deps.registry.has(p))
      if (missing.length > 0) {
        throw new Error(`mode '${mode.kind}' requires providers ${parallelProviders.join(', ')}; missing: ${missing.join(', ')}`)
      }
    }
  }

  async function dispatchSolo(
    msg: InboundMsg,
    proj: { alias: string; path: string },
    providerId: ProviderId,
  ): Promise<void> {
    deps.log('COORDINATOR', `solo chat=${msg.chatId} → project=${proj.alias} provider=${providerId}`, {
      event: 'dispatch_solo',
      chat_id: msg.chatId,
      project_alias: proj.alias,
      provider: providerId,
    })
    const handle = await deps.manager.acquire(proj.alias, proj.path, providerId)
    const text = deps.format(msg)
    const result = await handle.dispatch(text)
    const assistantTexts = result.assistantText
    const replyToolCalled = result.replyToolCalled

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
  }

  /**
   * RFC 03 §4.4 chatroom mode: two agents take turns; routing is by
   * @-tag in their assistant text. Loop terminates naturally when no
   * one @'s the peer (pending queue empties) or hits MAX_ROUNDS.
   *
   * Sequence per turn:
   *   1. Pop the next pending {from, text}.
   *   2. Wrap with chatroom envelope (round counter + protocol reminder).
   *   3. Dispatch to the speaker's session. SDK conversation history
   *      accumulates as usual — fine because the envelope makes each
   *      turn's role clear.
   *   4. Parse assistantText for @-tag segments:
   *        - addressee=null or 'user' → forward to user (prefixed)
   *        - addressee=peer → enqueue for peer's next turn
   *        - addressee=anything else → treat as user (unknown peer
   *          shouldn't silently disappear)
   *   5. If reply tool was called (agent ignored the "don't use reply"
   *      hint), text already went out via internal-api. We still parse
   *      assistantText for routing (separate channel).
   *   6. Switch speaker, increment rounds, repeat.
   *
   * Speaker rotation: starts with last-addressed (from previous turn or
   * previous chat session); falls back to parallelProviders[0]. Updated
   * each round to the current peer (i.e. flip-flop between the two).
   */
  async function dispatchChatroom(
    msg: InboundMsg,
    proj: { alias: string; path: string },
  ): Promise<void> {
    if (parallelProviders.length !== 2) {
      throw new Error(`chatroom mode requires exactly 2 parallel providers; got ${parallelProviders.length}`)
    }
    const [providerA, providerB] = parallelProviders as [ProviderId, ProviderId]
    const peerOf = (p: ProviderId): ProviderId => p === providerA ? providerB : providerA

    // Pick first speaker: last-spoke for this chat (from a previous
    // chatroom session) or default to providerA.
    let speaker = lastChatroomSpeaker.get(msg.chatId) ?? providerA
    let peer = peerOf(speaker)

    interface PendingTurn { from: 'user' | ProviderId; text: string }
    const pending: PendingTurn[] = [{ from: 'user', text: deps.format(msg) }]
    let round = 0

    // RFC 03 review #11 — per-chat AbortController so /stop can preempt
    // an in-flight loop. Concurrent dispatches for the same chat will
    // overwrite the slot — only the latest is cancellable. The
    // overwritten controller's owner runs to completion (acceptable;
    // dispatch promises serialise via main.ts await chain anyway).
    const aborter = new AbortController()
    inFlightAborters.set(msg.chatId, aborter)

    deps.log('COORDINATOR', `chatroom chat=${msg.chatId} → start speaker=${speaker} peer=${peer} max=${chatroomMaxRounds}`)

    try {
    while (pending.length > 0) {
      // Check abort BEFORE starting a turn. Mid-turn abort is not
      // supported (we'd have to wire AbortSignal through to AgentSession
      // which neither SDK uniformly accepts). Per-turn check is the
      // pragmatic granularity — at most one extra LLM call after /stop.
      if (aborter.signal.aborted) {
        deps.log('COORDINATOR_CHATROOM', `chat=${msg.chatId} aborted at round ${round} (pending=${pending.length})`)
        await deps.sendAssistantText?.(msg.chatId, '⏸ chatroom 已收到 /stop，提前终止本轮（已派出的 turn 无法撤回）。')
        break
      }
      round += 1
      const forced = round >= chatroomMaxRounds
      const turn = pending.shift()!
      const wrapped = wrapChatroomTurn({
        speaker, peer, round, maxRounds: chatroomMaxRounds,
        sender: turn.from,
        inner: turn.text,
      })

      let result: { assistantText: string[]; replyToolCalled: boolean }
      try {
        const handle = await deps.manager.acquire(proj.alias, proj.path, speaker)
        result = await handle.dispatch(wrapped)
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        deps.log('COORDINATOR_CHATROOM', `speaker=${speaker} round=${round} threw: ${reason}`)
        // Surface to user so they know something went wrong, then end loop.
        const dn = deps.registry.get(speaker)?.opts.displayName ?? speaker
        await deps.sendAssistantText?.(msg.chatId, `[${dn}] (chatroom error: ${reason})`)
        break
      }

      // Track last-spoke for next chat session's initial speaker.
      lastChatroomSpeaker.set(msg.chatId, speaker)

      // RFC 03 P5 review #1 — if the agent disregarded the "don't use
      // reply tool in chatroom" hint and called reply anyway, the text
      // already went to user via internal-api (with [Display] prefix
      // from maybePrefix). To avoid sending the SAME text TWICE, skip
      // assistantText parsing/forwarding entirely — accept that this
      // turn produced no peer-routable output. Loop terminates if no
      // pending. (Mirrors the parallel-mode `if (replyToolCalled) continue`
      // guard at the parallel-dispatch path.)
      if (result.replyToolCalled) {
        deps.log('COORDINATOR_CHATROOM', `speaker=${speaker} round=${round} replyToolCalled=true; skipping assistantText routing (would double-send to user)`)
        if (forced) {
          const dropped = pending.length
          pending.length = 0
          deps.log('COORDINATOR_CHATROOM', `chat=${msg.chatId} max_rounds reached on round ${round}${dropped > 0 ? `; dropped ${dropped} queued relay(s)` : ''}`)
        }
        if (pending.length > 0) {
          speaker = peer
          peer = peerOf(speaker)
        }
        continue
      }

      const allText = result.assistantText.join('\n').trim()
      const segments = allText.length > 0 ? parseAddressing(allText) : []

      const dn = deps.registry.get(speaker)?.opts.displayName ?? speaker
      for (const seg of segments) {
        const target = seg.addressee
        if (target === peer) {
          // Inter-agent — enqueue for peer's next turn (unless we've
          // hit the round cap, in which case route to user instead so
          // the would-be relay isn't lost). Only the would-be-relay
          // segment gets the max_rounds suffix; co-emitted @user
          // segments below stay clean (they're naturally user-facing).
          if (forced) {
            await deps.sendAssistantText?.(msg.chatId, `[${dn}] @${peer} ${seg.body}${maxRoundsSuffix()}`)
          } else {
            pending.push({ from: speaker, text: `@${peer} ${seg.body}` })
          }
        } else {
          // user-facing (null, 'user', or unknown peer treated as user) — no suffix.
          await deps.sendAssistantText?.(msg.chatId, `[${dn}] ${seg.body}`)
        }
      }

      // If the speaker emitted nothing, log once and move on. The peer
      // gets nothing to react to → loop will terminate next iteration.
      if (segments.length === 0) {
        deps.log('COORDINATOR_CHATROOM', `speaker=${speaker} round=${round} produced no assistant text (replyToolCalled=${result.replyToolCalled})`)
      }

      if (forced) {
        // Cap reached: drop any queued relays (defensive — we shouldn't
        // have enqueued any since the for-loop above routes to user when
        // forced) and log so it's grep-able from channel.log.
        const dropped = pending.length
        pending.length = 0
        deps.log('COORDINATOR_CHATROOM', `chat=${msg.chatId} max_rounds reached on round ${round}${dropped > 0 ? `; dropped ${dropped} queued relay(s)` : ''}`)
      }

      // Flip speaker for next iteration (only if we have more pending).
      if (pending.length > 0) {
        speaker = peer
        peer = peerOf(speaker)
      }
    }

    deps.log('COORDINATOR', `chatroom chat=${msg.chatId} → done after ${round} round(s)`)
    } finally {
      // Clean up our slot — but only if it's still us. A concurrent
      // dispatch on the same chat could have replaced it; don't stomp.
      if (inFlightAborters.get(msg.chatId) === aborter) {
        inFlightAborters.delete(msg.chatId)
      }
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
  ): Promise<void> {
    deps.log('COORDINATOR', `parallel chat=${msg.chatId} → project=${proj.alias} providers=${parallelProviders.join(',')}`)
    const handles = await Promise.all(
      parallelProviders.map(p => deps.manager.acquire(proj.alias, proj.path, p)),
    )
    const text = deps.format(msg)
    const settled = await Promise.allSettled(handles.map(h => h.dispatch(text)))

    for (let i = 0; i < settled.length; i++) {
      const r = settled[i]!
      const providerId = parallelProviders[i]!
      if (r.status === 'rejected') {
        deps.log('COORDINATOR_PARALLEL', `provider=${providerId} threw: ${r.reason instanceof Error ? r.reason.message : r.reason}`)
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
      // RFC 03 review #3 (partial) — clear chatroom-specific per-chat
      // memory when leaving chatroom. Cross-chat session release is left
      // to LRU / idle eviction because the (alias, providerId) key is
      // shared across chats; per-chat release would interfere.
      if (oldMode.kind === 'chatroom' && mode.kind !== 'chatroom') {
        lastChatroomSpeaker.delete(chatId)
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

      // Capability-matrix guard: reject forbidden (mode × provider × permissionMode)
      // combinations before any session is acquired. All current rows have
      // forbidden=false so this is a forward-looking safety net — it will fire
      // when a row is explicitly marked forbidden in a future policy tightening.
      // Unknown providers (not in the matrix) are silently passed through —
      // the coordinator's own fallback logic handles unregistered providers.
      const providersInUse: ProviderId[] =
        mode.kind === 'solo' ? [mode.provider] :
        mode.kind === 'primary_tool' ? [mode.primary] :
        parallelProviders
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
          const missing = parallelProviders.filter(p => !deps.registry.has(p))
          if (missing.length > 0) {
            // One of the parallel providers vanished post-persist.
            // Degrade to solo+default rather than partial-parallel, which
            // would silently change semantics ("both" → "one").
            deps.log('COORDINATOR', `chat=${msg.chatId} parallel mode missing providers (${missing.join(', ')}); falling back to solo+${deps.defaultProviderId}`)
            return dispatchSolo(msg, proj, deps.defaultProviderId)
          }
          return dispatchParallel(msg, proj)
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
          // RFC 03 P5 — two agents take turns via @-tag routing.
          const missing = parallelProviders.filter(p => !deps.registry.has(p))
          if (missing.length > 0) {
            deps.log('COORDINATOR', `chat=${msg.chatId} chatroom mode missing providers (${missing.join(', ')}); falling back to solo+${deps.defaultProviderId}`)
            return dispatchSolo(msg, proj, deps.defaultProviderId)
          }
          return dispatchChatroom(msg, proj)
        }
      }
    },
  }
}
