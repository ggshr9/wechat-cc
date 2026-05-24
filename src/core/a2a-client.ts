/**
 * A2A client — outbound HTTP calls to registered external A2A agents.
 *
 * Two operations:
 *   1. fetchAgentCard(baseUrl) → GET /.well-known/agent.json
 *      Used at install time to validate operator's input URL and let
 *      them see what the agent claims to expose.
 *   2. send({ url, bearer, body }) → POST any endpoint with Bearer auth
 *      Used by the a2a_send MCP tool to push messages out.
 *
 * Pure HTTP. No app logic, no registry awareness, no MCP knowledge.
 * Timeout-bounded (default 10s; configurable for tests).
 *
 * See docs/superpowers/specs/2026-05-24-a2a-integration-design.md.
 */

export interface AgentCard {
  name: string
  description?: string
  version?: string
  auth?: { type: string; required: boolean }
  capabilities?: Array<{
    name: string
    description?: string
    endpoint?: string
    method?: string
    request_schema?: unknown
  }>
}

export interface SendRequest {
  url: string
  bearer: string
  body: unknown
}

export interface SendResult {
  ok: boolean
  http_status?: number
  response?: unknown
  error?: string
}

export interface A2AClientOpts {
  timeoutMs?: number
}

export interface A2AClient {
  fetchAgentCard(baseUrl: string): Promise<AgentCard>
  send(req: SendRequest): Promise<SendResult>
}

export function createA2AClient(opts: A2AClientOpts = {}): A2AClient {
  const timeoutMs = opts.timeoutMs ?? 10_000

  async function withTimeout<T>(p: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const ac = new AbortController()
    const t = setTimeout(() => ac.abort(new Error('timeout')), timeoutMs)
    try { return await p(ac.signal) }
    finally { clearTimeout(t) }
  }

  return {
    async fetchAgentCard(baseUrl) {
      // Try /.well-known/agent.json first; fall back to baseUrl itself if it
      // already ends in agent.json (operator may have pasted the full path).
      const cardUrl = baseUrl.endsWith('agent.json')
        ? baseUrl
        : `${baseUrl.replace(/\/+$/, '')}/.well-known/agent.json`
      return withTimeout(async (signal) => {
        const res = await fetch(cardUrl, { signal })
        if (!res.ok) throw new Error(`fetchAgentCard ${cardUrl} → ${res.status}`)
        const body = await res.json() as AgentCard
        if (!body.name) throw new Error(`fetchAgentCard ${cardUrl} → missing 'name'`)
        return body
      })
    },

    async send({ url, bearer, body }) {
      try {
        return await withTimeout(async (signal) => {
          const res = await fetch(url, {
            method: 'POST',
            signal,
            headers: {
              'authorization': `Bearer ${bearer}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify(body),
          })
          let response: unknown = undefined
          const text = await res.text()
          if (text) {
            try { response = JSON.parse(text) }
            catch { response = text }
          }
          if (!res.ok) {
            return { ok: false, http_status: res.status, response, error: `http_${res.status}` }
          }
          return { ok: true, http_status: res.status, response }
        })
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
  }
}
