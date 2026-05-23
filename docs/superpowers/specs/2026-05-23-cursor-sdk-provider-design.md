# Cursor SDK Provider — Design

**Date**: 2026-05-23
**Builds on**: `docs/specs/2026-05-08-multi-provider-extension.md` (P1 design) and `docs/spike/2026-05-08-cursor-sdk.md` (spike that resolved open Q1/Q2/Q4)
**Status**: Design approved; implementation pending (writing-plans next)
**Why this design rev**: the 2026-05-08 spec predates the 3-tier permissions feature (shipped 2026-05-23). This doc narrows scope to P1 only (drop P3 + the modular-SDK-install graduation to follow-ups), adds tier integration that the 2026-05-08 spec couldn't have, and consolidates the spike's resolutions into a single implementation-ready surface.

## Goal

Add `cursor` as a third registered `AgentProvider`, alongside `claude` and `codex`. Users send `/cursor` from WeChat to route inbound to the Cursor SDK. The provider plugs `wechat-mcp` + `delegate-mcp` into Cursor the same way it's wired for the other two providers, so `reply` / `share_page` / memory tools all work identically.

The 3-tier permissions feature must apply: admin / trusted / guest each map to Cursor SDK options that honor (best-effort) the tier's `TierProfile`. Cursor's permission surface is coarser than Claude's or Codex's — one sandbox boolean — so the mapping is honestly lossy and documented.

**Non-goals**: P3 (N-way mode generalization), modular-SDK install (graduating claude/codex to `optionalDependencies`), session resume across daemon restart, any provider beyond Cursor. Each is a separate follow-up.

## Why durable

A third provider is the cheapest test of whether the provider-architecture work from the 2026-05-07 (`AgentProvider` / `AgentSession` interface), 2026-05-22 (tier translation + per-spawn `canUseTool`), and 2026-05-23 (per-chat session isolation, admin chat relay routing, allowlist gate) really earns its keep. If adding Cursor requires touching the interface layers, the abstraction was wrong; if it only adds a new file + one bootstrap block, the abstraction is sound.

## Five decisions (settled in brainstorming)

| Decision | Choice |
|---|---|
| Scope this round | **P1 only.** P3 (N-way modes) follows once P1 is dogfooded. Modular SDK install is its own follow-up. |
| Cursor SDK in `dependencies` or `optionalDependencies` | **`optionalDependencies`.** Asymmetric with the other two (claude/codex stay required for now) — this matches Cursor being the "new and skippable" provider. The 26MB transitive payload shouldn't be forced on users who don't want Cursor. The full modular-install path stays a follow-up. |
| Feature flag (`WECHAT_CC_EXPERIMENTAL_PROVIDERS=1`) | **No.** Conditional registration (API key present + dynamic SDK import succeeds) is gate enough. v0.5.14 stability pass is 2+ weeks old; master is stable. |
| Session resume | **Disabled in P1** (`canResume: () => false`). Cursor's `Agent.resume(agentId)` API exists per spike Q2 but adds a moving part worth its own validation. P1.1 follow-up. |
| Tier mapping | **Match Codex's lossy semantics** — admin → sandbox off, trusted + guest → sandbox on. Guest gap (writes possible in cwd) documented in README + provider prompt. Operators who need strict guest separation route guests to Claude. |

## Architecture

```
inbound (mode=solo, provider=cursor)
   │
   ▼
conversation-coordinator
   │  resolveTier(msg.chatId, loadAccess()) → 'admin' | 'trusted' | 'guest'
   │  TIER_PROFILES[tier]
   ▼
sessionManager.acquire({
  alias, path, providerId: 'cursor',
  chatId: msg.chatId,
  tierProfile,
})
   │
   ▼
ProviderRegistry.get('cursor') → cursor-agent-provider
   │
   ▼ spawn(project, { tierProfile, chatId })
   │
   │  tierProfileToCursorSdkOpts(tp) → { sandboxOptions: {enabled: boolean} }
   │
   ▼
@cursor/sdk: Agent.create({
  apiKey, model?, mcpServers,
  local: { cwd, sandboxOptions },
})
   │
   ▼ agent.send(text) → Run.stream()
   │  → map SDKMessage → AgentEvent (per spike §"Event-shape mapping")
   │
   ▼ AgentSession.dispatch() yields AgentEvent → coordinator → wechat outbound
```

