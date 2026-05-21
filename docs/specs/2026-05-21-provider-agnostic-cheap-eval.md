# Spec — Provider-Agnostic Cheap Eval

**Status**: Draft · 2026-05-21
**Parent**: RFC 03 §3.6 (provider abstraction) + RFC 03 §4.4 (chatroom moderator)
**Expected effort**: 2–3 h
**Supersedes**: hardcoded `claude-haiku-4-5` callsites in `bootstrap/haiku-eval.ts` and `wiring/side-effects.ts`

---

## 0. Why

Two daemon features call a "cheap one-shot LLM eval" today:

1. **Chatroom moderator** (`bootstrap/haiku-eval.ts:30-37`) — routing decisions: who speaks next, what prompt, when to end.
2. **Companion introspect tick** (`wiring/side-effects.ts:60-74`) — writes observations to `memory/<chat>/observations` once per day.

Both hardcode `query({ model: 'claude-haiku-4-5', maxTurns: 1 })` from `@anthropic-ai/claude-agent-sdk`. Two real problems:

- **Codex-only users**: a user who installs Codex but not Claude has these features silently fail with `auth_failed` (Claude binary not present or unauthorised). Chatroom mode degrades to forced alternation (mediocre), introspect just logs `cron_eval_failed` events the user never sees.
- **Model rot**: when `claude-haiku-4-5` is retired or `4-6` ships, two files need a coordinated update. Easy to forget; bad failure mode (auth_failed-style errors, not 404).

A multi-provider channel (Claude + Codex today; Gemini and others later) shouldn't embed a single vendor's model name in core daemon logic.

---

## 1. Non-goals

- **Not** changing the chatroom moderator's prompt format or decision schema.
- **Not** changing the introspect prompt or `IntrospectDecision` shape.
- **Not** adding a generic "any LLM call" abstraction — only one-shot cheap eval. Full-session dispatch stays on `spawn()`.
- **Not** building a model selection UI / config flow — env override is sufficient.
- **Not** caching responses or routing across multiple providers per call.
- **Not** introducing a separate test-only fake provider — existing provider tests are enough.

---

## 2. Interface

### 2.1 `AgentProvider.cheapEval`

```ts
// src/core/agent-provider.ts

export interface AgentProvider {
  spawn(project: AgentProject, opts?: { resumeSessionId?: string }): Promise<AgentSession>
  /**
   * One-shot LLM eval used for routing / observation / decision flows that
   * don't need a full session (no tools, no memory, no chat history).
   *
   * Each provider implements with its cheapest practical model + reasoning
   * effort. Latency target ≤ 5 s for ~500-token prompts; cost target
   * ≪ $0.01 per call.
   *
   * Optional because not every provider has a lightweight one-shot path
   * (some only expose full sessions). Callers must handle `undefined`
   * with a graceful fallback (skip the eval-driven feature for that user).
   */
  cheapEval?: CheapEval
}

export type CheapEval = (prompt: string) => Promise<string>
```

### 2.2 `ProviderRegistry.getCheapEval()`

```ts
// src/core/provider-registry.ts

export interface ProviderRegistry {
  // ...existing methods...
  /**
   * Return ONE cheapEval function from the registered providers, picked
   * deterministically by cost tier (cheaper first). Returns null if no
   * registered provider implements cheapEval.
   *
   * Caller doesn't get to pick a provider — registry decides. The
   * decision is opaque to callers because routing/observation logic is
   * provider-agnostic by design.
   */
  getCheapEval(): CheapEval | null
}
```

Resolution order (deterministic, hard-coded preference list inside registry):

1. `claude` if registered and has `cheapEval` (haiku-4-5 → cheapest, lowest latency)
2. `codex` if registered and has `cheapEval` (gpt-mini, ~3-5 s subprocess)
3. Future providers in registration order

Rationale: Claude haiku is the cheapest + fastest cheap eval available today. If we get a Codex-only user, they fall to Codex. If we ever get a Gemini-only user, registry resolves Gemini.

---

## 3. Provider implementations

### 3.1 Claude (`src/core/claude-agent-provider.ts`)

