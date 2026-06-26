/**
 * internal-api daemon-control routes — the admin self-diagnosis / remediation
 * surface: live sessions, force-release, model get/set, restart, turn feed.
 * Split out of routes.ts; makeRoutes spreads this in. Handlers close over
 * `deps` only. Behavior verbatim from the original table. All admin-tier per
 * route-tiers.ts.
 */
import { type InternalApiDeps, type RouteTable } from './types'
import { loadAgentConfig, saveAgentConfig, activeModel, withActiveModel } from '../../lib/agent-config'

export function daemonControlRoutes(deps: InternalApiDeps): RouteTable {
  return {
    // Live sessions for diagnosis — which (alias, provider, chat) sessions are
    // cached and when each was last used (idle/wedged inference). 503 until
    // bootstrap wires the lister.
    'GET /v1/sessions': () => {
      const sessions = deps.listSessions?.()
      if (sessions == null) return { status: 503, body: { error: 'sessions_not_wired' } }
      return { status: 200, body: { sessions } }
    },

    // Admin remediation — force-release a (possibly wedged) session so the
    // next message in that chat spawns a fresh subprocess. Returns the live
    // session list AFTER the release as a built-in verification read-back.
    'POST /v1/sessions/release': async (_q, body) => {
      if (!deps.releaseSession) return { status: 503, body: { error: 'release_not_wired' } }
      const b = (body ?? {}) as { alias?: unknown; providerId?: unknown; chatId?: unknown }
      if (typeof b.alias !== 'string' || typeof b.providerId !== 'string' || typeof b.chatId !== 'string') {
        return { status: 400, body: { error: 'alias, providerId, chatId required (strings)' } }
      }
      // Was there actually a live session to release? Compute it from the
      // session list so the read-back is honest — a no-op release (already
      // gone / wrong key / pre-bootstrap) reports `released:false` instead of
      // a misleading `ok:true`, so the agent's self-heal verification is real.
      const before = deps.listSessions?.() ?? []
      const released = before.some(s => s.alias === b.alias && s.providerId === b.providerId && s.chatId === b.chatId)
      await deps.releaseSession({ alias: b.alias, providerId: b.providerId, chatId: b.chatId })
      return { status: 200, body: { ok: true, released, sessions: deps.listSessions?.() ?? null } }
    },

    // Current pinned agent model (read-back companion to POST /v1/model).
    'GET /v1/model': () => {
      const cfg = loadAgentConfig(deps.stateDir)
      // Report the field the configured provider actually uses (activeModel
      // owns the cursor-vs-claude/codex rule).
      return { status: 200, body: { provider: cfg.provider, model: activeModel(cfg) ?? null } }
    },

    // Admin remediation — switch the pinned model. For claude this takes effect
    // on the next session spawn per chat (mtime-cached reader); for codex/cursor
    // it persists but is applied at provider construction, so it needs a daemon
    // restart to take effect. Returns the persisted model as a read-back.
    'POST /v1/model': (_q, body) => {
      const b = (body ?? {}) as { model?: unknown }
      if (typeof b.model !== 'string' || b.model.trim() === '') {
        return { status: 400, body: { error: 'model required (non-empty string)' } }
      }
      const model = b.model.trim()
      // Reject obvious bare aliases — a model id with no version digit (e.g.
      // 'opus', 'sonnet') gets mis-resolved by the CLI and 404s EVERY turn (the
      // 2026-05-08 incident this guard exists to prevent). DELIBERATELY
      // permissive on charset: real ids vary wildly across providers and
      // gateways — claude-opus-4-8[1m], anthropic/claude-opus-4, o3,
      // gpt-5.3-codex, us.anthropic.claude-opus-4-8-v1:0 — so the only universal
      // syntactic signal of a real id (vs a bare family alias) is a digit.
      // Whitespace is rejected too. An allowlist would rot as models ship.
      if (/\s/.test(model) || !/[0-9]/.test(model)) {
        return {
          status: 400,
          body: { error: `invalid model id '${model}' — use a full versioned id (e.g. 'claude-opus-4-8'), not a bare alias` },
        }
      }
      const cfg = loadAgentConfig(deps.stateDir)
      // Write the field the configured provider reads — writing `model` for a
      // cursor daemon would be a silent no-op with a falsely-confirming read-back.
      const updated = withActiveModel(cfg, model)
      saveAgentConfig(deps.stateDir, updated)
      // Read back from the just-persisted value (saveAgentConfig throws on write
      // failure, so reaching here means it landed) — no second disk round-trip.
      return { status: 200, body: { ok: true, provider: updated.provider, model: activeModel(updated) ?? null } }
    },

    // Admin remediation — graceful daemon restart. The trigger schedules the
    // shutdown+exit AFTER this response flushes; launchd/systemd respawns.
    'POST /v1/daemon/restart': () => {
      if (!deps.requestRestart) return { status: 503, body: { error: 'restart_not_wired' } }
      deps.requestRestart()
      return { status: 200, body: { ok: true, restarting: true } }
    },

    // Per-turn outcome feed for diagnosis. With chatId → that chat's turns
    // newest-first ("why did chat X stop replying"); without → the daemon's
    // recent turns across all chats. limit defaults to 50, clamped to 500.
    'GET /v1/turns': (q) => {
      if (!deps.turns) return { status: 503, body: { error: 'turns_not_wired' } }
      const chatId = q.get('chatId') ?? undefined
      const rawLimit = Number(q.get('limit') ?? '50')
      const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(1, Math.trunc(rawLimit)), 500) : 50
      const turns = chatId
        ? deps.turns.recentForChat(chatId, limit)
        : deps.turns.recent(limit)
      return { status: 200, body: { turns } }
    },
  }
}
