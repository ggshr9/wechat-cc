# User-Tier Permissions + Per-Chat Session Isolation — Design

**Date**: 2026-05-22
**Status**: Design approved; implementation pending (writing-plans next)
**Why this design**: the daemon currently treats every chat as if it has the operator's full permissions. A friend who can DM the bot (`access.json:allowFrom`) can — via prompt injection or just plain asking — get the AI agent to run `Bash`, edit files, fetch URLs. That's because (a) `makeCanUseTool`'s decisions don't consider who sent the message, (b) `lastActiveChatId` is what receives permission prompts, so a guest can self-approve, and (c) all chats share the same `(alias, provider)` session, so a guest inbound runs in the same SDK process as the admin's last admin-tier turn. This design closes all three holes with a single, unified abstraction.

## Goal

Three concurrent properties:

1. **Tier-based capability gating**: the operator declares each WeChat contact as `admin` / `trusted` / `guest` in `access.json`. The agent's available tools differ by tier. Guests can chat, read their own memory, and that's it. Trusted users get everything except destructive operations (rm, git reset --hard, etc.), which prompt the admin. Admins are uncapped.

2. **Per-chat session isolation**: each `(alias, provider, chatId)` triple gets its own SDK session and its own jsonl. Tier enforcement requires this — a guest can't be allowed to acquire an admin-tier session via reuse — and it incidentally provides the storage substrate for a future audit panel.

3. **Permission prompts route to admins, not the requesting chat**: when the SDK asks "can Claude run Bash?", that prompt goes to a configured admin chat, not to whoever triggered the tool call.

**Non-goal**: audit panel UI (deferred — the per-chat jsonl substrate is built here, but the dashboard view that browses it ships in a follow-up). Codex per-tool gating beyond what `sandboxMode` + `approvalPolicy` already give (codex SDK has no per-tool callback; we accept coarser enforcement on that provider). Multi-admin quorum / approval routing beyond "send to the configured admin chat".

## Architecture

```
inbound msg
   │
   ├─ chatId ─► resolveTier(chatId, access)  → 'admin' | 'trusted' | 'guest'
   │                       │
   │           ┌───────────┴───────────┐
   │           ▼                       ▼
   │   tierProfile := TIER_PROFILES[tier]   (daemon SoT)
   │           │
   ▼           ▼
sessionManager.acquire({ alias, path, providerId, chatId, tierProfile })
                                                            │
   ┌─ cache hit on (alias, provider, chatId): reuse session
   └─ miss: provider.spawn(project, { tierProfile, resumeSessionId? })
              │
              ├─ ClaudeProvider:  tierProfileToSdkOpts(tp) → { permissionMode, disallowedTools, canUseTool }
              └─ CodexProvider:   tierProfileToSdkOpts(tp) → { sandboxMode, approvalPolicy }
```

The chain has **one input** (chatId) and **two unified abstractions** (`TierProfile`, the `tierProfileToSdkOpts` per-provider pure function).

### Core abstractions

#### `ToolKind` taxonomy (daemon-level)