```ts
import { query } from '@anthropic-ai/claude-agent-sdk'

const CLAUDE_CHEAP_MODEL = process.env.WECHAT_CLAUDE_CHEAP_MODEL ?? 'claude-haiku-4-5'

export function createClaudeAgentProvider(opts): AgentProvider {
  // ...
  return {
    async spawn(project, spawnOpts) { /* existing */ },
    async cheapEval(prompt) {
      const q = query({
        prompt,
        options: {
          model: CLAUDE_CHEAP_MODEL,
          maxTurns: 1,
          ...(opts.claudeBin ? { pathToClaudeCodeExecutable: opts.claudeBin } : {}),
        },
      })
      let text = ''
      for await (const raw of q as AsyncGenerator<SDKMessage>) {
        const msg = raw as { type?: string; message?: { content?: unknown } }
        if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
          for (const part of msg.message.content as Array<{ type?: string; text?: string }>) {
            if (part.type === 'text' && typeof part.text === 'string') text += part.text
          }
        }
      }
      // Caller (chatroom moderator etc.) handles auth_failed via the same
      // sentinel detection pattern that `makeHaikuEval` had — we DO NOT
      // hide it inside cheapEval because different callers want different
      // recovery (moderator falls back to alternation; introspect just
      // logs cron_eval_failed).
      return text
    },
  }
}
```

Env override: `WECHAT_CLAUDE_CHEAP_MODEL=claude-haiku-4-6` switches model without a code change.

### 3.2 Codex (`src/core/codex-agent-provider.ts`)

