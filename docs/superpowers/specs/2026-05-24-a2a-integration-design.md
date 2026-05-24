# A2A Integration (P3) — Design

**Date**: 2026-05-24
**Status**: Design approved (brainstorm 2026-05-24); implementation pending (writing-plans next)
**Builds on**: cursor SDK provider (2026-05-23), N-way modes (2026-05-24), user-tier permissions (2026-05-23)

## Goal

Make wechat-cc an A2A-protocol-aware daemon, with both client and server roles:

- **A2A server** (inbound): expose a single capability — `notify(text, source, ...)` — letting any registered external A2A agent push notifications to the operator via their WeChat 1:1 chat with the bot.
- **A2A client** (outbound): expose a new MCP tool `a2a_send(agent_id, text)` to claude/codex/cursor sessions, so they can communicate back to registered external A2A agents (e.g. the operator says "claude, tell deploy-bot to retry" → claude calls the tool → wechat-cc relays via A2A).

Net effect: any A2A-compliant agent (ADK-built, CrewAI 1.14+, future third-party) becomes a **plugin** — operator paste-installs by URL, agent shows up in operator's chat as a new notification source, and claude/codex/cursor can talk back to it.

## Why durable

- A2A is a Linux-Foundation-governed open protocol with first-class TypeScript tooling (via ADK and direct HTTP+SSE) and is on the same trajectory MCP was 18 months ago.
- The provider abstraction work (user-tier, capability matrix, N-way modes) already shaped wechat-cc into "N-provider host". Adding A2A as a fifth integration vector (alongside the four SDK providers) extends that direction.
- Registration-first design positions wechat-cc as a plugin host: future A2A agents = zero-code installs by operator.

## Non-goals

- ❌ Reading the operator's conversation history out over A2A (privacy — confirmed in brainstorm: messages are too sensitive to expose).
- ❌ Reply correlation, transient "scoped reply" modes, ID prefixes, pending request maps, ask_question / request_decision / request_approval primitives — **all eliminated** by routing replies through the operator's existing claude/codex session via the `a2a_send` MCP tool.
- ❌ Group-chat notifications. wechat-cc's bot is 1:1 with operator only; A2A server doesn't expose a `chat_id` parameter.
- ❌ Marketplace backend / hosting. v1 ships with manual `wechat-cc agent add <url>` + dashboard install flow; later versions may surface a curated URL list, but no hosting service.
- ❌ A2A as the primary provider abstraction. claude/codex/cursor stay in-process via their SDKs. A2A is the **fifth integration vector**, not a replacement.

## Architecture

```
                 外部 A2A agent                        wechat-cc                          操作者
                                                                                       
  ┌──────────────┐                              ┌─────────────────────┐               
  │ deploy-bot   │──── POST /a2a/notify ───────►│ a2a-server          │              ┌────────┐
  │ /.well-known/│    Authorization: Bearer xxx │  ├ verify api_key   │              │ 操作者 │
  │ agent.json   │    body: {text, source}      │  ├ route → bot chat │              │ WeChat │
  └──────────────┘                              │  └ sendAssistantText│─────────────►│ 私聊   │
                                                │     [A2A:deploy-bot]│              │        │
                                                │      Build failed   │              │  ❗     │
                                                │                     │              │        │
                                                │                     │              │  "claude│
                                                │                     │              │   tell  │
                                                │                     │              │   them  │
                                                │                     │◄─────────────│   retry"│
                                                │                     │              └────────┘
                                                │   inbound dispatch  │              
                                                │   ↓                 │              
                                                │   claude session    │              
                                                │   ↓ MCP tool        │              
                                                │   a2a_send(         │              
                                                │     "deploy-bot",   │              
                                                │     "retry")        │              
                                                │   ↓                 │              
                                                │   a2a-client ───────┼──── POST /a2a → deploy-bot
                                                └─────────────────────┘                            
```

Two surfaces, both stateless from a correlation perspective:
- Server side: take inbound, push to chat. No pending state, no reply tracking.
- Client side: claude initiates outbound via MCP tool. Same pattern as `delegate_<peer>` today.

## Module layout

**New files**:

| File | Responsibility |
|---|---|
| `src/core/a2a-client.ts` | Outbound A2A: fetch `/.well-known/agent.json`, POST to a registered agent's endpoint with auth header, return result. Pure HTTP client; no app logic. |
| `src/core/a2a-server.ts` | Inbound A2A HTTP server: listen on a port (default 0 = ephemeral; configurable via `agent-config.a2a_listen`), verify Bearer token against registered agent's api_key, validate body shape, hand off to a routing callback. |
| `src/core/a2a-registry.ts` | The registered-agents source of truth. Loaded from `agent-config.json:a2a_agents`. CRUD (`add`, `remove`, `get`, `list`, `verifyBearer`). |
| `src/daemon/wechat-mcp/tools/a2a-send.ts` | The MCP tool that wechat-mcp exposes to agent sessions. Calls into `a2a-client.send(...)`. |
| `apps/desktop/src/modules/a2a-agents.js` | Dashboard "Agents (A2A)" UI: list, add (paste URL → fetch card → confirm), remove, pause/resume, recent-activity view. |

**Modified files**:

| File | Change |
|---|---|
| `src/lib/agent-config.ts` | Add `a2a_agents?: A2AAgentRecord[]` + `a2a_listen?: { port?: number; host?: string }` to the schema. |
| `src/daemon/bootstrap/index.ts` | At boot: instantiate `a2a-registry`, `a2a-server`, `a2a-client`. Register `a2a-send` tool into wechat-mcp. Wire server's notify-callback → existing inbound pipeline. |
| `src/lib/db.ts` | Migration v12: new table `a2a_events`. |
| `src/core/capability-matrix.ts` | One new row family per tier: `a2a_send` tool gating (admin auto / trusted relay / guest forbidden). |

**Unchanged**:
- `conversation-coordinator.ts` — A2A inbound piggybacks on `sendAssistantText` once the message is formatted; doesn't change dispatch.
- `mode-commands.ts` — A2A doesn't introduce new slash commands.
- `provider-registry.ts`, `session-manager.ts` — A2A isn't a provider type.

## Data model

### `agent-config.json` schema additions

```jsonc
{
  // ... existing fields (provider, claudeModel, codexModel, cursorModel, ...)

  "a2a_listen": {              // optional; defaults to disabled (no inbound)
    "host": "127.0.0.1",       // never expose to 0.0.0.0 by default
    "port": 8717                // explicit; if unset, A2A server doesn't start
  },

  "a2a_agents": [              // registered external A2A endpoints
    {
      "id": "deploy-bot",      // stable id used by claude when calling a2a_send
      "name": "Deploy Bot",    // human-readable
      "url": "https://deploy.example.com/a2a",
      "inbound_api_key": "wc_xxxxxxxx",  // wechat-cc-generated; agent sends this in Bearer header when calling our notify
      "outbound_api_key": "dpb_yyyyyy",  // agent-provided; we send this in Bearer header when we call them
      "capabilities": ["notify", "respond"],  // copied from Agent Card at install time; informational
      "paused": false
    }
  ]
}
```

Two separate API keys per agent:
- `inbound_api_key` — what wechat-cc requires when the agent calls IN. Generated by us at install (`crypto.randomBytes(16).toString('hex')`).
- `outbound_api_key` — what the agent requires when wechat-cc calls OUT. Provided by operator from the agent's docs / dashboard.

This decoupling matters because the two channels are independent; either may exist without the other.

### DB migration v12 — `a2a_events`

```sql
CREATE TABLE a2a_events (
  id TEXT PRIMARY KEY NOT NULL,
  ts TEXT NOT NULL,                           -- ISO 8601
  direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  agent_id TEXT NOT NULL,
  text TEXT NOT NULL,                         -- truncate to 8KB
  urgency TEXT,                               -- 'normal' | 'critical' | null
  status TEXT NOT NULL DEFAULT 'ok',          -- 'ok' | 'auth_failed' | 'http_error' | 'timeout'
  http_status INTEGER                         -- for outbound only
) STRICT;
CREATE INDEX a2a_events_agent_ts ON a2a_events(agent_id, ts DESC);
```

Pure observability log. Not used by control flow. Dashboard's "recent activity" reads from this.

## Inbound notify — server endpoint

### HTTP route

`POST /a2a/notify`

Request:
```http
POST /a2a/notify
Authorization: Bearer wc_xxxxxxxx
Content-Type: application/json

{
  "agent_id": "deploy-bot",
  "text": "Build failed on main.",
  "urgency": "normal",
  "metadata": { /* free-form, persisted in events */ }
}
```