Each tool the agent can invoke maps to a daemon-defined `ToolKind`. Provider-specific tool names (`Bash`, `Read`, `mcp__wechat__reply`, codex's internal shell call, ...) collapse to a fixed set:

```ts
export type ToolKind =
  | 'reply'              // mcp__wechat__reply
  | 'share_page'         // mcp__wechat__share_page
  | 'memory_read'        // mcp__wechat__memory_list / memory_read
  | 'memory_write'       // mcp__wechat__memory_write / memory_edit
  | 'memory_delete'      // mcp__wechat__memory_delete (if exposed)
  | 'observations_read'  // mcp__wechat__observations_list / observations_read
  | 'observations_write' // mcp__wechat__observations_write / observations_archive
  | 'fs_read'            // Read / Glob / Grep / LS
  | 'fs_write'           // Write / Edit / NotebookEdit
  | 'shell'              // Bash / KillShell (non-destructive form)
  | 'shell_destructive'  // virtual kind — surfaced by canUseTool when the Bash input matches a destructive pattern
  | 'network'            // WebFetch / WebSearch
  | 'subagent'           // Task
```

This taxonomy is the bridge between business policy (in `user-tier.ts`) and SDK reality (in each provider). New tools added later must declare their `ToolKind`.

#### `TierProfile` (daemon-level policy)

```ts
export interface TierProfile {
  /** Direct-allow. */
  allow: ReadonlySet<ToolKind>
  /** Prompt the admin chat before allowing; on deny, the tool call returns deny. */
  relay: ReadonlySet<ToolKind>
  /** Direct-deny — caller sees a tool error. */
  deny: ReadonlySet<ToolKind>
}
```

`allow ∪ relay ∪ deny` must equal the full `ToolKind` set; the three are disjoint. Default profiles:

| ToolKind | admin | trusted | guest |
|---|:---:|:---:|:---:|
| reply | allow | allow | allow |
| share_page | allow | allow | allow |
| memory_read | allow | allow | allow |
| observations_read | allow | allow | allow |
| memory_write | allow | allow | deny |
| observations_write | allow | allow | deny |
| memory_delete | allow | **relay** | deny |
| fs_read | allow | allow | deny |
| fs_write | allow | allow | deny |
| shell | allow | allow | deny |
| shell_destructive | allow | **relay** | deny |
| network | allow | allow | deny |
| subagent | allow | allow | deny |

`shell_destructive` is a virtual `ToolKind`. The real tool is `Bash`; at canUseTool time, the daemon inspects `input.command` and re-classifies as `shell_destructive` if a destructive pattern matches. v1 patterns: `\brm(\s|$)`, `\brm\s+-r`, `git\s+reset\s+--hard`, `git\s+push\s+.*--force`, `git\s+branch\s+-D\b`. This is best-effort (a determined adversary can `eval $(echo r)m -rf`); the goal is preventing accidents, not stopping a malicious admin.

#### `UserTier` + `resolveTier`

```ts
export type UserTier = 'admin' | 'trusted' | 'guest'

export function resolveTier(chatId: string, access: Access): UserTier {
  if (access.admins?.includes(chatId)) return 'admin'
  if (access.trusted?.includes(chatId)) return 'trusted'
  return 'guest'  // any allowed chat that's not admin/trusted defaults to guest
}
```

`access.json` schema gains an optional `trusted: string[]`. Existing files without that field default everyone in `allowFrom \ admins` to `guest` — backwards-compatible, and the default direction is safe (fewer privileges).

## Module layout

| File | Status | Responsibility |
|---|---|---|
| `src/lib/access.ts` | modify | `Access` interface gets optional `trusted?: string[]`. Reader caches it like the existing fields. |
| `src/core/user-tier.ts` | new | `UserTier`, `ToolKind`, `TierProfile`, `TIER_PROFILES`, `resolveTier`, `classifyToolUse(name, input): ToolKind`. **Single source of truth for tier policy.** |
| `src/core/user-tier.test.ts` | new | resolveTier coverage; classifyToolUse including the destructive-Bash patterns; profile disjointness invariant. |
| `src/core/agent-provider.ts` | modify | `ProviderEntry.spawn` signature changes from `spawn(project, opts?)` to `spawn(project, { tierProfile, resumeSessionId? })`. `tierProfile` is required. |
| `src/core/claude-agent-provider.ts` | modify | New pure function `tierProfileToSdkOpts(tp)` returning the SDK's `{ permissionMode: 'default' \| 'bypassPermissions', disallowedTools, canUseTool }`. spawn() calls it. Note: "permissionMode" here is the **claude-agent-sdk** option, not the daemon's `PermissionMode` enum (`'strict' \| 'dangerously'`) used in capability-matrix. |
| `src/core/codex-agent-provider.ts` | modify | New pure function `tierProfileToSdkOpts(tp)` returning `{ sandboxMode, approvalPolicy }`. spawn() calls it. **Lossy mapping** — see "Codex tier limitations" below. |
| `src/core/session-store.ts` | modify | Primary key `(alias, provider)` → `(alias, provider, chat_id)`. DB migration adds `chat_id TEXT NOT NULL`, backfills existing rows with `'_legacy'` (pre-migration mixed-chat data isolated). |
| `src/core/session-manager.ts` | modify | `acquire` / `release` / `isInFlight` / `shutdown` switch to options-object signatures including `chatId` + `tierProfile`. In-flight map keyed by 3-tuple. |
| `src/core/conversation-coordinator.ts` | modify | Dispatch path threads chatId + computes tierProfile (via resolveTier + TIER_PROFILES), passes to manager.acquire. |
| `src/core/permission-relay.ts` | modify | Two changes: (a) `makeCanUseTool` accepts a `tierProfile` + a `classifyToolUse` and uses `effectivePolicy()` below; (b) `defaultChatId` reader is replaced by `adminChatId` reader described in "Permission routing". |
| `src/daemon/bootstrap/index.ts` | modify | Wires `resolveAdminChatId` into makeCanUseTool. The relay's destination chat is no longer `lastActiveChatId`. |
| `src/daemon/wiring/tick-bodies.ts` | modify | Push/introspect tick paths now read companion config's `default_chat_id`, resolve its tier (always `admin` in practice — guest's default chat doesn't make sense — but the code does the lookup for uniformity), and pass it to manager.acquire. |
| `src/daemon/wiring/pipeline-deps.ts` | modify | Inbound pipeline carries chatId into the dispatch call. |
| `src/lib/db.ts` | modify | Add migration #N that ALTERs sessions table: add `chat_id` column, drop old `(alias, provider)` PK, recreate as `(alias, provider, chat_id)`. |

Files **unchanged**: `capability-matrix.ts` (mode × provider × perm is orthogonal to tier — they combine at decision time, see "Two-layer policy combine"), `companion/config.ts`, `companion/lifecycle.ts`, anything in `daemon/companion/`.

## Data flow (request lifecycle)

1. **Inbound arrives.** `pipeline-deps.ts` calls `coordinator.dispatch(msg)`.
2. **Coordinator resolves tier.** `const tier = resolveTier(msg.chatId, loadAccess()); const tp = TIER_PROFILES[tier]`.
3. **Coordinator acquires session.** `manager.acquire({ alias, path, providerId, chatId: msg.chatId, tierProfile: tp })`.
4. **Manager looks up `(alias, provider, chatId)`.** Hit → reuse handle. Miss → `provider.spawn(project, { tierProfile: tp, resumeSessionId? })`.
5. **Provider translates `tierProfile` to SDK options** via `tierProfileToSdkOpts(tp)`. For Claude that includes a `canUseTool` callback closed over `tp` + `classifyToolUse`. The callback is per-spawn — admin sessions get an `'allow-all'` callback (or no callback at all if `permissionMode = 'bypassPermissions'`), guest sessions get a callback that denies anything outside `tp.allow`.
6. **Dispatch fires.** SDK runs. Tool calls hit the closure, which calls `effectivePolicy(base, tp, classifyToolUse(name, input))`. Decisions: `'allow'` → return allow; `'relay'` → ask the admin chat via the existing relay; `'deny'` → return deny with a structured reason ("guest tier may not use `<tool>`").
7. **Permission relay (when `'relay'`).** Sends a prompt to **the configured admin chat** (see next section), waits for `allow` / `deny` / `timeout`, returns the SDK decision.

## Permission routing

Currently `bootstrap/index.ts:236` sets `defaultChatId: () => deps.lastActiveChatId()`. This means a guest's tool call asks the *guest* for permission. Replace with:

```ts
function resolveAdminChatId(access: Access, companionConfig: CompanionConfig): string | null {
  // Priority 1: companion config's default_chat_id IF it's admin
  if (companionConfig.default_chat_id && access.admins?.includes(companionConfig.default_chat_id)) {
    return companionConfig.default_chat_id
  }
  // Priority 2: first admin in access.json
  return access.admins?.[0] ?? null
}
```

If `null`: tier `relay` decisions degrade to `deny` with a log entry `[PERMISSION] no admin chat configured — denying ${toolName} for ${tier} tier`. This is rare (any non-trivial install has an admin) and silent-deny is safer than auto-allow.

The relay throttle (existing `auth_failed_notice` patterns) carries over — the admin sees at most one prompt per `(tool, hash)` even if Claude retries.

## Two-layer policy combine

`capability-matrix.ts` describes mode × provider × perm semantics (always was). It says things like "in chatroom mode, replyPrefix is always". It's orthogonal to tier.

The combine point is `effectivePolicy()` inside `permission-relay.ts`:

```ts
function effectivePolicy(
  base: Capability,        // from capability-matrix lookup
  tp: TierProfile,
  kind: ToolKind,
): 'allow' | 'relay' | 'deny' {
  // tier takes precedence; matrix only affects the 'allow' branch
  if (tp.deny.has(kind)) return 'deny'
  if (tp.relay.has(kind)) return 'relay'
  // tier says allow; defer to matrix's per-tool relay setting
  return base.askUser === 'per-tool' ? 'relay' : 'allow'
}
```

Reading: tier deny is hard deny. Tier relay is hard relay. Tier allow defers to matrix — if the matrix says this `(mode, provider, perm)` runs per-tool prompts (Claude solo strict, e.g.), allow becomes a relay; if matrix says never (Claude dangerously, Codex), allow stays allow. The matrix's existing `askUser` field is preserved verbatim.

## Codex tier limitations

The Codex SDK exposes only `sandboxMode` (`read-only` | `workspace-write` | `danger-full-access`) and `approvalPolicy` (`untrusted` | `on-request` | `never`). There is no per-tool callback equivalent to Claude's `canUseTool`. Consequences:

| Tier | Codex mapping | Effect |
|---|---|---|
| admin | `{ sandboxMode: 'danger-full-access', approvalPolicy: 'never' }` | Full equivalence with Claude admin. |
| trusted | `{ sandboxMode: 'workspace-write', approvalPolicy: 'never' }` | Sandbox blocks writes outside cwd. We do **not** use `approvalPolicy: 'on-request'` — there's no admin-side surface to field a Codex approval prompt, and selecting it would hang the SDK on its first attempt. **Destructive shell within the workspace remains possible** (no equivalent of Claude's `shell_destructive` interception). Documented limitation. |
| guest | `{ sandboxMode: 'read-only', approvalPolicy: 'untrusted' }` | Sandbox blocks all writes + network; `untrusted` policy makes the SDK request approval for anything risky (and we deny by not responding, which the SDK treats as deny on timeout). Functionally the agent can `reply` and read the workspace, nothing else. |