Codex SDK has no `query()` equivalent — every call spawns a CLI subprocess via `Thread.run()`. We minimise cost by:
- `modelReasoningEffort: 'minimal'`
- `webSearchMode: 'disabled'`, `networkAccessEnabled: false`
- `sandboxMode: 'read-only'`
- `approvalPolicy: 'never'`
- No MCP servers
- `Thread.run()` not `runStreamed()` (we don't care about events, only the final text)
- Fresh ephemeral Thread per call (no persistence — set `workingDirectory` to a tmpdir, `skipGitRepoCheck: true`)

**Auto-detect cheap model from user's local Codex install.** Codex CLI writes `~/.codex/models_cache.json` with full metadata for every model the user's subscription unlocks. Pick the cheapest user-selectable variant instead of hardcoding a literal that might not exist in the user's plan.

```ts
// src/core/codex-cheap-model.ts (new — pure helper, easy to test)
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

interface CodexModel {
  slug: string
  visibility?: string
  supported_in_api?: boolean
  priority?: number
}

const HARD_FALLBACK = 'gpt-5.4-mini'  // present in current default cache; updateable

export function resolveCodexCheapModel(): string {
  // 1. explicit env override always wins
  const envModel = process.env.WECHAT_CODEX_CHEAP_MODEL
  if (envModel) return envModel

  // 2. parse ~/.codex/models_cache.json — pick cheapest user-listed model
  const cachePath = join(homedir(), '.codex', 'models_cache.json')
  if (existsSync(cachePath)) {
    try {
      const cache = JSON.parse(readFileSync(cachePath, 'utf8')) as { models?: CodexModel[] }
      const eligible = (cache.models ?? [])
        .filter(m => m.visibility === 'list' && m.supported_in_api !== false)
      // Prefer the explicit `-mini` variant — universally cheaper across families.
      const mini = eligible.find(m => m.slug.includes('-mini'))
      if (mini) return mini.slug
      // Otherwise: highest priority number = least-featured (cheapest) tier
      const ranked = eligible.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
      if (ranked[0]?.slug) return ranked[0].slug
    } catch { /* fall through */ }
  }

  // 3. last resort: hard-coded literal
  return HARD_FALLBACK
}
```

Then in the provider:

```ts
import { tmpdir } from 'node:os'
import { resolveCodexCheapModel } from './codex-cheap-model'

export function createCodexAgentProvider(opts): AgentProvider {
  const factory: CodexFactory = opts.codexFactory ?? ((args) => new Codex(args))
  // Resolve once at provider construction — auto-detect picks up new
  // model cache entries on next daemon restart, which matches how the
  // user adds models (codex login → cache refreshes → restart daemon).
  const cheapModel = resolveCodexCheapModel()

  return {
    async spawn(project, spawnOpts) { /* existing */ },
    async cheapEval(prompt) {
      const codex = factory({ ...(opts.codexPathOverride ? { codexPathOverride: opts.codexPathOverride } : {}) })
      const thread = codex.startThread({
        model: cheapModel,
        modelReasoningEffort: 'minimal',
        sandboxMode: 'read-only',
        approvalPolicy: 'never',
        webSearchEnabled: false,
        webSearchMode: 'disabled',
        networkAccessEnabled: false,
        workingDirectory: tmpdir(),
        skipGitRepoCheck: true,
      })
      const turn = await thread.run(prompt)
      return turn.items
        .filter((i: ThreadItem) => i.type === 'agent_message')
        .map((i) => (i as AgentMessageItem).text)
        .join('')
    },
  }
}
```

**Resolution chain** (first hit wins):
1. `WECHAT_CODEX_CHEAP_MODEL` env (explicit override)
2. Cheapest `-mini` model from `~/.codex/models_cache.json`
3. Highest-`priority` (least-featured) eligible model from cache
4. Hard-coded `'gpt-5.4-mini'`

The verified local cache today (2026-05-21) lists `gpt-5.5 / 5.4 / 5.4-mini / 5.3-codex / 5.2` — heuristic picks `gpt-5.4-mini` automatically.

---

## 4. Resolution in `ProviderRegistry`

```ts
// provider-registry.ts

const CHEAP_EVAL_PREFERENCE: ProviderId[] = ['claude', 'codex']

export function createProviderRegistry(): ProviderRegistry {
  // ...existing...
  return {
    // ...
    getCheapEval(): CheapEval | null {
      for (const id of CHEAP_EVAL_PREFERENCE) {
        const entry = this.get(id)
        if (entry?.provider.cheapEval) return entry.provider.cheapEval.bind(entry.provider)
      }
      // Fall back: any registered provider in arbitrary order
      for (const id of this.list()) {
        if (CHEAP_EVAL_PREFERENCE.includes(id)) continue
        const entry = this.get(id)
        if (entry?.provider.cheapEval) return entry.provider.cheapEval.bind(entry.provider)
      }
      return null
    },
  }
}
```

---

## 5. Callsite refactors

### 5.1 Chatroom moderator (`bootstrap/index.ts` + delete `bootstrap/haiku-eval.ts`)

`makeHaikuEval` goes away. Bootstrap composes:

```ts
const cheapEval = registry.getCheapEval()
if (!cheapEval) {
  deps.log('BOOT', 'WARNING: no provider with cheapEval — chatroom moderator will use forced alternation only')
}
// Pass cheapEval (or undefined) to coordinator; coordinator threads it
// into the moderator. The moderator's existing fallback path (when
// haikuEval throws or is unset) handles undefined gracefully.
const coordinator = createConversationCoordinator({
  // ...
  haikuEval: cheapEval,  // was: makeHaikuEval(...)
})
```

The auth-failed detection logic that lived in `makeHaikuEval` (lines 51-54) moves up: when the moderator's `evaluateRound()` calls `cheapEval` and the result text matches `AUTH_FAIL_RE`, throw — preserving the existing fallback-to-alternation behaviour. New helper `assertNotAuthFailed(text, log)` exported from `agent-provider.ts` (shared by both callsites).

### 5.2 Introspect (`wiring/side-effects.ts` + `wiring/tick-bodies.ts`)

`makeIsolatedSdkEval` goes away. `tick-bodies.ts` `buildTickBodies` takes `registry` as a dep and resolves `cheapEval` per introspect tick:

```ts
export interface TickDeps {
  // ...
  registry: ProviderRegistry
}

async function introspectTick(): Promise<void> {
  const cheapEval = deps.registry.getCheapEval()
  if (!cheapEval) {
    deps.log('INTROSPECT', 'skip tick — no provider with cheapEval')
    return
  }
  // ...existing makeIntrospectAgent({ sdkEval: cheapEval, ... })
}
```

(Per-tick resolution rather than per-bootstrap so provider availability changes — e.g. user installed claude after daemon boot — are picked up. Cost is negligible: one map lookup.)

---

## 6. Tests

### 6.1 New

- **claude-agent-provider.test.ts** — `cheapEval returns concatenated assistant text` + `cheapEval respects WECHAT_CLAUDE_CHEAP_MODEL env override` (mocked query, assert options passed).
- **codex-agent-provider.test.ts** — `cheapEval builds an ephemeral thread with minimal reasoning + no tools` (mocked Codex factory, assert ThreadOptions).
- **codex-cheap-model.test.ts** (new helper) — covers all 4 resolution-chain rungs:
  - env override returns env value
  - cache file with mini → picks mini
  - cache file without mini → picks highest-priority eligible
  - cache file missing/corrupt → returns hardcoded fallback
- **provider-registry.test.ts** — `getCheapEval prefers claude over codex` + `returns null when no registered provider implements cheapEval` + `falls back to codex when claude not registered`.

### 6.2 Modified

- **bootstrap.test.ts / haiku-eval.test.ts** — delete `haiku-eval.test.ts`; cover the auth-failed detection in `agent-provider.test.ts` (new `assertNotAuthFailed` helper).
- **chatroom-moderator.test.ts** — no changes (moderator's interface is unchanged; `haikuEval` arg stays).
- **tick-bodies.test.ts** — replace `boot.sessionManager` mock with full `registry` mock that exposes `getCheapEval`; add a spec `introspect skips when no provider has cheapEval`.

### 6.3 Codex-only smoke

Daemon e2e test that registers ONLY codex and asserts:
- `getCheapEval()` returns codex's implementation
- Chatroom dispatch doesn't crash (moderator uses codex)
- Introspect tick fires (uses codex)

---

## 7. Migration & rollback

- **Migration**: none. No persisted state changes. Existing `claude-haiku-4-5` hardcode is replaced by env-overridable constant defaulting to the same value.
- **Rollback**: revert the merge — `query()` direct callsites had not been touched in either feature for weeks.

---

## 8. Resolved decisions

1. **Codex cheap model name** — **Resolved**: auto-detect from `~/.codex/models_cache.json`. Resolution chain: env override → `-mini` variant → highest-priority eligible model → hardcoded `gpt-5.4-mini`. See §3.2.
2. **Should `cheapEval` accept options?** — **Resolved**: NO for v1. Signature stays `(prompt) => Promise<string>`. Adding `maxTokens` / `temperature` / `systemPrompt` deferred — providers' cheap-eval defaults are sane; add when a concrete callsite needs control. Note: future addition is a breaking interface change for any provider implementing `cheapEval` (2 today, manageable).
3. **Cross-provider fallback on auth_failed?** — **Resolved**: NO. If Claude `cheapEval` throws `auth_failed`, registry does NOT transparently try Codex. Caller handles. Single-flight per call. User must explicitly switch providers (e.g. `codex login`, restart daemon) to change preference.

---

## 9. Failure modes

| Failure | Behaviour today (hardcoded haiku) | Behaviour after PR F |
|---|---|---|
| User has only Codex; runs `/chat` | Moderator throws auth_failed every round → forced alternation forever | Codex cheapEval runs; moderator gets real routing decisions |
| User has only Codex; introspect tick fires | Logs `cron_eval_failed` daily, never writes observation | Codex cheapEval runs; observation written if Codex agrees |
| User has only Claude; `claude-haiku-4-5` retired by Anthropic | Both features break with 404/auth-style errors | Env override flips model in one place; no code change needed |
| User has both providers | Claude haiku used (cheapest path) | Same (registry preference picks claude first) |
| Neither provider has cheapEval (theoretical) | (impossible today) | Chatroom forced alternation + introspect skipped + boot log warning |

---

## 10. Implementation order

Suggested commit / PR sequence (single PR, multiple commits):

1. Add `cheapEval?` to `AgentProvider` + `CheapEval` type + `ProviderRegistry.getCheapEval`. Tests for registry resolution.
2. Implement `cheapEval` in claude provider with `WECHAT_CLAUDE_CHEAP_MODEL` env. Move auth-failed detection helper to `agent-provider.ts`. Test.
3. Add `src/core/codex-cheap-model.ts` helper (auto-detect from `~/.codex/models_cache.json` with full resolution chain). Test 4 rungs.
4. Implement `cheapEval` in codex provider using the helper. Test ThreadOptions shape.
5. Refactor chatroom moderator wiring (delete `bootstrap/haiku-eval.ts`, use `registry.getCheapEval`). Update tests.
6. Refactor introspect tick wiring (delete `wiring/side-effects.ts` isolated eval, use `registry.getCheapEval`). Update tests.
7. Add Codex-only daemon e2e smoke.
8. Run full suite + tsc + depcheck + Playwright + daemon e2e.

Expected diff: ~+300 / −150 lines (10–12 files; +1 helper file).
