/**
 * Introspect agent factory.
 *
 * v0.4 ships a STUB that always returns `{ write: false, reasoning: ... }`.
 * This exercises the full scheduler → stores → events.jsonl path so the
 * dashboard's "Claude 的最近决策" folded section can render real rows even
 * before the real SDK integration lands. Real SDK integration is tracked
 * for v0.4.1 — see plan doc.
 *
 * Exposes:
 *   - makeIntrospectAgent(deps): IntrospectAgent — production factory; for
 *     v0.4 is just a stub.
 *   - resolveIntrospectChatId(stateDir): string | null — returns the chat
 *     id whose introspect tick should fire (default chat id from
 *     companion config; null if none configured).
 */
import type { IntrospectAgent } from './introspect'
import { loadCompanionConfig } from './config'

export function makeIntrospectAgent(): IntrospectAgent {
  return {
    async runIntrospect() {
      return {
        write: false,
        reasoning: 'introspect agent not yet wired (v0.4.1 follow-up)',
      }
    },
  }
}

export function resolveIntrospectChatId(stateDir: string): string | null {
  const cfg = loadCompanionConfig(stateDir)
  return cfg.default_chat_id ?? null
}
