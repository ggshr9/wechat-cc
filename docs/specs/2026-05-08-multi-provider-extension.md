# Spec · Multi-provider extension (Cursor SDK + Claude API direct + N-way modes)

**Status**: Draft · 2026-05-08 (revised — P2 deferred 2026-05-08)
**Author**: GSR + Claude Opus 4.7 (1M context)
**Implementation**: Two active phases — P1 (Cursor provider) and P3 (N-way mode generalization). P2 (Claude API direct provider) deferred indefinitely; see "P2 deferral" note below for rationale. P1 and P3 land independently; P3 only after P1 is in.
**Predecessor context**: v0.5.14 closed the chatroom moderator paraphrase + .claude.json bleed-in chain. P2 from `2026-05-07-api-contract-and-agent-session.md` already unified the `AgentProvider` / `AgentSession` interface — adding a third provider is mechanically the same shape as adding Codex was. This spec is about whether and how to lean on that.

---

## TL;DR

Two active phases, each ~150-300 LOC of provider code plus mode-system changes:

1. **P1 — Cursor SDK provider** (Tier S): Adds `cursor` as a third registered provider. Uses `@cursor/sdk` (TypeScript, public-beta as of 2026-04-29) which **supports MCP servers natively over stdio + HTTP**, so wechat-mcp + delegate-mcp plug straight in the same way they do for Claude / Codex. User pays Cursor token-based via `CURSOR_API_KEY`. Cursor's own harness ships skills / hooks / subagents that the wechat-cc agent can leverage — meaningfully different from the existing two providers, not just another Anthropic/OpenAI wrapper.

2. **P3 — N-way mode generalization**: `parallel` and `chatroom` modes are 2-provider-hardcoded today (`parallelProviders: [ProviderId, ProviderId]`). With three+ registered providers, users want `/all` (every registered provider answers) or `/chat claude codex cursor`. The chatroom moderator already routes by selecting a speaker from a participants list — extending to N is local. Slash command parsing + persistence schema need a small evolution.

**Deferred**: P2 (Claude API direct provider) — see "P2 deferral" below.

P3 is independent of P1 in principle but only meaningful once a third provider is in.

---

## P2 deferral (2026-05-08)

P2 was originally framed as "permanently kill the `~/.claude/.claude.json` bleed-in class by going around the Claude Code CLI." After the v0.5.14 fix chain (commit `e6f40f5` pinning `model` in SDK options + commit `c096756` trimming `settingSources` to `['project','local']` + systemd env clears), the bleed-in surface is structurally closed at the symptom level. A direct `claude-api` provider would still be cleaner architecturally (no CLI subprocess, no inheritance path *at all*), but the cost-benefit shifted:

- **What we'd gain**: faster cold start (~100ms vs ~3-5s), one less moving part, structural rather than mitigated isolation
- **What we'd lose**: Claude Code's per-tool permission relay (`canUseTool`), the `claude_code` system-prompt preset, JSONL session resume that interoperates with the user's interactive Claude Code workflow

Since v0.5.14 those losses now outweigh the gains for the dogfood-maintainer use case. P2 is deferred until a concrete user-driven reason surfaces (e.g. "I want my daemon to never read `~/.claude/`, period" — a legitimate posture choice but not currently asked for).

This deferral does NOT preclude `claude-api` ever — the spec's design section is preserved below for the eventual reactivation.

### Anti-pattern: generic "any LLM API key" plugin

