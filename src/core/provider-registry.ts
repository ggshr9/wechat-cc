/**
 * provider-registry — central catalogue of available agent providers
 * (RFC 03 §3.3, Appendix D).
 *
 * Daemon registers `claude` and `codex` at boot; coordinator looks up
 * by ProviderId when dispatching. Adding a new provider in the future
 * is a single `registry.register(id, provider, opts)` call from
 * bootstrap.ts — no changes to Conversation/Mode/Coordinator/SessionManager
 * (the open string ProviderId design from §3.3 makes this work).
 *
 * The registry is intentionally not a singleton; it's constructed and
 * passed via deps. Tests can build their own with mock providers.
 */
import type { AgentProvider } from './agent-provider'
import type { ProviderId } from './conversation'

export interface ProviderRegistration {
  /** Human-readable name; used by mode-commands prompts and dashboard. */
  displayName: string
  /**
   * Returns true if a stored thread/session id can still be resumed
   * (i.e. the provider's on-disk transcript is intact). SessionManager
   * checks this before passing a stale resume id to the SDK.
   */
  canResume: (cwd: string, threadId: string) => boolean
}

export interface ProviderRegistry {
  register(id: ProviderId, provider: AgentProvider, opts: ProviderRegistration): void
  get(id: ProviderId): { provider: AgentProvider; opts: ProviderRegistration } | null
  has(id: ProviderId): boolean
  list(): ProviderId[]
}

export function createProviderRegistry(): ProviderRegistry {
  const entries = new Map<ProviderId, { provider: AgentProvider; opts: ProviderRegistration }>()
  return {
    register(id, provider, opts) {
      if (entries.has(id)) throw new Error(`provider already registered: ${id}`)
      entries.set(id, { provider, opts })
    },
    get(id) {
      return entries.get(id) ?? null
    },
    has(id) {
      return entries.has(id)
    },
    list() {
      return Array.from(entries.keys())
    },
  }
}
