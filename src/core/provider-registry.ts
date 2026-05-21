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
import type { AgentProvider, CheapEval } from './agent-provider'
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
  /**
   * Resolve a cheapEval callback from registered providers, picked by
   * cost-tier preference (cheapest first). Returns null if no registered
   * provider implements cheapEval. Caller is provider-agnostic — let
   * the registry decide which provider runs the one-shot eval.
   *
   * Preference order is hardcoded inside the resolver because cost
   * comparison is fundamentally cross-provider (we can't compare
   * Anthropic's haiku to OpenAI's mini purely from interface metadata).
   */
  getCheapEval(): CheapEval | null
}

// Cheapest known to most expensive. Claude haiku ≈ $0.001/1K input tokens
// and ~1s latency via in-process SDK; Codex mini ≈ $0.002/1K and ~3-5s
// per call (CLI subprocess overhead). Future providers append here.
const CHEAP_EVAL_PREFERENCE: ProviderId[] = ['claude', 'codex']

export function createProviderRegistry(): ProviderRegistry {
  const entries = new Map<ProviderId, { provider: AgentProvider; opts: ProviderRegistration }>()
  const registry: ProviderRegistry = {
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
    getCheapEval() {
      // Preferred providers first
      for (const id of CHEAP_EVAL_PREFERENCE) {
        const entry = entries.get(id)
        const ce = entry?.provider.cheapEval
        if (ce) return ce.bind(entry.provider)
      }
      // Any other registered provider — order doesn't strictly matter,
      // we just need SOMETHING that works.
      for (const [id, entry] of entries) {
        if (CHEAP_EVAL_PREFERENCE.includes(id)) continue
        if (entry.provider.cheapEval) return entry.provider.cheapEval.bind(entry.provider)
      }
      return null
    },
  }
  return registry
}