No changes to the layers above the provider (coordinator, session-manager, permission-relay). The provider conforms to the existing `AgentProvider` interface plus the spawn-opts shape (`chatId` + `tierProfile`) added in Task 6 of the user-tier feature.

## Module layout

**New files**:

| File | Responsibility |
|---|---|
| `src/core/cursor-agent-provider.ts` | `createCursorAgentProvider({sdk, apiKey, model?, mcpServers?}): AgentProvider`. Pure `tierProfileToCursorSdkOpts(tp): {sandboxOptions: {enabled: boolean}}` exported alongside. Event mapping per spike. |
| `src/core/cursor-agent-provider.test.ts` | Unit tests: tier translation snapshot, spawn forwards opts, event mapping per `SDKMessage` variant, `mapCursorToolName` fallback parser, error paths. |
| `src/daemon/__e2e__/dispatch-solo-cursor.e2e.test.ts` | Mirror of `dispatch-solo-codex.e2e.test.ts` — fake cursor SDK installed via harness; inbound → cursor dispatch → reply tool → wechat outbound. |
| `src/daemon/__e2e__/user-tier-cursor.e2e.test.ts` | Mirror of `user-tier-codex.e2e.test.ts` — admin chat gets `sandboxOptions.enabled = false`; guest chat gets `sandboxOptions.enabled = true`. Verifies the chain. |

**Modified files**:

| File | Change |
|---|---|
| `src/core/capability-matrix.ts` | Add cursor rows: 4 modes × 2 permissionModes = 8 new rows. Each mirrors codex's `{askUser: 'never', replyPrefix, approvalPolicy: null, delegate, forbidden: false}` — Cursor SDK has no per-tool callback (spike Q4). The `assertMatrixComplete(providers)` boot-time check will then demand cursor coverage when cursor is registered. |
| `src/daemon/bootstrap/index.ts` | Conditional registration block after the codex one. Probes `CURSOR_API_KEY` + dynamic `import('@cursor/sdk')`. Both required; silent skip on either missing. |
| `src/daemon/__e2e__/fake-sdk.ts` | Add `installFakeCursor()` (script-driven, parallel to `installFakeClaude` / `installFakeCodex`) and `installCursorSpawnRecorder()` (snapshot tier opts for the e2e). |
| `src/daemon/__e2e__/harness.ts` | `recordCursorSpawnOptions?: (opts) => void` opt-in hook, parallel to claude + codex recorders. |
| `src/cli/schema.ts` | `AgentConfig` interface gains optional `cursorModel?: string`. Setup-flow + doctor follow. |
| `src/cli/doctor.ts` | Probe for `CURSOR_API_KEY` + dynamic `import('@cursor/sdk')` success; report cursor as registered/missing in doctor JSON output. |
| `src/cli/setup-flow.ts` | If `CURSOR_API_KEY` is set in env, surface it in the agent-config write path. (Light touch — no UI wizard step in P1.) |
| `src/core/conversation.ts` (slash commands) / `src/daemon/mode-commands.ts` | Recognize `/cursor` slash command; route to `setMode({kind: 'solo', provider: 'cursor'})`. The provider-registry validation already accepts arbitrary `ProviderId`. |
| `package.json` | `@cursor/sdk: ^1.0.12` in `optionalDependencies`. |
| `README.md` | Brief note: cursor as third provider. Add to `Known limitations`: "Cursor tier enforcement is the coarsest of the three providers — only the admin/everyone-else binary is meaningfully enforced. For strict tier separation, route guests to Claude." |

**Files unchanged**: capability-matrix's existing claude/codex rows (untouched); session-store schema (no migration); coordinator dispatch paths (provider-agnostic); permission-relay (Cursor has no canUseTool — same skip as Codex); all existing tests (cursor tests run alongside).