The lossy mapping means: **Codex tier enforcement is coarser than Claude's. The README must say this.** For installations that route guests to Codex, the operator should know that the guarantees are "Codex SDK sandbox", not "wechat-cc tier policy". Adding a `forbidden` flag on guest/trusted × codex matrix cells to outright refuse those combinations was considered and rejected — better to offer best-effort enforcement than to lock guest users out of one provider entirely.

## Session invalidation on access.json change

`access.ts` already caches with a 5-second TTL. Extend the cache miss to detect schema-affecting changes:

```ts
// access.ts (new behavior)
let lastSnapshot: Access | null = null
let invalidator: (() => void) | null = null

export function setSessionInvalidator(fn: () => void) { invalidator = fn }

export function loadAccess(): Access {
  const fresh = readAccessFile()
  if (lastSnapshot && tierMembershipChanged(lastSnapshot, fresh)) {
    invalidator?.()
  }
  lastSnapshot = fresh
  return fresh
}

function tierMembershipChanged(a: Access, b: Access): boolean {
  return !setEq(a.admins ?? [], b.admins ?? []) ||
         !setEq(a.trusted ?? [], b.trusted ?? []) ||
         !setEq(a.allowFrom ?? [], b.allowFrom ?? [])
}
```

`bootstrap/index.ts` calls `setSessionInvalidator(() => sessionManager.shutdown())` early. Shutdown clears the in-memory session table; the next `acquire` re-spawns with the new tier. Stored session_ids in SQLite are NOT cleared (resume still works if the chat's tier didn't change, since `spawn(project, { tierProfile, resumeSessionId })` will run resume + reconfigure tier on the resumed session — and if the SDK doesn't honor a mid-session tier change, the next turn's tool call still hits the new `canUseTool` closure, so enforcement is correct even on stale-resumed sessions).