Server algorithm:
1. Find agent by `agent_id` in registry; reject 404 if unknown.
2. Verify Bearer matches `agent.inbound_api_key`; reject 401 if not.
3. If `agent.paused`, accept 202 (silently drop) — operator chose to mute.
4. Compose chat-history message: `[A2A:${agent_id}] ${text}` — same `[Name]` prefix convention chatroom mode already uses.
5. Call `sendAssistantText(operatorChatId, formattedText)` — the existing inbound pipeline.
6. Append row to `a2a_events` (direction='in').
7. Respond 200.

**Operator chat resolution**: in v1, "operator chat" = the **first-bound bot↔operator 1:1 chat** (resolved by querying the conversations table for the earliest-bound bot account at notify time; cached for the daemon's lifetime). Multi-account is deferred — operators with multiple bots will see all A2A notifications going to whichever was bound first. Refining to "broadcast to all bots" or "operator picks a primary" is a v2 concern when multi-account adoption is observable.

### Agent Card (wechat-cc's own)

`GET /.well-known/agent.json` returns wechat-cc's Agent Card:

```json
{
  "name": "wechat-cc",
  "description": "WeChat bridge for AI agents — notify the operator via WeChat chat.",
  "version": "0.6.x",
  "auth": { "type": "bearer", "required": true },
  "capabilities": [
    {
      "name": "notify",
      "description": "Push a message to the operator's WeChat chat. Operator may reply via their claude/codex session, which can then call back via A2A.",
      "endpoint": "/a2a/notify",
      "method": "POST",
      "request_schema": {
        "agent_id": "string (your registered id with this wechat-cc)",
        "text": "string",
        "urgency": "string (optional, 'normal'|'critical')",
        "metadata": "object (optional)"
      }
    }
  ]
}
```

Served only when `a2a_listen` is enabled. The Agent Card itself is unauthenticated (it's a discovery doc, by A2A protocol convention). Calling the `notify` capability requires `Authorization: Bearer <inbound_api_key>` — the `auth.required: true` in the card refers to capability invocation, not card retrieval.

## Inbound chat format

What the operator sees in their WeChat chat with the bot:

```
[A2A:deploy-bot] Build failed on main. View logs?
```

Optional `urgency: 'critical'` adds a `❗` prefix and (future) triggers the desktop notification overlay; otherwise the message is plain inline.

What claude/codex/cursor sees in chat history when next dispatched:
- Same string. The `[A2A:<agent_id>]` prefix is machine-parseable and consistent with the `[Claude]`/`[Codex]`/`[Cursor]` convention from N-way modes. Claude can extract the agent_id by string match.
- Additionally, the system prompt (for the next claude dispatch only) gets a one-line hint: `Recent A2A notifications from: deploy-bot (use a2a_send to reply).` This is appended to system prompt only when there's at least one A2A message in recent history (last N=5 turns). Stops claude from missing the existence of `a2a_send` when the chat is long.

## Outbound a2a_send — MCP tool

Exposed by wechat-mcp to every agent session, regardless of provider:

```typescript
{
  name: 'a2a_send',
  description: 'Send a message to a registered external A2A agent. Use this when the operator asks you to reply to or follow up with an A2A notification. The agent_id is the identifier from the [A2A:<id>] prefix in recent messages.',
  input_schema: {
    type: 'object',
    properties: {
      agent_id: { type: 'string', description: 'The registered agent id, e.g. "deploy-bot".' },
      text: { type: 'string', description: 'The message text to send to that agent.' }
    },
    required: ['agent_id', 'text']
  }
}
```

Implementation:
1. Look up `agent_id` in registry; if not registered → return `{ ok: false, error: 'unknown_agent', registered: [...] }`.
2. If `agent.paused` → return `{ ok: false, error: 'agent_paused' }`.
3. POST to `agent.url` with `Authorization: Bearer ${agent.outbound_api_key}`, body `{ text, source: { agent_id: 'wechat-cc' } }`.
4. On 2xx → return `{ ok: true, http_status, response_text }`.
5. On non-2xx or network error → return `{ ok: false, error, http_status }`.
6. Append row to `a2a_events` (direction='out', status).
7. Timeout: 10s. Longer is rare for notification-class peers; longer-running work should use webhooks.

**No retry**: agent failures surface to claude, which can decide whether to retry or apologize to the operator. We don't hide failures behind silent retries.

## Tier gating for a2a_send

Add one row family to `capability-matrix.ts`:

| Tier | Behavior |
|---|---|
| `admin` | a2a_send auto-approved (canUseTool returns 'allow') |
| `trusted` | Each call goes through permission relay — operator gets inline approval prompt with `{ agent_id, text }` preview |
| `guest` | a2a_send forbidden (canUseTool returns 'deny') |

This is **identical in shape** to how `delegate_codex` / other sensitive tools are gated today; no new mechanism.

## Dashboard UX (v1.1)

New tab in desktop app: **Agents (A2A)**.

```
┌─ Agents (A2A) ────────────────────────────────────────────────┐
│ Registered agents                              [+ Add Agent]  │
│ ┌───────────────────────────────────────────────────────────┐ │
│ │ ● deploy-bot                    last activity: 5 min ago  │ │
│ │   "Deploy Bot"  https://deploy.example.com/a2a            │ │
│ │   [Pause]  [Remove]  [View activity]                      │ │
│ └───────────────────────────────────────────────────────────┘ │
│ ┌───────────────────────────────────────────────────────────┐ │
│ │ ○ calendar-bot (paused)         last activity: 2 hr ago   │ │
│ │   ...                                                      │ │
│ └───────────────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────┘
```

**Add Agent flow**:
1. Operator pastes URL in input
2. Dashboard calls `/internal-api/a2a/preview` → wechat-cc fetches `/.well-known/agent.json`
3. Modal shows: name, description, capabilities, whether auth needed
4. Operator picks id (slug, lowercase, defaults to slug-from-name), enters outbound_api_key if required
5. Dashboard calls `/internal-api/a2a/install` → wechat-cc generates inbound_api_key, persists to agent-config.json, returns the inbound key + cURL example for the operator to register with the external agent
6. Toast: "deploy-bot installed. Share this key with the agent to enable inbound notifications: `wc_xxx`"

**Remove**: confirmation modal → splices out of agent-config.json. Rows in `a2a_events` for that agent_id are kept for audit.

**Pause**: flips `paused: true`. Inbound notify returns 202 silently; outbound `a2a_send` returns `{ ok: false, error: 'agent_paused' }`. Operator may resume.

**View activity**: opens drawer with paginated `a2a_events` filtered by agent_id, both directions, latest first.

## CLI (v1.0)

For pre-v1.1 / power users:

```bash
# Fetch Agent Card and show metadata
wechat-cc agent inspect <url>

# Install (interactive prompts for id / outbound key)
wechat-cc agent add <url>

# List
wechat-cc agent list

# Pause / resume
wechat-cc agent pause <id>
wechat-cc agent resume <id>

# Remove
wechat-cc agent remove <id>

# Activity
wechat-cc agent activity <id> [--limit N]
```

These are thin wrappers over the same internal-api endpoints the dashboard uses.

## Auth + threat model

**Inbound auth**:
- Bearer token, one per registered agent (inbound_api_key)
- Tokens generated by wechat-cc at install (16 random bytes hex)
- Stored in agent-config.json (mode 0600 directory enforced by db.ts pattern)
- Verified at every notify call; mismatch → 401
- No token rotation in v1 (operator can remove + re-add for rotation)

**Outbound auth**:
- Bearer token to the external agent, provided by operator at install
- Stored in agent-config.json
- Sent in every a2a_send call

**Network surface**:
- A2A server default-binds to `127.0.0.1` only. Operator must explicitly opt into 0.0.0.0 / external interface via agent-config (`a2a_listen.host`).
- Tauri asset scope unchanged (this is HTTP server, not file access).
- A2A server is OFF by default (`a2a_listen` undefined). Operator must opt in to even start it.

**Threat surfaces and mitigations**:
- ☑ Replay: tokens are bearer, vulnerable to replay if leaked. Mitigation: HTTPS in production, localhost-bind by default. Future: nonce header if community demands.
- ☑ Spam: any registered agent can send unlimited notifies. Mitigation: operator can pause/remove. Future: per-agent rate limit row in agent-config.
- ☑ Spoofing source: the `agent_id` in body must match the Bearer's owning agent — enforced by server algorithm step 1+2 ordering (check Bearer first, then ensure body.agent_id == bearer.agent_id).

## Observability

Dashboard reads `a2a_events` and shows:
- Per-agent counters (inbound count, outbound count, last activity)
- "Recent activity" filterable feed (all agents, or one agent)
- Failed calls (status != 'ok') surface in red

For deeper debugging, JSONL companion log gets a new tag `A2A_NOTIFY_IN` / `A2A_SEND_OUT` per event.

## Edge cases

| Case | Behavior |
|---|---|
| Operator removes an agent while it has pending in-flight outbound a2a_send call | The call completes (already in flight); the resulting event row records normally. New a2a_send to removed agent → unknown_agent error. |
| Agent at registered URL goes offline | Outbound a2a_send returns `{ ok: false, error: 'http_error' }` with the network error message. Inbound from that agent simply stops; we don't ping/probe. |
| Agent rotates its outbound_api_key | wechat-cc fails 401 on outbound. Operator must update via `wechat-cc agent remove + add` (no in-place rotation in v1). |
| Operator has multiple bot accounts | v1: notifications go to "primary bot" (the one bound first). Multi-account broadcast is a v2 concern. |
| Multiple notifications arrive in quick succession from different agents | Each is appended to chat history individually as separate `[A2A:<id>]` lines. Operator sees them in order. Claude's next dispatch sees all of them in history. No grouping. |
| Notification arrives mid-dispatch (claude is currently running a turn) | Same path as any other sendAssistantText call — gets queued / streamed to the chat. The next dispatch (operator's next reply) will see the A2A line in history. |
| External agent calls `notify` with a different `agent_id` than the Bearer's owner | 403 with explanatory body. (Protection against shared-key attacks.) |
| A2A server listening but operator hasn't registered any agents | Returns 401 on any notify (no matching bearer). `/well-known/agent.json` still serves the Agent Card. |
| Operator's claude session calls `a2a_send` for an agent_id not in the latest history (claude hallucinated) | Tool returns `{ ok: false, error: 'unknown_agent', registered: [...] }`; claude sees the error and corrects (or apologizes to operator). |
| Operator types `[A2A:deploy-bot]` text manually | Claude treats it the same as a real A2A notification. Cost: claude may attempt a2a_send when operator didn't actually want one. Mitigation: tier system (trusted/guest get permission relay). Accepted risk. |

## Rollout

Single feature branch, two sub-phases:

**Phase 1 — Plumbing (server + client + MCP tool + CLI)**: ~600 LOC + ~250 LOC tests
- a2a-client, a2a-server, a2a-registry modules
- MCP tool registration
- agent-config schema + migration v12
- CLI commands
- bootstrap wiring
- ~1 week

**Phase 2 — Dashboard install (v1.1)**: ~300 LOC + ~150 LOC tests
- Dashboard "Agents (A2A)" tab
- Add Agent modal flow (fetch card → confirm → install)
- Recent activity drawer
- ~2-3 days

Total: ~1100 LOC + ~400 LOC tests, ~1.5 weeks if executed via subagent-driven dev.

## Acceptance gate

Done when:

- [ ] `wechat-cc agent add <url>` fetches Agent Card, prompts for ids/keys, persists to agent-config.json
- [ ] Inbound: external POST to /a2a/notify with valid Bearer routes through to operator's chat as `[A2A:<id>] ...` line
- [ ] Operator says "tell deploy-bot retry" → claude calls a2a_send → external endpoint receives POST with operator's text
- [ ] Tier gating works: admin auto, trusted relays through permission prompt, guest forbidden
- [ ] a2a_events table populated; dashboard "Agents" tab lists, shows recent activity, supports add/remove/pause
- [ ] DB migration v12 applies cleanly; v11→v12 forward, no schema break
- [ ] Tests: unit on a2a-client/server/registry, integration via test harness mocking external A2A endpoint, e2e for install flow
- [ ] Threat-model defaults verified: server binds 127.0.0.1 unless explicitly opted out; off by default
- [ ] README documents the new agent management commands + dashboard tab + threat-model defaults

## Out of scope (explicit, with reasoning)

- ❌ Bidirectional thread / long conversation (operator + external agent multi-turn) — deferred; achievable via claude/codex chaining a2a_send calls
- ❌ Scheduled notification (`notify_at(timestamp)`) — operator's external agent can self-schedule
- ❌ Read-context API for external agents (chat history, observations) — privacy-blocked per brainstorm
- ❌ Per-agent rate limit / quota — defer until abuse is observed
- ❌ Token rotation in-place — remove + re-add suffices in v1
- ❌ A2A-as-provider (using A2A endpoints in place of SDK providers) — different design; defer until ecosystem matures
- ❌ Multi-account broadcast — single-bot baseline is the common case

## Open questions

(None left from brainstorm. Document any new ones during implementation.)