## Tier integration

Cursor SDK exposes one permission knob: `local.sandboxOptions: { enabled: boolean }` (spike Q4). The pure mapping function:

```ts
export interface CursorTierSdkOpts {
  sandboxOptions: { enabled: boolean }
}

/**
 * Translate daemon TierProfile → Cursor SDK options.
 *
 * Cursor SDK has no per-tool callback (cf. Claude) and no granular
 * sandbox shape (cf. Codex's read-only / workspace-write / danger).
 * One boolean is the entire permission surface. So tier enforcement
 * collapses to admin (full system access) vs everyone else (sandbox).
 *
 * Heuristic: a profile with no relay and no deny is admin-equivalent.
 * Any non-empty relay or deny → enable sandbox. Matches the same
 * size-based heuristic Codex uses (see codex-agent-provider.ts).
 */
export function tierProfileToCursorSdkOpts(tp: TierProfile): CursorTierSdkOpts {
  if (tp.relay.size === 0 && tp.deny.size === 0) {
    return { sandboxOptions: { enabled: false } }
  }
  return { sandboxOptions: { enabled: true } }
}
```

Resulting mapping per default profile:

| Tier | sandboxOptions | Effect | Honest comparison |
|---|---|---|---|
| admin | `{enabled: false}` | Cursor agent runs unrestricted in `cwd` | Matches Codex `danger-full-access` |
| trusted | `{enabled: true}` | Cursor's process-level sandbox; reads/writes constrained to cwd, no escape to wider FS | Matches Codex `workspace-write` (lossier: Codex's `approvalPolicy: 'never'` is the spec; Cursor has no approval concept) |
| guest | `{enabled: true}` | Same as trusted | **Lossier than Codex.** Codex `read-only` truly blocks writes; Cursor sandbox allows cwd writes. Documented limitation. |

### Why this is acceptable

The chain that protects guests on Claude is `disallowedTools` (built-in Bash/Edit/Write blocked at SDK level) + `canUseTool` (MCP tools relayed/denied per tier). On Codex it's `sandboxMode: 'read-only'` (SDK-level write block) + `approvalPolicy: 'untrusted'` (asks/denies risky ops). On Cursor neither layer exists.

What still holds for guest-tier Cursor sessions:
- The daemon's inbound `mw-access` middleware blocks anyone not in `allowFrom` at the door
- Permission prompts (if Cursor ever adds them) still route to the configured admin chat
- MCP tools called from Cursor go through the same wechat-mcp child the daemon owns — and that child enforces its own per-tool authorization where applicable

What's weaker than Claude/Codex for guests on Cursor:
- A guest can ask Cursor to write files inside cwd. No equivalent of Codex's read-only sandbox or Claude's `disallowedTools: [Write, Edit, ...]`.

Documentation, not enforcement, is the answer in P1. README + provider prompt section explicitly say: **If you have guests you don't trust to write inside the project's working directory, route them to Claude.**

## Permission relay (no canUseTool)

`capability-matrix.ts` adds cursor rows with `askUser: 'never'` (same as codex). The bootstrap's `sdkOptionsForProject` closure is Claude-only — Cursor's spawn options are built inside `cursor-agent-provider.ts` via `tierProfileToCursorSdkOpts(tp)`. No per-spawn `canUseTool` to build, no admin chat routing for tool prompts (because none fire).

This means Cursor sessions don't surface tool-permission prompts in WeChat. Users who want fine-grained relay use Claude. Documented in `multiModeAwarenessSection` of `prompt-builder.ts` so the agent itself knows the constraint.

## Event mapping

From the spike (lines 188-210):