A natural follow-up question is "should we just support arbitrary API keys (OpenAI / Anthropic / Google / xAI / Mistral / DeepSeek) via a generic LiteLLM-style adapter?" **No.** The wechat-cc value proposition is the channel + tools + memory + chat modes — and all of those depend on rich tool calling. Raw LLM completion APIs vary widely in tool-calling shape (Anthropic's `tools`, OpenAI's `functions`, Google's `function_declarations`, etc.) and most of them don't speak MCP. A generic adapter would be ~1500 LOC of harness + per-provider mappers + tool-call format translation + ongoing maintenance per provider — and the resulting agent quality would be worse than any single SDK-backed provider.

**Better policy**: when a specific provider ships a Code-SDK-class agent runtime (with MCP support), add it as a per-provider `<vendor>-agent-provider.ts` (~200 LOC, Cursor-shaped). Don't preempt with a generic plugin system.

Concrete future candidates that could each become a Tier S provider when their SDKs ship:
- **Gemini Code SDK** (Google) — when it ships with MCP support
- **xAI Grok SDK / DeepSeek SDK / Mistral Agent SDK** — same criterion
- **Local LLM via Ollama / vLLM** — separate phase; needs a function-calling shim layer, not the generic adapter

Generic API key isn't the path. Per-provider SDK as it ships, is.

---

## Context

After v0.5.14 the framework is in a place where the *third* provider is the cheapest it'll ever be:

- `AgentProvider` interface is one method (`spawn → AgentSession`), session is `dispatch(text) → AsyncIterable<AgentEvent>`. P2 from the 2026-05-07 spec already paid this cost.
- `ProviderId = string` is open-branded. `setMode` validates against the registry, not a closed enum. Slash-command parser already accepts arbitrary provider ids.
- Today's `bootstrap/index.ts:230` registers Claude unconditionally, Codex conditionally on binary detection. Adding another conditional registration block next to Codex's is mechanical.
- agent-config.json schema accepts a `model` field per-provider via `loadAgentConfig` (extended in `e6f40f5` to also honor it for Claude). Adding `cursorModel` etc. is a one-field addition.

What was NOT cheap pre-v0.5.14:
- The chatroom moderator paraphrase issue (closed by `f7acca0` + `b69973f`) would have hit a third provider too — every speaker session needs the metadata injection. Now that the coordinator-layer fix is in place, all providers benefit equally.
- The `.claude.json` bleed-in (closed by `e6f40f5`) was a Claude-specific symptom of "daemon should not inherit interactive CLI prefs." Cursor would have had the analogous trap with `~/.cursor/`. The pattern (pin SDK options explicitly + sanitize systemd env) generalizes; new providers follow the same template.

What's still hard:
- Per-tool permission relay only Claude Code SDK exposes (`canUseTool` callback). Codex has only `approval_policy: 'never' | 'untrusted' | ...` (process-wide). Cursor SDK's docs don't surface a per-tool hook — assume coarse policy until proven otherwise.
- Session resume across daemon restart is provider-specific. Claude uses `~/.claude/projects/<alias>/<sid>.jsonl`; Codex uses thread ids stored under `~/.codex/sessions/`; Cursor uses run ids under their cloud or local workspace state. Each provider's `canResume` callback in the registry encodes the probe; new providers need to ship one.

---

## Scope

**In — P1 (Cursor SDK provider)**:
- New file `src/core/cursor-agent-provider.ts` implementing `AgentProvider` against `@cursor/sdk`'s `Agent.create({...}).run().stream()`
- Bootstrap conditional registration: skip when `CURSOR_API_KEY` is missing AND `agent-config.json` has no Cursor entry
- agent-config.json schema gains optional `cursorModel?: string` (defaults to whatever Cursor's SDK default is)
- wechat-mcp + delegate-mcp wired through Cursor's `mcpServers` inline config (same shape as Claude)
- New `cursor-agent-provider.test.ts` mirroring the existing `codex-agent-provider.test.ts` structure
- e2e: new `dispatch-solo-cursor.e2e.test.ts` mirroring `dispatch-solo-codex.e2e.test.ts`; fake-sdk gains a third mock for `@cursor/sdk`
- Documentation in `prompt-builder.ts` `multiModeAwarenessSection` to acknowledge `cursor` as a possible provider

**In — P2 (Claude API direct provider)**:
- New file `src/core/claude-api-agent-provider.ts` using `@anthropic-ai/sdk` directly (no Claude Code CLI subprocess)
- Bootstrap registers as `claude-api` (separate ProviderId from `claude`); both can coexist
- Anthropic hosted MCP wiring: register wechat-mcp + delegate-mcp via `tools` parameter on each completion call (Anthropic API supports MCP since 2026 H1)
- `agent-config.json` gains `claudeApiModel?: string` defaulting to `claude-opus-4-7` (full ID, no alias)
- Permission relay: explicitly NOT exposed (Anthropic API has no per-tool callback). Daemon falls back to coarse `dangerously` / `strict-with-confirmation-on-fallback-only`. Documented as a known difference from `claude` provider.
- Tests + e2e parallel to P1
- Slash command: `/claude-api` (with `/cc-api` alias)

**In — P3 (N-way mode generalization)**:
- `parallel` mode: drop the 2-tuple constraint. `parallelProviders: ProviderId[]` (variadic). `/all` slash command fans out to every registered provider; `/parallel claude codex cursor` is the explicit form.
- `chatroom` mode: same — moderator picks from N participants. `chatroomMaxRounds` semantics unchanged. Slash command `/chat <p1> <p2> ... <pN>` — backward compat: bare `/chat` keeps using the first 2 registered providers.
- Display: replies still get `[Display]` prefix per-speaker. With 3+ speakers in chatroom, the moderator's per-round speaker selection matters more (degenerate "round-robin all 3" doesn't make sense for triadic chatrooms).
- Persistence: `Mode.parallel` + `Mode.chatroom` types in `src/core/conversation.ts` get `participants?: ProviderId[]` field. Migration: legacy 2-tuple persisted modes interpreted as `participants: [primary, secondary]`.
- e2e: `/all` 3-way fan-out, `/chat claude codex cursor` 3-speaker chatroom

**Out**:
- VS Code Language Model API integration (requires headless VS Code instance; out of scope, see Non-goals)
- Trae Agent integration (open source, but it's a wrapper around the same Anthropic/OpenAI APIs — low differential value over what we already ship)
- Aider integration (no MCP support; would force fallback path; differential value of "surgical edits via wechat" is interesting but secondary)
- OpenHands / Cline / Continue (extension-bound or runtime-bound; not headless-friendly)
- Local LLM providers (Ollama, llama.cpp) — possible later phase, requires a function-calling shim
- Pricing / quota / token-usage UI in dashboard (each provider has its own billing; visibility is a v0.7 task)
- Auto-failover (if Claude API down, fall back to Cursor) — explicit user choice via slash commands is the model here, not opportunistic routing
- Per-message provider routing ("send images to GPT-4V, code to Claude") — would require message-content classification, out of scope
- Mode that mixes 2 providers in primary_tool style (e.g. claude+cursor) — supported as fallout from P1 but not designed for; primary_tool is a simple case of "set up delegate access to peer X" and works orthogonally

---

## P1 Design — Cursor SDK provider

### Architecture

```
                         ┌─────────────────────┐
inbound msg              │ conversation-       │
   ↓                     │ coordinator         │
mode=solo,provider=cursor│ (unchanged)         │
   ↓                     └──────────┬──────────┘
                                    │
                        ProviderRegistry.get('cursor')
                                    │
                                    ↓
                  ┌─────────────────────────────────┐
                  │ cursor-agent-provider.ts (NEW)  │
                  │   spawn() → CursorAgentSession  │
                  │   .dispatch(text)               │
                  │     → @cursor/sdk Agent.create  │
                  │     → run.stream()              │
                  │     → map to AgentEvent         │
                  └─────────────────────────────────┘
                                    │
                                    ↓
                          @cursor/sdk runtime
                            (local OR cloud)
                                    │
                                    ↓ (MCP stdio)
                  ┌─────────────────────────────────┐
                  │ wechat-mcp + delegate-mcp       │
                  │ (shared with claude / codex)    │
                  └─────────────────────────────────┘
```

### Provider implementation

```ts
// src/core/cursor-agent-provider.ts
import { Agent } from '@cursor/sdk'
import type { AgentProvider, AgentSession, AgentEvent } from './agent-provider'
import type { McpStdioSpec } from '../daemon/bootstrap/mcp-specs'

export interface CursorProviderOpts {
  apiKey: string
  model?: string  // Cursor model ID; null = SDK default
  mcpServers?: { wechat?: McpStdioSpec; delegate?: McpStdioSpec }
  /** When 'cloud', runs in Cursor's dedicated VM; 'local' uses the host's filesystem. Defaults to 'local' for daemon use. */
  runtime?: 'local' | 'cloud'
}

export function createCursorAgentProvider(opts: CursorProviderOpts): AgentProvider {
  return {
    async spawn(project) {
      const agent = await Agent.create({
        apiKey: opts.apiKey,
        model: opts.model,
        cwd: opts.runtime === 'cloud' ? undefined : project.path,
        mcpServers: {
          ...(opts.mcpServers?.wechat ? { wechat: opts.mcpServers.wechat } : {}),
          ...(opts.mcpServers?.delegate ? { delegate: opts.mcpServers.delegate } : {}),
        },
      })
      return makeCursorSession(agent)
    },
  }
}

function makeCursorSession(agent: Agent): AgentSession {
  return {
    dispatch(text: string): AsyncIterable<AgentEvent> {
      return (async function*() {
        const run = await agent.run(text)
        for await (const ev of run.stream()) {
          // Cursor SDK event shape — TBD by spike, expected to have:
          //   { type: 'text', text: string }
          //   { type: 'tool_call', server: string, tool: string, input: unknown }
          //   { type: 'run.completed', usage: {...} }
          //   { type: 'error', message: string }
          // map verbatim to AgentEvent variants.
          yield mapCursorEvent(ev)
        }
      })()
    },
    async close() { await agent.close() },
  }
}
```

### Bootstrap wiring

```ts
// src/daemon/bootstrap/index.ts (additions, after the codex registration block)
const cursorKey = process.env.CURSOR_API_KEY ?? configuredAgent.cursorApiKey
if (cursorKey) {
  deps.log('BOOT', 'cursor: API key found, registering provider')
  const cursorWechat = deps.internalApi ? wechatStdioMcpSpec(deps.internalApi, 'cursor') : null
  const cursorDelegate = deps.internalApi ? delegateStdioMcpSpec(deps.internalApi, 'claude') : null
  registry.register(
    'cursor',
    createCursorAgentProvider({
      apiKey: cursorKey,
      model: configuredAgent.cursorModel,
      mcpServers: {
        ...(cursorWechat ? { wechat: cursorWechat } : {}),
        ...(cursorDelegate ? { delegate: cursorDelegate } : {}),
      },
      runtime: 'local',
    }),
    {
      displayName: 'Cursor',
      // Cursor's run-resume semantics TBD by spike; conservatively start with no-resume.
      canResume: () => false,
    },
  )
} else {
  deps.log('BOOT', 'cursor: CURSOR_API_KEY not set — provider not registered')
}
```

### Permission model

Cursor SDK's documented surface (cursor.com/changelog/sdk-release as of 2026-04-29) does NOT expose a per-tool authorization callback. Until proven otherwise:
- `permissionMode: 'strict'` for the daemon → Cursor session runs with whatever default policy Cursor's SDK applies (likely all-tools-allowed inside the agent, since cursor.com positions the SDK as "give the agent the same access as the desktop app")
- `--dangerously` mode → same behavior (no change)
- This is a known regression from `claude` provider's per-tool relay. Document in the provider's prompt section so users know to switch to `claude` when they want fine-grained control.

If Cursor adds a per-tool hook later, it slots into the same `canUseTool` shape we already have for Claude. Until then this is a `coarse-only` provider, same status as Codex.

### Tests

Mirror codex-agent-provider.test.ts:
- spawn returns a session
- dispatch yields events from a fake `Agent.create()` mock
- close drains the underlying run
- error events become `AgentEvent.error`

E2E:
- `dispatch-solo-cursor.e2e.test.ts` mirrors `dispatch-solo-codex.e2e.test.ts`
- Adds `installFakeCursor` to `fake-sdk.ts` — same script-driven shape as claude/codex fakes
- Reply tool bridge: same internal-api POST as the Claude/Codex bridge does

---

## P2 Design — Claude API direct provider (DEFERRED — preserved for future reactivation)

### Why a separate provider, not replace `claude`?

Claude Code CLI brings real value beyond model access:
- The `claude_code` system-prompt preset (curated tool guidance, MCP-tool inlining)
- Permission relay (`canUseTool`) → per-tool `y abc12 / n abc12` in wechat
- Session resume via the same JSONL files the user's interactive Claude Code sessions use (cross-machine sync via cloud sync, dashboard correlation)

A user who values these picks `claude`. A user who wants the daemon insulated from `~/.claude/.claude.json` and OK with coarse-only permissions picks `claude-api`. Both should coexist; making one mode flip into the other is a runtime-config decision, not a build-time one.

### Provider implementation

```ts
// src/core/claude-api-agent-provider.ts
import Anthropic from '@anthropic-ai/sdk'
import type { AgentProvider, AgentSession, AgentEvent } from './agent-provider'
import type { McpStdioSpec } from '../daemon/bootstrap/mcp-specs'

export interface ClaudeApiProviderOpts {
  apiKey: string
  model: string  // full ID, no alias — e.g. 'claude-opus-4-7'
  systemPrompt: string  // built by prompt-builder; we pass it directly, no Code preset
  mcpServers?: { wechat?: McpStdioSpec; delegate?: McpStdioSpec }
}

export function createClaudeApiAgentProvider(opts: ClaudeApiProviderOpts): AgentProvider {
  const client = new Anthropic({ apiKey: opts.apiKey })
  return {
    async spawn(_project) {
      const history: Anthropic.MessageParam[] = []
      return {
        dispatch(text: string): AsyncIterable<AgentEvent> {
          return (async function*() {
            history.push({ role: 'user', content: text })
            const stream = client.messages.stream({
              model: opts.model,
              system: opts.systemPrompt,
              messages: history,
              tools: opts.mcpServers ? buildAnthropicMcpTools(opts.mcpServers) : [],
              max_tokens: 4096,
            })
            // Anthropic SDK exposes `event` listeners + final aggregate.
            // Iterate, yield AgentEvent, accumulate assistant message into history.
            for await (const ev of stream) {
              yield mapAnthropicEvent(ev)
            }
            const final = await stream.finalMessage()
            history.push({ role: 'assistant', content: final.content })
          })()
        },
        async close() { /* nothing to clean up */ },
      }
    },
  }
}
```

### Hosted MCP wiring

Anthropic's API supports MCP via the `tools` parameter (since 2026 H1; verify exact API shape during spike). The wechat-mcp / delegate-mcp stdio specs need to be translated to the API's expected shape — likely `{ type: 'mcp_stdio', name, command, args, env }`. Daemon spawns the MCP children locally; Anthropic's API hits them via stdio bridging.

If the API only supports HTTP MCP (not stdio), fallback: spin up the wechat-mcp server in HTTP mode (it's already designed dual-transport per RFC 03 §5) and pass the URL.

### Bootstrap

```ts
const anthropicKey = process.env.ANTHROPIC_API_KEY ?? configuredAgent.anthropicApiKey
if (anthropicKey) {
  registry.register(
    'claude-api',
    createClaudeApiAgentProvider({
      apiKey: anthropicKey,
      model: configuredAgent.claudeApiModel ?? 'claude-opus-4-7',
      systemPrompt: buildSystemPrompt({ providerId: 'claude-api', peerProviderId: 'codex', ... }),
      mcpServers: { wechat: ..., delegate: ... },
    }),
    {
      displayName: 'Claude API',
      canResume: () => false,  // history is in-process; daemon restart loses it
    },
  )
}
```

### Differences from `claude` provider, surfaced to users

| Capability | `claude` | `claude-api` |
|---|---|---|
| Per-tool permission relay (y/n in wechat) | ✅ | ❌ (coarse only) |
| `claude_code` system-prompt preset | ✅ | ❌ (custom prompt) |
| Cross-restart session resume | ✅ (via JSONL) | ❌ (in-process) |
| `~/.claude/.claude.json` bleed-in possible | mitigated by e6f40f5 | structurally impossible |
| Cold start | ~3-5s (CLI subprocess) | ~100ms (HTTP) |
| Fast mode (`opus[1m]`) | ✅ if user configures | configurable per-provider |
| Pricing | user's Claude Code subscription | API token-based |

A user picks `claude-api` when fast cold-start, fewer moving parts, or pure API billing matters more than session continuity / permission relay. Documented in the desktop wizard provider-pick screen (a P2 follow-up).

---

## P3 Design — N-way mode generalization

### Current state (2-provider hardcoded)

`src/core/conversation-coordinator.ts:226`:
```ts
if (parallelProviders.length !== 2) {
  throw new Error(`chatroom mode requires exactly 2 parallel providers; got ${parallelProviders.length}`)
}
const [providerA, providerB] = parallelProviders as [ProviderId, ProviderId]
```

`parallelProviders` is `[ProviderId, ProviderId]` per the Mode type. Slash command `/chat` always uses the first two registered providers. Mode persistence stores only the kind, not participant list.

### Proposed change

Mode types in `src/core/conversation.ts`:
```ts
export type Mode =
  | { kind: 'solo'; provider: ProviderId }
  | { kind: 'parallel'; participants?: ProviderId[] }       // NEW: variadic
  | { kind: 'primary_tool'; primary: ProviderId; secondary: ProviderId }  // unchanged (2 by definition)
  | { kind: 'chatroom'; participants?: ProviderId[]; max_rounds?: number }  // NEW: variadic
```

Default `participants` (when omitted): `registry.allRegistered().slice(0, 2)` — keeps backward compat for legacy persisted modes.

Coordinator changes:
- `dispatchParallel`: drop the 2-tuple destructure; `Promise.all` over the participants list
- `dispatchChatroom`: moderator already takes `participants: ProviderId[]` — its prompt already supports >2 implicitly (just hasn't been tested with it). Spike to confirm haiku-4-5 handles 3-way moderation cleanly; might need prompt updates.
- The N=3 chatroom edge cases:
  - Round-robin: not appropriate (with 3 speakers, blindly cycling burns budget). Moderator-driven selection per round.
  - max_rounds: same default 4 but might want 6 for 3-way; user-configurable.
  - "Convergence detection": with 3 speakers it's much harder to know when to end. Lean on moderator's "end" decision.

Slash commands:
- `/chat` (no args) — default 2-way, unchanged behavior
- `/chat claude codex cursor` — explicit 3-way
- `/all` — fan out to all registered providers (parallel mode shorthand)
- `/parallel claude cursor` — explicit 2-way parallel without claude-vs-codex assumption

Persistence: `participants` joins `mode_kind` / `mode_provider` / `mode_primary` columns in the conversations table. Migration: legacy rows without participants → fall back to `[claude, codex]` at load time.

### Display

`[Claude] foo` `[Codex] bar` `[Cursor] baz` — already works since `displayName` is per-registration. No change needed.

---

## Open questions

1. **Cursor SDK MCP shape** — the announcement mentions stdio + HTTP via `.cursor/mcp.json` or inline config, but the exact TypeScript API (`Agent.create({ mcpServers: ... })` vs separate `agent.registerMcpServer(...)` call) isn't documented in the changelog. Resolve by spike: install `@cursor/sdk` in a sandbox, pass our wechat-mcp stdio spec, see what the SDK accepts. If shape diverges from Claude's, write an adapter rather than refactoring the bootstrap.

2. **Cursor session resume** — does `Agent.create({ id: previousAgentId })` resume? Documentation references "agents" as durable objects (not just runs) but doesn't show a re-attach path. Spike: create an agent, terminate the SDK process, restart with the agent id — does dispatch continue cleanly? If yes, wire `canResume`. If no, document as "fresh history each daemon restart, same as `claude-api`."

3. **Anthropic API hosted MCP shape** — does `messages.create({ tools: [...] })` accept stdio MCP servers, or only HTTP? Spike: read the latest `@anthropic-ai/sdk` docs (Context7 query). If stdio works, daemon spawns the same wechat-mcp child it does today and passes process info. If only HTTP, run wechat-mcp in HTTP mode (already supported per RFC 03 §5) and pass URL.

4. **Permission relay parity** — Cursor SDK + Anthropic API direct don't expose `canUseTool`. For users running `permissionMode: 'strict'` (the default), what's the UX? Three options: (a) silently degrade to coarse, (b) reject `setMode` to `cursor` / `claude-api` when strict, (c) inject a "you're switching to a coarse-permission provider" notice. Decision deferred until P1 ships and we see how often users hit it.

5. **Slash command grammar for N-way modes** — `/chat claude codex cursor` is unambiguous when slash commands are the only verbs in the message. What if a user writes `/chat claude codex 你好`? Probably OK (`claude` `codex` recognized as participants, `你好` is excess and gets dropped or becomes the first user message). Document the grammar. Worth a unit test in mode-commands.

6. **Default chatroom moderator behavior with N=3** — moderator's existing prompt picks "the speaker that should go next" but is implicitly 2-coded ("the other one"). For 3+ participants the prompt needs to mention "all participants" by name. Re-prompt + fixture sweep.

7. **agent-config.json schema sprawl** — adding `cursorModel`, `cursorApiKey`, `claudeApiModel`, `anthropicApiKey` per-provider fields. Risk: file becomes per-provider key-value soup. Cleaner shape: nested `providers: { claude: {...}, codex: {...}, cursor: {...}, claudeApi: {...} }`. Migration cost is small — schema bump + one-time legacy-flat → nested rewrite.

8. **Should this all live behind a feature flag?** v0.5.14 just shipped a stability pass. Adding 2 new providers + N-way modes in the same release would be a lot. Recommend gating behind `WECHAT_CC_EXPERIMENTAL_PROVIDERS=1` until each phase has been dogfooded for ≥1 week. Strip the flag when the implementation is stable.

---

## Non-goals (with reasoning)

- **VS Code Language Model API** — exists (`vscode.lm.selectChatModels()`) but only callable from inside a VS Code extension running in a VS Code instance. To use it from wechat-cc we'd need to ship and orchestrate a headless VS Code process. The headless overhead + integration complexity dwarfs the value (it's calling the same underlying GitHub Copilot / Claude / GPT models we can hit directly). Skip.

- **Trae Agent** — `bytedance/trae-agent` is open source and has a CLI; it's compatible with OpenAI / Anthropic APIs. So is wrapping it equivalent to wrapping a thin layer over what we already do via the existing Codex / `claude-api` providers. Differential value is low. Worth revisiting if ByteDance ships their own model with meaningfully different characteristics + native API.

- **Aider** — surgical-edit positioning is interesting (Aider's diff-based file edits are different from Claude/Codex's free-form tool calls). But Aider has no MCP support → loses every wechat-cc tool except plain text. Defeats the purpose of integrating into wechat-cc as a channel. Could integrate via fallback-only path but the result is "Aider via wechat" with none of wechat's tools — not interesting.

- **OpenHands / Cline / Continue / Cursor IDE chat** — all extension-bound or runtime-bound. Same pattern as VS Code: their value is in the IDE; pulling them out into a headless daemon strips that.

- **Local Ollama / llama.cpp** — possible but requires a function-calling shim (most local models don't natively support MCP or even OpenAI-style function calling reliably). Phase 4 if there's user demand.

---

## Risks

**P1**: Cursor SDK is public-beta. API shape may change before GA. Mitigation: pin the version in package.json; track the SDK changelog.

**P1**: Cursor's pricing is token-based at Cursor's rate sheet. Users running `/chat` with 3 providers pay 3 backends. UX needs to be clear about who's billing what.

**P2**: Anthropic API hosted MCP support is recent and the documentation is thinner than the SDK's own. The spike (open question #3) is the gating factor. If hosted MCP turns out not to support stdio, the fallback (HTTP-mode wechat-mcp) is more plumbing.

**P3**: 3-way chatroom is a UX experiment, not just an engineering one. Users may find the result noisy / hard to follow. Recommend shipping P3 with `chatroom_max_participants` cap = 3 initially and observing real usage before raising.

**Cross-cutting**: provider-specific bugs are now possible per-provider. v0.5.14's chatroom fix injected `[chat_id:xxx]` at the coordinator layer, which is provider-agnostic ✓. But provider-specific quirks (e.g. Cursor's tool name format, Anthropic API's streaming chunk structure) need separate testing per provider. The e2e suite has to expand 1 → 4 modes per added provider — moderate test-volume growth.

---

## Implementation plan

Two active phases, each its own PR. Recommended order:

**Phase 1 (P1 — Cursor SDK provider)**: ~3 days
- Day 1: Spike — install `@cursor/sdk`, verify MCP wiring, document event shape
- Day 2: Provider implementation + unit tests (mirror codex-agent-provider.test.ts pattern)
- Day 3: Bootstrap registration + agent-config.json schema bump + e2e (`dispatch-solo-cursor.e2e.test.ts`) + docs

**Phase 3 (P3 — N-way modes)**: ~2 days, after P1 lands
- Day 1: Mode type + persistence migration; coordinator dispatch refactor (drop 2-tuple constraints); slash command grammar + tests
- Day 2: Moderator prompt updates for 3-way + e2e (3-provider parallel + 3-speaker chatroom)

Total ~5 days if done back-to-back. Feature-flagged via `WECHAT_CC_EXPERIMENTAL_PROVIDERS=1` until dogfooded; flag stripped at v0.6.0 release boundary.

P1 is independently shippable; P3 only adds value once a third provider exists.

(P2 deferred — design section above preserved for future reactivation if the cost-benefit shifts back.)

---

## Acceptance criteria (per phase)

**P1 done when:**
- `wechat-cc provider set claude --model X` syntax extends to cursor: `wechat-cc provider set cursor --model Y`
- User in wechat sends `/cursor` → next message dispatched to Cursor SDK
- Cursor agent calls `reply` MCP tool → outbound sendmessage in wechat
- Cursor agent calls `share_page` → URL returned + dashboard shows the page
- e2e `dispatch-solo-cursor.e2e.test.ts` passes
- doctor probe surfaces Cursor as a registered provider

**P2 acceptance**: deferred. Re-enable when reactivated.

**P3 done when:**
- `/chat claude codex cursor` triggers 3-speaker chatroom
- Moderator's per-round speaker selection observably routes among all 3
- `/all` parallel mode produces N replies with `[Display]` prefixes (one per registered provider)
- Mode persistence round-trips `participants: [...]` through SQLite
- Legacy 2-tuple-mode rows continue to work after migration

---

## Out of scope explicitly

- Multi-tenant pricing rollups in dashboard ("you've spent $X today across 3 providers")
- Smart routing (auto-pick provider based on message content)
- Provider failover (if X down, try Y)
- Cross-provider session migration (start in claude, continue in codex with shared history)
- Custom-model-via-API for Claude Code CLI users (already mitigated by `e6f40f5`)
- Local LLM providers (separate phase)

---

## Decision: ship this when?

**Not this week.** v0.5.14 just landed; let it bake. P1 is the most self-contained piece and could ship as v0.5.15 or v0.6.0 once the spike confirms Cursor SDK MCP wiring works. P3 follows once P1 is dogfooded.

P2 deferred — see top section. The class of "permanently kill `.claude.json` bleed-in" was structurally closed by v0.5.14's commit chain (`e6f40f5` + `c096756`), so the urgency dropped. P2 reactivates if a user explicitly asks for "daemon never reads `~/.claude/`."

Future per-provider candidates (Gemini / xAI / DeepSeek / etc.) are NOT in this spec — each gets its own `<vendor>-agent-provider.ts` PR if and when their Code-SDK-class agent runtime ships. No generic LLM-API-key plugin path; that's an explicit anti-pattern (see "Anti-pattern" subsection above).
