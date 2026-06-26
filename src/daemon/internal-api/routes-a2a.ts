/**
 * internal-api a2a routes — outbound send + dashboard CRUD (list/preview/
 * install/remove/pause/activity/info) + the server-side smoke test. Split out
 * of routes.ts (which was a 780-line god file); makeRoutes spreads this in.
 * Handlers close over `deps` only. Behavior verbatim from the original table.
 */
import { randomBytes } from 'node:crypto'
import { errMsg, type InternalApiDeps, type RouteTable } from './types'
import type {
  A2ASendRequestT,
  A2APreviewRequestT,
  A2AInstallRequestT,
  A2ARemoveRequestT,
  A2APauseRequestT,
} from './schema'

export function a2aRoutes(deps: InternalApiDeps): RouteTable {
  return {
    // ── a2a outbound send ────────────────────────────────────────────────────
    'POST /v1/a2a/send': async (_q, body) => {
      if (!deps.a2a) return { status: 503, body: { error: 'a2a_not_wired' } }
      // Body is pre-validated by index.ts via A2ASendRequest schema.
      const { agent_id, text } = body as A2ASendRequestT
      const agent = deps.a2a.registry.get(agent_id)
      if (!agent) {
        return { status: 200, body: {
          ok: false, error: 'unknown_agent',
          registered: deps.a2a.registry.list().map(a => a.id),
        } }
      }
      if (agent.paused) {
        deps.a2a.recordEvent({ direction: 'out', agent_id, text, status: 'agent_paused' })
        return { status: 200, body: { ok: false, error: 'agent_paused' } }
      }
      const r = await deps.a2a.client.send({
        url: agent.url,
        bearer: agent.outbound_api_key,
        body: { text, source: { agent_id: 'wechat-cc' } },
      })
      const status: 'ok' | 'http_error' | 'timeout' =
        r.ok ? 'ok'
          : (r.error?.match(/timeout|aborted/i) ? 'timeout' : 'http_error')
      deps.a2a.recordEvent({
        direction: 'out', agent_id, text, status,
        ...(r.http_status !== undefined ? { http_status: r.http_status } : {}),
      })
      return { status: 200, body: r.ok
        ? { ok: true, ...(r.http_status !== undefined ? { http_status: r.http_status } : {}), ...(r.response !== undefined ? { response: r.response } : {}) }
        : { ok: false, error: r.error ?? 'unknown_error', ...(r.http_status !== undefined ? { http_status: r.http_status } : {}) }
      }
    },

    // ── a2a server-side smoke test (dashboard Test button) ──────────────────
    // Outbound mode: same behavior as /v1/a2a/send (we already have the
    // logic; could refactor to share but the path is short enough to inline).
    // Inbound mode: daemon POSTs to its OWN /a2a/notify with the agent's
    // inbound_api_key — the key never crosses the internal-api boundary, so
    // dashboard clients can't extract it.
    'POST /v1/a2a/test': async (_q, body) => {
      if (!deps.a2a) return { status: 503, body: { error: 'a2a_not_wired' } }
      // Body is pre-validated via A2ATestRequest schema.
      const { agent_id, text, outbound } = body as { agent_id: string; text: string; outbound: boolean }
      const agent = deps.a2a.registry.get(agent_id)
      if (!agent) {
        return { status: 200, body: {
          ok: false, direction: outbound ? 'out' : 'in', error: 'unknown_agent',
        } }
      }
      if (outbound) {
        // Re-use the outbound path semantics from /v1/a2a/send.
        if (agent.paused) {
          deps.a2a.recordEvent({ direction: 'out', agent_id, text, status: 'agent_paused' })
          return { status: 200, body: { ok: false, direction: 'out', error: 'agent_paused' } }
        }
        const r = await deps.a2a.client.send({
          url: agent.url, bearer: agent.outbound_api_key,
          body: { text, source: { agent_id: 'wechat-cc' } },
        })
        const eventStatus: 'ok' | 'http_error' | 'timeout' =
          r.ok ? 'ok' : (r.error?.match(/timeout|aborted/i) ? 'timeout' : 'http_error')
        deps.a2a.recordEvent({
          direction: 'out', agent_id, text, status: eventStatus,
          ...(r.http_status !== undefined ? { http_status: r.http_status } : {}),
        })
        return { status: 200, body: r.ok
          ? { ok: true, direction: 'out',
              ...(r.http_status !== undefined ? { http_status: r.http_status } : {}),
              ...(r.response !== undefined ? { response: r.response } : {}) }
          : { ok: false, direction: 'out', error: r.error ?? 'unknown_error',
              ...(r.http_status !== undefined ? { http_status: r.http_status } : {}) }
        }
      }
      // Inbound: POST to our own server. Requires A2A server to be running.
      if (!deps.a2a.serverEnabled || !deps.a2a.baseUrl) {
        return { status: 200, body: {
          ok: false, direction: 'in', error: 'a2a_server_disabled',
        } }
      }
      try {
        const res = await fetch(`${deps.a2a.baseUrl}/a2a/notify`, {
          method: 'POST',
          headers: {
            'authorization': `Bearer ${agent.inbound_api_key}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ agent_id, text }),
        })
        const responseText = await res.text()
        let response: unknown = responseText
        try { response = JSON.parse(responseText) } catch { /* keep raw */ }
        return { status: 200, body: res.ok
          ? { ok: true, direction: 'in', http_status: res.status, response }
          : { ok: false, direction: 'in', error: `http_${res.status}`, http_status: res.status }
        }
      } catch (err) {
        return { status: 200, body: {
          ok: false, direction: 'in', error: errMsg(err),
        } }
      }
    },

    // ── a2a dashboard routes ─────────────────────────────────────────────────
    'GET /v1/a2a/list': () => {
      if (!deps.a2a) return { status: 503, body: { error: 'a2a_not_wired' } }
      const agents = deps.a2a.registry.list().map(a => ({
        id: a.id,
        name: a.name,
        url: a.url,
        paused: a.paused,
        counts: deps.a2a!.eventsStore.counts(a.id),
      }))
      return { status: 200, body: { agents } }
    },

    'POST /v1/a2a/preview': async (_q, body) => {
      if (!deps.a2a) return { status: 503, body: { error: 'a2a_not_wired' } }
      // Body is pre-validated via A2APreviewRequest schema.
      const { url } = body as A2APreviewRequestT
      try {
        const card = await deps.a2a.client.fetchAgentCard(url)
        return { status: 200, body: card }
      } catch (err) {
        return { status: 200, body: { error: errMsg(err) } }
      }
    },

    'POST /v1/a2a/install': (_q, body) => {
      if (!deps.a2a) return { status: 503, body: { error: 'a2a_not_wired' } }
      // Body is pre-validated via A2AInstallRequest schema.
      const { id, name, url, outbound_api_key } = body as A2AInstallRequestT
      // Require a non-empty outbound key. Pre-fix the route fell back to
      // the literal string '(none)' which then went out over the wire as
      // `Authorization: Bearer (none)` — the remote agent returned 401 and
      // the operator only saw `http_error` in the activity drawer with no
      // hint that the cause was a missing key at install time.
      if (!outbound_api_key) {
        return { status: 200, body: { ok: false, error: 'outbound_api_key is required' } }
      }
      try {
        const inboundKey = `wc_${randomBytes(16).toString('hex')}`
        deps.a2a.registry.add({
          id, name, url,
          inbound_api_key: inboundKey,
          outbound_api_key,
          capabilities: [],
          paused: false,
          transport: 'push',
        })
        return { status: 200, body: { ok: true, inbound_api_key: inboundKey } }
      } catch (err) {
        return { status: 200, body: { ok: false, error: errMsg(err) } }
      }
    },

    'POST /v1/a2a/remove': (_q, body) => {
      if (!deps.a2a) return { status: 503, body: { error: 'a2a_not_wired' } }
      // Body is pre-validated via A2ARemoveRequest schema.
      const { id } = body as A2ARemoveRequestT
      try {
        deps.a2a.registry.remove(id)
        return { status: 200, body: { ok: true } }
      } catch (err) {
        return { status: 200, body: { ok: false, error: errMsg(err) } }
      }
    },

    'POST /v1/a2a/pause': (_q, body) => {
      if (!deps.a2a) return { status: 503, body: { error: 'a2a_not_wired' } }
      // Body is pre-validated via A2APauseRequest schema.
      const { id, paused } = body as A2APauseRequestT
      try {
        deps.a2a.registry.setPaused(id, paused)
        return { status: 200, body: { ok: true } }
      } catch (err) {
        return { status: 200, body: { ok: false, error: errMsg(err) } }
      }
    },

    'GET /v1/a2a/activity': (q) => {
      if (!deps.a2a) return { status: 503, body: { error: 'a2a_not_wired' } }
      const agentId = q.get('agent_id')
      if (!agentId) return { status: 400, body: { error: 'agent_id required' } }
      const limit = Number(q.get('limit') ?? '50')
      return { status: 200, body: { events: deps.a2a.eventsStore.recentForAgent(agentId, limit) } }
    },

    'GET /v1/a2a/info': () => {
      if (!deps.a2a) return { status: 503, body: { error: 'a2a_not_wired' } }
      return {
        status: 200,
        body: {
          enabled: deps.a2a.serverEnabled,
          base_url: deps.a2a.baseUrl ?? null,
        },
      }
    },
  }
}