The reasoning: tier change is rare (operator deliberately re-classifying a friend). A full re-spawn on every access edit is acceptable — pays a one-time cold-start across active chats. Log it: `[ACCESS] tier membership changed — invalidated ${N} live sessions`.

## Migration

### Code-side migration
- `Access` interface change is backwards-compatible (new field optional).
- `ProviderEntry.spawn` signature change is breaking for third-party providers (none exist yet — only `claude` + `codex` are registered). Both are updated in this change.
- `acquire/release/isInFlight` signature changes from positional to options-object. Mass refactor — straightforward but touches all call sites (coordinator dispatch + 2 tick bodies + 1 lifecycle).

### DB migration (sessions table)
- Migration v10 (next after the current v9 in `src/lib/db.ts`) adds `chat_id TEXT NOT NULL DEFAULT '_legacy'`.
- Drops the old `PRIMARY KEY (alias, provider)`; recreates as `PRIMARY KEY (alias, provider, chat_id)`.
- Pre-migration rows get `chat_id = '_legacy'`. They are NOT reused by any live chat (no chatId resolves to `'_legacy'`). Cleanup: same migration appends a `DELETE FROM sessions WHERE chat_id = '_legacy' AND last_used_at < datetime('now', '-1 day')` to drop ones older than 24h — most installs will have nothing newer; the 1-day grace handles fresh upgrades mid-conversation. Newer `_legacy` rows are dropped on next acquire that finds them stale (existing TTL path already handles this). Log: `[MIGRATION] dropped ${N} pre-tier-migration session rows`.
- `migrateFromFile` legacy `sessions.json` import: existing import code reads JSON without chat_id; importer writes `chat_id = '_legacy'`. Same cleanup path applies.