| Cursor SDKMessage | `AgentEvent` |
|---|---|
| `assistant` (TextBlock content) | `{ kind: 'assistant_text', text }` |
| `assistant` (ToolUseBlock content) | `{ kind: 'tool_call', server, tool, input }` via `mapCursorToolName` |
| `tool_call` (`status: 'completed'` with result) | (swallowed at provider boundary; same as Claude does today) |
| `status: 'FINISHED'` | `{ kind: 'result', sessionId: agent.agentId }` |
| `status: 'ERROR'` | `{ kind: 'result', sessionId, error: status.error?.message }` |
| `status: 'CANCELLED'` / `'EXPIRED'` | `{ kind: 'result', sessionId, error: 'cancelled' / 'expired' }` |
| `thinking` / `system` / `user` (echo) / `request` / `task` / running statuses | drop |

The provider captures `agent.agentId` on creation and emits it in the eventual `result` event. session-store accepts this for the existing `session_id` column — future P1.1 session resume can read it back via `Agent.resume(agentId)`.

### Tool name parsing

Spike Q3 (unresolved without live PoC): is the tool name `mcp__wechat__reply` (Anthropic convention) or just `reply`? Both possibilities handled by `mapCursorToolName(rawName, mcpServerNames)`:

```ts
function mapCursorToolName(rawName: string, mcpServerNames: Set<string>): { server?: string; tool: string } {
  // Anthropic-style: mcp__<server>__<tool>
  const m = /^mcp__([^_]+)__(.+)$/.exec(rawName)
  if (m && mcpServerNames.has(m[1]!)) return { server: m[1], tool: m[2]! }
  // Other separator forms
  for (const sep of ['__', ':', '/']) {
    const i = rawName.indexOf(sep)
    if (i > 0 && mcpServerNames.has(rawName.slice(0, i))) {
      return { server: rawName.slice(0, i), tool: rawName.slice(i + sep.length) }
    }
  }
  // Built-in / unrecognized
  return { tool: rawName }
}
```

First successful tool call from Cursor logs `[CURSOR_TOOL] mapped name=<raw> → server=<x>, tool=<y>` so the implementer notices if the format diverges. Tighten the function if so. Not a design block.

## Bootstrap wiring

