/**
 * Introspect agent factory.
 *
 * v0.4.1 — real SDK integration. The factory is deps-injected: tests pass a
 * mock `sdkEval`; production wires `query()` from @anthropic-ai/claude-agent-sdk
 * via main.ts. The agent itself stays small — pull context out of the stores,
 * build the prompt, call sdkEval, parse the response. Errors and parse
 * failures degrade to `{ write: false, reasoning: 'SDK error: ...' | 'parse failed; ...' }`
 * so the cron loop can still write a `cron_eval_skipped` event and the
 * dashboard sees a row.
 *
 * Exposes:
 *   - makeIntrospectAgent(deps): IntrospectAgent — production factory.
 *   - resolveIntrospectChatId(stateDir): string | null — returns the chat
 *     id whose introspect tick should fire (default chat id from
 *     companion config; null if none configured).
 */
import type { IntrospectAgent } from './introspect'
import { loadCompanionConfig } from './config'
import { buildIntrospectPrompt, parseIntrospectResponse } from './introspect-prompt'
import type { EventsStore } from '../events/store'
import type { ObservationsStore } from '../observations/store'

export interface IntrospectAgentDeps {
  chatId: string
  events: EventsStore
  observations: ObservationsStore
  memorySnapshot: () => Promise<string>
  recentInboundMessages: () => Promise<string[]>
  sdkEval: (prompt: string) => Promise<string>
}

export function makeIntrospectAgent(deps: IntrospectAgentDeps): IntrospectAgent {
  return {
    async runIntrospect() {
      try {
        const memory = await deps.memorySnapshot()
        const observations = (await deps.observations.listActive())
          .slice(-5)
          .map(o => ({ ts: o.ts, body: o.body }))
        const events = (await deps.events.list({ limit: 20 }))
          .map(e => ({ ts: e.ts, kind: e.kind, reasoning: e.reasoning }))
        const messages = await deps.recentInboundMessages()

        const prompt = buildIntrospectPrompt({
          chatId: deps.chatId,
          memorySnapshot: memory,
          recentObservations: observations,
          recentEvents: events,
          recentInboundMessages: messages,
        })

        const raw = await deps.sdkEval(prompt)
        const decision = parseIntrospectResponse(raw)
        if (!decision) {
          return { write: false, reasoning: `parse failed; raw[:120]=${raw.slice(0, 120)}` }
        }
        return decision
      } catch (err) {
        return { write: false, reasoning: `SDK error: ${err instanceof Error ? err.message : String(err)}` }
      }
    },
  }
}

export function resolveIntrospectChatId(stateDir: string): string | null {
  const cfg = loadCompanionConfig(stateDir)
  return cfg.default_chat_id ?? null
}
