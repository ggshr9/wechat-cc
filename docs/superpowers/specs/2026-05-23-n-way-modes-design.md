# N-way Mode Generalization (P3) — Design

**Date**: 2026-05-23
**Builds on**: `docs/specs/2026-05-08-multi-provider-extension.md` (P3 section) + `docs/superpowers/specs/2026-05-23-cursor-sdk-provider-design.md`
**Status**: Design approved; implementation pending (writing-plans next)
**Why this design rev**: the 2026-05-08 P3 sketch was written before user-tier permissions + per-chat session isolation + cursor provider shipped. This doc consolidates the spec's P3 design with the current shape of the code (`dispatchParallel` already iterates; only `dispatchChatroom` has the hard 2-tuple constraint), settles four scoping questions (Mode-level participants, default resolution, slash command grammar, legacy migration), and adds operator-visible semantics for the new commands.

## Goal

Drop the `participants.length !== 2` constraint from `parallel` and `chatroom` modes so a user can run `/chat claude codex cursor` for a real 3-way chatroom or `/parallel claude cursor` for a 2-way parallel without the claude+codex assumption. With cursor as the third registered provider, this is the load-bearing change that unlocks the multi-provider feature's user-facing value.

**Non-goals**: changing `primary_tool` (it's 2-by-definition: primary + delegate peer); raising the participant cap beyond 3 (UX experiment in P1, expand later); chatroom convergence heuristics; cross-provider session migration; smart routing.

## Why durable

The provider abstraction work from the 2026-05-07 → 2026-05-23 series (`AgentProvider`, `ProviderRegistry`, capability matrix, tier translation, per-chat sessions) was designed for N providers — only the dispatch surface kept the 2-tuple shortcut. Generalizing now exercises that abstraction at N=3 and validates the architecture works as designed. Adding a 4th provider later won't require touching the dispatch path.

## Four decisions (settled in brainstorming)

| Decision | Choice |
|---|---|
| Participants list lives on | **Mode itself** (`{ kind: 'parallel', participants?: ProviderId[] }`). Per-chat customization. |
| Default when `participants` omitted | **`registry.list()`** — all currently-registered providers. With cursor enabled the daemon registers 3; without it, 2. Self-adjusts. |
| Slash command grammar | `/chat`, `/both` keep their current "no args = use the default participants" behavior; new explicit forms `/chat <p1> <p2> ...` and `/parallel <p1> ...` accept any subset of registered providers. **No new `/all` shorthand.** |
| Legacy-row migration | DB migration adds nullable `participants` column. Persisted rows without it are read as `null`. **On first dispatch under the new code**, null is backfilled to `registry.list().slice(0, 2)` (preserves the prior "this chat was 2-way" expectation) and persisted; users who want 3-way explicitly re-issue `/chat claude codex cursor`. |

## Architecture

```
inbound msg
   │
   ▼
coordinator
   │  Mode = conversationStore.get(chatId)
   │  participants =
   │     mode.participants                              (explicit)
   │     ?? legacyBackfill(registry, conversationStore) (one-shot upgrade)
   │     ?? registry.list()                             (fresh chat — fallback default)
   │  cap to 3
   │
   ├─ kind: parallel  → dispatchParallel(msg, proj, participants, tier)
   │                     Promise.all(p ∈ participants → acquire+dispatch)
   │
   └─ kind: chatroom  → dispatchChatroom(msg, proj, participants, tier)
                         moderator picks speaker_i ∈ participants per round
                         for rounds ∈ [1, max_rounds]
```

No changes to the inbound pipeline, session-manager, provider-registry, or capability-matrix. Coordinator dispatch is the only branch that changes shape.

## Module layout

**Modified files** (no new files):

| File | Change |
|---|---|
| `src/core/conversation.ts` | `Mode` types: add `participants?: ProviderId[]` to `parallel` and `chatroom` (NOT `primary_tool`). `max_rounds?: number` stays on chatroom. |
| `src/core/conversation-coordinator.ts` | (a) Add a `resolveParticipants(mode, registry, conversationStore, chatId)` helper that handles the participants → legacyBackfill → registry.list() chain + the ≤3 cap. (b) Drop the `parallelProviders.length !== 2` throw in `dispatchChatroom`. (c) Replace `parallelProviders` coordinator-level dep with per-dispatch resolution. (d) Validation in `setMode` against `mode.participants ⊆ registry.list()`. |
| `src/core/conversation-store.ts` | Read/write `participants` column. Hydrate as `string[] | null`. |
| `src/core/chatroom-moderator.ts` | Update moderator prompt to enumerate all participants by name (currently 2-coded with "the other one" phrasing). Add helper that builds the participants section of the prompt. |
| `src/daemon/mode-commands.ts` | Parse `/chat <p1> <p2> ...` and `/parallel <p1> <p2> ...`. Validate each token against the registry; reject the whole command on unknown ids. Bare `/chat` / `/both` keep current semantics. |
| `src/lib/db.ts` | Migration v11: add `participants` column to `conversations` (nullable TEXT, stores JSON-encoded `string[]`). |
| `README.md` | Update `/chat` documentation to describe the N-way grammar + 3-participant cap. |

**Files unchanged**: provider registry, capability matrix, session manager, session store, permission relay, all provider implementations, bootstrap wiring, daemon main, fake SDK, e2e harness.

## Mode type evolution

```ts
// Before
export type Mode =
  | { kind: 'solo'; provider: ProviderId }
  | { kind: 'primary_tool'; primary: ProviderId }
  | { kind: 'parallel' }
  | { kind: 'chatroom' }

// After
export type Mode =
  | { kind: 'solo'; provider: ProviderId }
  | { kind: 'primary_tool'; primary: ProviderId }
  | { kind: 'parallel'; participants?: ProviderId[] }
  | { kind: 'chatroom'; participants?: ProviderId[] }
```

`max_rounds` stays at the daemon-config layer (existing default = 4). Adding a per-chat override is a separate UX call — defer until we see operator demand.

## Resolution rule

The coordinator computes the active participants list once per dispatch (no caching across turns — adds latency only on the cold path, never the hot path). Algorithm:

```ts
function resolveParticipants(
  mode: Mode & { kind: 'parallel' | 'chatroom' },
  registry: ProviderRegistry,
  conversationStore: ConversationStore,
  chatId: string,
): ProviderId[] {
  let list: ProviderId[]
  if (mode.participants !== undefined && mode.participants !== null) {
    list = mode.participants
  } else if (conversationStore.isLegacyMode(chatId)) {
    // First dispatch under the new code on a row that pre-dated participants —
    // preserve the user's prior 2-way expectation, persist, never backfill again.
    list = registry.list().slice(0, 2)
    conversationStore.setParticipants(chatId, list)
  } else {
    // Fresh chat, no explicit participants — use all currently registered.
    list = registry.list()
  }
  // Filter against current registry (a provider that was once registered but
  // isn't now is a configuration drift — silently drop with a log line).
  const filtered = list.filter(p => registry.has(p))
  if (filtered.length < list.length) {
    coordinator.log('COORDINATOR', `participants filtered ${list.join(',')} → ${filtered.join(',')} (registry has ${registry.list().join(',')})`)
  }
  // Hard cap at 3 in P1.
  if (filtered.length > 3) {
    coordinator.log('COORDINATOR', `participants > 3; capping at ${filtered.slice(0, 3).join(',')}`)
    return filtered.slice(0, 3)
  }
  return filtered
}
```

Failure modes:
- `filtered.length === 0` (no registered participants from the mode's list): coordinator falls back to `solo + deps.defaultProviderId` with a log line. Same fallback shape that already exists for `setMode` validation.
- `filtered.length === 1` (degenerate "1-way parallel" or chatroom): degrade to `solo + filtered[0]`. Documented; no thrown error.

## Slash command grammar

| Command | Semantics |
|---|---|
| `/chat` | Chatroom mode, `participants = undefined` → resolves at dispatch time to all registered. |
| `/chat claude codex` | Explicit 2-way chatroom — `participants = ['claude', 'codex']`. |
| `/chat claude codex cursor` | Explicit 3-way chatroom. |
| `/both` | Parallel mode, `participants = undefined` → all registered (alias retained for backward compat). |
| `/parallel claude cursor` | Explicit 2-way parallel. |

Unknown tokens (e.g. `/chat claude foo`) → command rejected with a clear error message naming the registered set. No silent fallback. Excess tokens past the 3-cap → command warning + truncation at the parse layer; the operator sees the warning in the wechat reply.

Bare `/cc` / `/codex` / `/cursor` (solo provider commands) unchanged — they don't take participant lists by definition.

## Chatroom moderator prompt update

The current moderator prompt is implicitly 2-coded — it asks the haiku model to pick "the other one" or "switch to the other speaker." For N≥3 the language must be generic.

New prompt skeleton (replace `chatroom-moderator.ts:buildModeratorPrompt`):

```
You are moderating a chatroom between {participants.length} agents: {names}.

The user's latest message:
{userText}

The conversation so far (last {N} turns):
{historyExcerpt}

Decide who speaks next. Options:
{participantList — each with displayName}
- "end" — stop the round; nothing more to say

Reply with JSON only: {"next": "<provider_id>" or "end", "why": "<short reason>"}
```

`displayName` comes from each provider's registry entry (already present). `participants.length` is enumerated by-name so the model sees all options explicitly, regardless of N=2 or N=3.

Round-cap: existing daemon-level `chatroomMaxRounds` (default 4) carries over unchanged. For N=3 the 4-round budget yields ~1.3 turns per speaker on average — typically enough for a question-and-two-responses exchange. Per-chat override (e.g. `max=6` trailing token) is a follow-up; daemon default is the lever for now.

## Persistence — DB migration v11

`conversations` table currently:
```sql
chat_id TEXT NOT NULL PRIMARY KEY,
mode_kind TEXT NOT NULL,
mode_provider TEXT,    -- solo/primary_tool's provider
mode_primary TEXT,     -- primary_tool's primary
updated_at TEXT NOT NULL,
user_id TEXT, account_id TEXT, last_user_name TEXT
```

Add:
```sql
ALTER TABLE conversations
  ADD COLUMN participants TEXT;    -- JSON array of provider ids, nullable
```

`participants` null on legacy rows → resolution rule above.

The migration is purely additive (column add with default NULL); no rebuild needed.

## Tier integration

Coordinator's existing `resolveTier(msg.chatId, loadAccess())` runs once per dispatch (pre-existing). The resolved `tierProfile` is passed to every `manager.acquire` call. Going from N=2 to N=3 means 3 `acquire` calls instead of 2 — same tier carried through to each.

No new tier-related code.

## Cursor-specific considerations

- **Cursor in 3-way chatroom**: each round picks one speaker; that speaker's session is the only one running. Cursor's lack of canUseTool doesn't matter here (the moderator's pick decision doesn't go through canUseTool).
- **Cursor in `/parallel` with 3-way fan-out**: 3 concurrent provider calls → 3× token cost. README notes the cost multiplier under the new `/chat <p1> <p2> <p3>` section.
- **Cursor's coarser tier mapping** documented in the existing README's Known Limitations carries over — if you have a guest user in a 3-way chatroom and the moderator picks cursor for them, cursor's sandbox-only enforcement applies. The chatroom's per-round speaker selection is tier-blind by design (moderator selects on conversational fit, not capability).

## Testing strategy

| Layer | What |
|---|---|
| Unit (`conversation-coordinator.test.ts`) | `resolveParticipants` for: explicit list, legacy backfill, fresh-chat default, registry-filter drop, ≤1 fallback to solo, >3 cap warning |
| Unit (slash commands) | `/chat claude codex cursor` → mode persisted with `participants: [...]`; `/parallel claude` → 1-elt list rejected at parse (require ≥2 for parallel); `/chat foo` → unknown provider error; `/chat claude codex cursor extra` → warn + truncate |
| Unit (chatroom moderator) | New prompt builder enumerates all participants by name; output JSON parses correctly; `{ "next": "<id not in participants>" }` rejected by moderator post-parse with a fallback |
| Integration | Pipeline test: 3-way chatroom with scripted moderator picks; verify the third speaker actually gets dispatched (current tests only exercise A↔B alternation) |
| DB migration | v11 is additive; pre-v11 rows hydrate with null participants/max_rounds; coordinator backfills on first dispatch |
| E2E (deferred) | Real 3-way chatroom is interesting UX-wise but expensive (3 fake SDKs scripted to converge); architecture-correctness gate is the integration test above |

## Edge cases & failure modes

| Case | Behavior |
|---|---|
| `/chat claude` (1-elt list) | Command rejected with an error reply naming the registered providers (`mode-commands.handle` returns true to suppress dispatch, sends explanatory reply): "chatroom needs ≥2 participants". For solo use `/cc`. |
| `/parallel claude` (1-elt list) | Command rejected with an error reply naming the registered providers (`mode-commands.handle` returns true to suppress dispatch, sends explanatory reply): "parallel needs ≥2 participants". |
| `/chat claude codex` then `bun remove @cursor/sdk` then daemon restart | Cursor not registered. Coordinator's filter logs drop and proceeds with claude+codex. No throw. |
| Legacy row backfill collides with new chat behavior | The "1st dispatch backfill" is one-time-per-chat. After backfill the row has explicit participants. Subsequent /chat with no args won't re-backfill (it interprets explicit participants as the desired set). |
| Two chats issue `/chat` simultaneously with cursor un-registered mid-call | Both resolve to current registry.list() at their dispatch entry. No race — registry is read-only at runtime. |
| Chatroom round picks a provider that's no longer in `participants` (model hallucinates) | Moderator JSON post-parse validates `next ∈ participants`. Mismatch → log warning, end the round (treat as "end"). Same hardening that already exists for malformed JSON. |
| `/parallel claude cursor` but cursor unregistered | Command rejected with an error reply naming the registered providers (`mode-commands.handle` returns true to suppress dispatch, sends explanatory reply) ("unknown provider: cursor") — strict during parse so the operator sees the issue immediately rather than at dispatch time. |

## Out of scope (with reasoning)

- **`/all` shorthand** — `/chat` and `/both` already mean "use the defaults" (which after this change = all registered). A third command form for the same semantic is feature creep.
- **N > 3** — moderator coherence at higher arities is untested. The cap is a UX safety net; raise it once we see real 3-way chatroom data.
- **Cross-provider session migration** — separate problem.
- **Per-provider per-round budget** — moderator decides round-by-round; no per-speaker budget.
- **Auto-failover** (if claude down, skip to codex+cursor in parallel) — explicit-only model.
- **Chatroom convergence detection** — moderator already decides "end"; no engineering on top.

## Open questions resolved

- The 2026-05-08 spec's open questions #5 (slash grammar), #6 (3-way moderator prompt), #8 (feature flag) are all resolved here (no flag; explicit grammar; named-participants prompt).

## Rollout

Single PR, ~300–400 LOC including tests. Estimate ~1.5 days:
- Day 1: Mode type + persistence migration + resolveParticipants + slash command parser + unit tests
- Day 0.5: Moderator prompt update + integration test + README docs

After merge:
- `/chat` on a daemon with cursor enabled becomes 3-way by default for fresh chats; legacy chats stay 2-way unless the operator re-issues `/chat claude codex cursor`
- Slash command parser accepts explicit participant lists for both `parallel` and `chatroom`
- Capability matrix already covers all (mode × provider × perm) combinations for the 3 registered providers — no matrix changes needed

## Acceptance gate

P3 done when:

- [ ] User in WeChat: `/chat claude codex cursor` → 3-speaker chatroom (moderator picks among 3 each round, all three observed in a 4-round transcript)
- [ ] `/parallel claude cursor` → 2-speaker parallel with `[Claude] ...` and `[Cursor] ...` prefixes
- [ ] `/chat` (no args) on a fresh chat with cursor registered → 3-way
- [ ] `/chat` (no args) on a fresh chat without cursor → 2-way (claude+codex)
- [ ] Legacy persisted chatroom row (no participants column populated) → backfills to claude+codex on first dispatch, persists
- [ ] DB migration v11 lands cleanly; pre-v11 rows readable
- [ ] Full unit + integration suite passes; no regression in claude/codex/cursor solo paths
- [ ] README documents the new `/chat <p1> ... <pN>` grammar + the 3-cap + the legacy-backfill behavior