```ts
// src/daemon/bootstrap/index.ts — after the codex registration block

// CURSOR_API_KEY is env-only — not stored in agent-config.json (secret on
// disk in plaintext is a worse posture than the operator setting an env
// var in their shell rc / systemd unit). The 2026-05-08 spec mentioned
// configuredAgent.cursorApiKey; deliberately dropping that here.
const cursorKey = process.env.CURSOR_API_KEY
if (cursorKey) {
  try {
    const cursorMod = await import('@cursor/sdk')
    const cursorWechat = deps.internalApi ? wechatStdioMcpSpec(deps.internalApi, 'cursor') : null
    const cursorDelegate = deps.internalApi ? delegateStdioMcpSpec(deps.internalApi, 'claude') : null
    registry.register(
      'cursor',
      createCursorAgentProvider({
        sdk: cursorMod,
        apiKey: cursorKey,
        ...(configuredAgent.cursorModel ? { model: configuredAgent.cursorModel } : {}),
        mcpServers: {
          ...(cursorWechat ? { wechat: cursorWechat } : {}),
          ...(cursorDelegate ? { delegate: cursorDelegate } : {}),
        },
      }),
      {
        displayName: 'Cursor',
        canResume: () => false,
      },
    )
    deps.log('BOOT', 'cursor: SDK + API key present — provider registered')
  } catch (err) {
    deps.log('BOOT', `cursor: SDK not installed (run \`bun add @cursor/sdk\` to enable) — provider not registered`)
  }
} else {
  deps.log('BOOT', 'cursor: CURSOR_API_KEY not set — provider not registered')
}
```

The dynamic `import('@cursor/sdk')` is what makes `optionalDependencies` work. If the package isn't in `node_modules`, the import throws and the catch path logs + skips.

The Cursor SDK module is passed into the provider factory (`sdk: cursorMod`) so the provider doesn't carry a top-level static import — bundlers won't try to resolve `@cursor/sdk` at compile time when the package is absent.

## Data flow / lifecycle

1. **Inbound arrives**: pipeline middleware processes inbound msg → `coordinator.dispatch(msg)`.
2. **Coordinator** resolves tier: `resolveTier(msg.chatId, loadAccess())` → `TIER_PROFILES[tier]`.
3. **Coordinator** acquires session: `manager.acquire({alias, path, providerId: 'cursor', chatId: msg.chatId, tierProfile})`.
4. **SessionManager** looks up `(alias, 'cursor', chatId)` in its session map. Hit → reuse handle. Miss → call cursor provider's `spawn`.
5. **cursor-agent-provider.spawn** computes `sandboxOptions` via `tierProfileToCursorSdkOpts(tp)`, calls `Agent.create({apiKey, model?, mcpServers, local: {cwd, sandboxOptions}})`. Returns an `AgentSession` whose `dispatch()` calls `agent.send(text)` and yields mapped events.
6. **Run streams** → `AgentEvent` events flow up to coordinator → `assistant_text` events tee to wechat outbound; `tool_call` events tee to the wechat-mcp child via internal-api bridge.
7. **`Run.status` reaches `'FINISHED'`** → provider emits `{kind: 'result', sessionId: agent.agentId}` → coordinator finalizes the dispatch.

session-store gets the `agent.agentId` in `session_id` for future resume (P1.1). Lifetime: until `release()` or LRU eviction or daemon shutdown — same as the other providers.

## Testing strategy

| Layer | What |
|---|---|
| `tierProfileToCursorSdkOpts` unit | Three tier snapshots (admin → sandbox off; trusted → sandbox on; guest → sandbox on). Mirror of `tierProfileToCodexSdkOpts` tests. |
| `mapCursorToolName` unit | mcp__-prefix recognition; alternate separators (`__`, `:`, `/`); fallback for built-in tools; unknown server names. |
| Event mapping unit | Each `SDKMessage` variant produces the right `AgentEvent` (or is dropped). Especially: `status: 'ERROR'` → `result` with error message; thinking is dropped. |
| Provider unit | spawn forwards apiKey/model/mcpServers; sandboxOptions wired from tier; agent.close() invoked on session.close(). |
| capability-matrix unit | Bootstrap assertion holds when cursor registered; cursor rows mirror codex's askUser/approvalPolicy. |
| `dispatch-solo-cursor.e2e.test.ts` | Boot daemon with fake cursor SDK + reply-tool fixture; admin chat inbound → cursor dispatches → reply MCP tool → wechat outbound captured. |
| `user-tier-cursor.e2e.test.ts` | Two chats (admin/guest); capture spawn snapshots; assert admin snapshot has `sandboxOptions.enabled=false`, guest snapshot has `enabled=true`. Plus tier change → invalidation respawns (parallel to existing tests). |

## Edge cases & failure modes

| Case | Behavior |
|---|---|
| `CURSOR_API_KEY` set but `@cursor/sdk` not installed | Bootstrap logs skip-with-hint; provider not registered; `/cursor` slash command returns `unknown provider`. |
| `@cursor/sdk` installed but `CURSOR_API_KEY` unset | Same — skip with different log message ("API key not set"). |
| Cursor SDK throws during `Agent.create` (network, auth) | Provider's spawn rejects; sessionManager catches; coordinator dispatches the `auth_failed`-style error path the existing providers use. |
| Tool name format diverges from `mcp__<server>__<tool>` | `mapCursorToolName` fallback handles it; first invocation logs the observed shape. If fallback fails, server is undefined and the tool routes through built-in path — likely yields no-op + log entry. |
| Session resume attempted before P1.1 ships | `canResume: () => false` ensures session-manager always cold-spawns. Stored `session_id` (`agentId`) is dead data until P1.1 reads it. |
| `local.sandboxOptions` not honored by Cursor SDK (regression) | Spawn options are recorded by the e2e recorder — discrepancy surfaces in CI before reaching users. |
| Guest-tier user uses Cursor to write a file inside cwd | Allowed (documented limitation). Operator should route guests to Claude if this isn't acceptable. |
| Cursor SDK version bump breaks event shape | Pinned at `^1.0.12` (spike-validated). Bump deliberately; spike notes Cursor explicitly says tool-call schema is unstable. |

## Open issue (one)

**Tool name format (spike Q3)** — still requires a 5-min live PoC at implementation time. The provider implementation includes the multi-format `mapCursorToolName` parser, so the format is observed-not-guessed. If the format is straightforward `mcp__server__tool`, no follow-up needed. If it diverges (e.g., `server.tool` or untagged), tighten the parser based on what's observed. Not a design block.

## Rollout

Single PR, ~400-500 LOC including tests. Estimate ~2 days of focused work, broken roughly into:

- Day 1: Provider implementation + unit tests + capability-matrix rows + fake-sdk install path
- Day 2: Bootstrap wiring + slash command + e2e (solo dispatch + tier enforcement) + README

After merge:
- README documents Cursor as available; CURSOR_API_KEY required; `bun add @cursor/sdk` to enable
- Doctor's JSON output surfaces cursor's registered/missing state
- Existing claude/codex paths untouched (verified by full e2e suite still passing)

## Follow-ups explicitly scheduled

- **P1.1**: Enable Cursor session resume. Wire `canResume` to query session-store; on hit, `Agent.resume(agentId)` instead of `Agent.create`. Once dogfooded for a week.
- **P3**: N-way mode generalization. Per the 2026-05-08 spec — generalize `parallel` and `chatroom` from 2-tuple-hardcoded to variadic. Most valuable now that Cursor exists.
- **Modular SDK install**: Graduate `@anthropic-ai/claude-agent-sdk` and `@openai/codex-sdk` to `optionalDependencies` too. Symmetry win + smaller default install footprint. Touch package.json, bootstrap, and the build pipeline.

These are not in this PR. Listed so the next person knows the natural sequencing.

## Out of scope (with reasoning)

- **P2 (Claude API direct provider)** — explicitly deferred in the 2026-05-08 spec. Re-enable only on user request.
- **Cloud agents** (`Agent.create({cloud: {...}})`) — Cursor SDK supports cloud-VM runs (`local: undefined`, `cloud: {...}`). Could be useful for privacy (Cursor agent runs on Cursor's infra, not the user's daemon host). Defer to a P1.5 — needs separate config + billing-implication think-through.
- **Cursor dashboard integration** — Cursor's own dashboard surfaces agents/runs/billing. Could deep-link from wechat-cc's dashboard. Defer.
- **Cross-provider session migration** — start a conversation on Claude, continue on Cursor with shared history. Each provider's session jsonl is opaque to the others; would require a normalized conversation history layer. Out of scope.
- **Auto-fallback** — if Cursor is down, route to Claude. Explicit user choice via slash commands is the model. Not in this PR.

## Acceptance gate

P1 done when ALL of the following hold:

- [ ] User sends `/cursor` in WeChat → next message dispatched to Cursor SDK
- [ ] Cursor agent calls `mcp__wechat__reply` (or whatever its tool format is) → outbound `sendmessage` in WeChat
- [ ] Cursor agent calls `share_page` → URL returned via the cloudflared tunnel, page renders
- [ ] `dispatch-solo-cursor.e2e.test.ts` passes
- [ ] `user-tier-cursor.e2e.test.ts` passes — admin gets sandbox off, guest gets sandbox on, distinct snapshots
- [ ] Doctor's JSON output reports cursor's state (registered / SDK missing / API key missing)
- [ ] Bootstrap logs are clean — one of three messages per boot ("registered" / "SDK not installed" / "API key not set")
- [ ] `bun add @cursor/sdk` enables Cursor with no other code change required (modular install works as advertised — for Cursor; claude/codex symmetric graduation is a follow-up)
- [ ] capability-matrix's boot-time `assertMatrixComplete` enforces cursor row coverage when cursor is registered
- [ ] README has the "Cursor tier enforcement is coarsest" caveat in `Known limitations`
- [ ] Full unit + e2e suite passes; no regression in claude / codex paths
