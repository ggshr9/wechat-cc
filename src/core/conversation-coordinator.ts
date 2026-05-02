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
   * setMode validation rejects up front.
   */
  parallelProviders?: ProviderId[]
  format: (msg: InboundMsg) => string
  sendAssistantText?: (chatId: string, text: string) => Promise<void>
  log: (tag: string, line: string) => void
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
   * the mode is actually registered.
   */
  setMode(chatId: string, mode: Mode): void
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
    deps.log('COORDINATOR', `solo chat=${msg.chatId} → project=${proj.alias} provider=${providerId}`)
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
      deps.conversationStore.set(chatId, mode)
    },
    async dispatch(msg) {
      const proj = deps.resolveProject(msg.chatId)
      if (!proj) {
        deps.log('COORDINATOR', `drop: no project for chat=${msg.chatId}`)
        return
      }
      const mode = getMode(msg.chatId)

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
        case 'primary_tool':
        case 'chatroom':
          throw new ModeNotImplementedError(mode.kind)
      }
    },
  }
}