### access.json migration
- No file rewrite. Adding a `trusted` array is operator-driven.
- First admin to set up gets default semantics: `admins` populated by setup wizard → admin tier; everyone else who can DM the bot → guest tier. They're encouraged (in README) to mark known/safe contacts as `trusted` when they want broader tool access.

## Testing

| Module | Unit / integration | Coverage |
|---|---|---|
| `user-tier.ts` | unit | resolveTier for all 4 cases (admin / trusted / guest / not-allowed); classifyToolUse including destructive Bash patterns; TIER_PROFILES disjointness + completeness |
| `claude-agent-provider.ts::tierProfileToSdkOpts` | unit | snapshot test: admin profile → bypassPermissions; trusted → default + canUseTool; guest → disallowedTools includes Bash/Write/Edit/Task/WebFetch/WebSearch |
| `codex-agent-provider.ts::tierProfileToSdkOpts` | unit | snapshot test: admin → danger-full-access + never; trusted → workspace-write + on-request; guest → read-only + untrusted |
| `permission-relay.ts::effectivePolicy` | unit | matrix: 3 tiers × `{tp.deny, tp.relay, tp.allow}` × `{base.askUser: per-tool, never}` |
| `session-store` | unit | upsert with (alias, provider, chat_id); get by triple; migration import yields `_legacy` chat_id |
| `session-manager` | unit | acquire/release/isInFlight all key by triple; concurrent acquire on same triple shares pending promise; differing chatId starts independent sessions |
| `conversation-coordinator` | unit | dispatch threads chatId through to acquire; tier resolution happens once per dispatch |
| `daemon e2e` | integration | new test: guest chatId sends "run ls /" → daemon replies with refusal text + emits `cron_eval_skipped`; admin chatId sends same → daemon runs the Bash and replies with output |
| `access invalidation` | unit | tierMembershipChanged returns true on admin add/remove, false on no-op rewrite |

## Edge cases & failure modes

| Case | Behavior |
|---|---|
| `access.json` has no admins | `resolveAdminChatId` returns null → `relay` decisions degrade to `deny`. Log warning at bootstrap. |
| `access.json` malformed | existing `AccessConfigCorruptError` path unchanged; daemon refuses boot. |
| Companion `default_chat_id` is a guest | unusual but possible (operator misconfiguration). Push/introspect tick still fires with guest tier — meaning the companion can't run Bash on its own chat. Probably what the operator wanted. Edge case is logged: `[COMPANION] default_chat_id is non-admin tier; tick will run with reduced capabilities`. |
| Chat goes from admin → guest mid-conversation | `tierMembershipChanged` fires → all sessions invalidated → next inbound re-spawns with the new tier. The currently-in-flight turn (if any) finishes on the old session, which is acceptable (we can't safely interrupt a partial tool call). |
| Two chats both `_default` alias, both admins | each gets its own session under (alias='_default', provider, chatId=respective). Two jsonl files. No cross-pollution. |
| Same chatId sends two messages back-to-back | `isInFlight((alias, provider, chatId))` returns true on the second; companion's push tick logic already handles this (skip + warn). For user-message dispatch, the second turn queues at the SDK level (single session, sequential). Unchanged from today. |
| Eval harness | `eval/companion/engine/daemon-shim.ts` writes the trajectory's `chat_id` into `access.admins` (currently writes `'evaladmin'`, which would become guest tier under the new resolver and break every trajectory). All trajectories run admin-tier. New tier-specific trajectories can be added later by extending the seed call. |

## Decided (formerly open)

The destructive-Bash regex set is conservative (5 patterns). Hard-coded in `user-tier.ts`. Per-install customization via `access.json:destructive_patterns: string[]` was considered and deferred — operators can file PRs to extend the canonical list; per-install customization adds config surface without a clear use case yet.

## Rollout

Single PR with everything. The change set is large but the parts are mechanically coupled — splitting into two PRs (e.g., "schema migration first, then tier policy") risks half-shipped state where the schema is migrated but enforcement isn't wired, which is more dangerous than the current state (no enforcement) because operators may think the migration secured them.

After merge:
- README "Known limitations" entry "different agents don't carry context" stays. Add a new entry: "Permission tiering is best-effort — destructive Bash command detection is regex-based and can be bypassed by a determined caller. Don't put untrusted users in `trusted` tier."
- README "Access control" section gets expanded to describe the three tiers, with an example `access.json`.
