# Gemini agent provider (via `@google/genai`) — design

**Date**: 2026-06-04
**Status**: approved (brainstorming) → ready for implementation plan
**Backlog**: P3 "Gemini-via-ADK" (roadmap) — **reframed**: not via ADK.

## Decisions made during brainstorming

1. **Integration path = `@google/genai` in-process**, NOT ADK. The "via ADK" framing was written when ADK was Python-only; an official TS ADK (`@google/adk`) now exists but is a full agent framework that duplicates/fights this project's harness and pins Node 24.13+ (Bun-unknown). The raw unified Gemini SDK (`@google/genai`) is the pragmatic fit — we build the tool-use loop in TS, matching the existing providers.
2. **Role = a 4th first-class in-chat `AgentProvider`** (peer of claude/codex/cursor), NOT an A2A federated agent. We evaluated running Gemini as an external A2A agent and rejected it for this goal: our "A2A node" is a custom notify-only scheme (not real A2A — no JSON-RPC/tasks/streaming/round-trip), and federation would require re-exposing the daemon's `reply`/`memory` tools over the network + running a separate process + a real-A2A upgrade. In-process is lighter and lets Gemini use the daemon's tools natively. (RFC 05 already codified "A2A peer ≠ AgentProvider"; this stays true — A2A is for external delegates, the provider is for in-chat agents.)
3. **Fine-grained per-tool tier gating** (`perToolCallback: true`). Because we own the loop (unlike codex/cursor whose SDKs own it), we gate each tool call with the existing tier policy — like Claude's `canUseTool`.

## Goal

Add `gemini` as a 4th `AgentProvider` so a WeChat user can be served by Gemini (selectable, in solo/parallel/chatroom modes), using the daemon's existing MCP tools, with tier-aware permission gating.

## Non-goals (v1)

- **No ADK**, no A2A federation, no Python.
- **No session resume** across daemon restarts (`supportsResume: false`) — genai sessions are in-memory history; persisting them is deferred.
- **No Vertex AI** path in v1 (the same SDK supports it behind a config flag; deferred to "GCP auth needed").
- **Deferred to a fast follow-up** (additive, not core to "Gemini works as an agent): the desktop **wizard card** for Gemini, and the **`delegate_gemini`** peer target. v1 ships the working, selectable, tier-gated provider.

## Architecture

`src/core/gemini-agent-provider.ts` exports `createGeminiAgentProvider(opts)` and `GEMINI_CAPABILITIES`, implementing the `AgentProvider` interface (`src/core/agent-provider.ts`):
- `spawn(project, ctx): Promise<AgentSession>` — establish a session bound to a chat/tier.
- The returned `AgentSession.dispatch(text)` yields the standard `AgentEvent` stream (`init` → `text`/`tool_call`* → `result`, or `error`).

The difference from the other three providers: Claude/Codex/Cursor each wrap an SDK that **already runs the agentic loop**; `@google/genai` provides only model calls + tool-calling primitives, so **we build the loop**. That loop is the one genuinely new unit; everything else is the standard ~13-touchpoint provider integration RFC 05 describes.

### Unit boundaries (files)

- **`gemini-agent-provider.ts`** — the provider + session + the tool-use loop + event mapping. One responsibility: turn (project, ctx, user text) → `AgentEvent` stream via genai + MCP.
- **`gemini-tier.ts`** (or a function inside the provider) — `tierProfileToGeminiSdkOpts(tp, permissionMode)` pure function (sandbox/model knobs the SDK exposes; coarse) + the per-tool gate uses the existing `classifyToolUse`/`effectivePolicy` from `user-tier.ts`/`permission-relay.ts`.
- **MCP bridge** — a thin helper that connects an `@modelcontextprotocol/sdk` **client** to the daemon's wechat stdio MCP server(s) (the same servers Claude consumes), lists tools, and converts them to/from Gemini `functionDeclarations`/`functionCall`. Reused by spawn; torn down on `close()`.

## The tool-use loop (the heart)

On `spawn`:
1. Build a genai client (`new GoogleGenAI({ apiKey })`), pick the model from config (`geminiModel`).
2. Connect an MCP client (`@modelcontextprotocol/sdk`) to the daemon's wechat stdio MCP server (spawned the same way Claude's MCP server is wired — via the existing `wechatStdioMcpSpec`). `listTools()` → map each to a Gemini `FunctionDeclaration` (name, description, parameters from the tool's JSON schema). Cache the declarations + a name→MCP-tool map on the session.
3. Assemble the system instruction from the existing `buildSystemPrompt(...)` (provider-agnostic; Gemini gets the same channel rules).

Per `dispatch(text)`:
1. Append the user message to the session's running `Content[]` history.
2. Call `models.generateContentStream({ model, contents: history, config: { systemInstruction, tools: [{ functionDeclarations }], ... } })`.
3. Stream chunks: for each `text` part → emit `AgentEvent{kind:'text'}`; accumulate assistant content into history.
4. When the response contains `functionCall` parts:
   - For each call, emit `AgentEvent{kind:'tool_call', server, tool}` (server/tool parsed from the MCP tool name, mirroring `mapCursorToolName`).
   - **Tier gate**: run the existing tier policy (`classifyToolUse(tool)` → allow / relay-to-admin / deny) for `ctx.chatId`/`ctx.tierProfile`. On **deny**, synthesize a `functionResponse` of `{ error: 'denied by tier policy' }` (the model sees the refusal and continues). On **relay**, route through the existing admin-relay path (same mechanism `canUseTool` uses) and respect the decision. On **allow**, execute.
   - Execute allowed calls via the MCP client (`callTool(name, args)`), build `functionResponse` parts.
   - Append the model's `functionCall` turn + the `functionResponse` turn to history, and **loop back to step 2** (another `generateContentStream`) until the model returns a turn with no `functionCall`.
5. Emit `AgentEvent{kind:'result', sessionId, numTurns, durationMs}`. The session id is a generated UUID (no SDK-native resumable id in v1).

`cancel()` aborts the in-flight `generateContentStream` + any running tool via an `AbortController`. `close()` disconnects the MCP client and frees the genai client.

Auth-fail detection: map genai's auth/permission errors (and a text-regex fallback like the other providers) → `AgentEvent{kind:'error', code:'auth_failed'}` so the daemon surfaces it consistently.

## Tier translation + gating

- `tierProfileToGeminiSdkOpts(tp, permissionMode)` — pure. `dangerously` → no gate (full tool access). `strict` → the per-tool gate is active; the function returns any model-level knobs (e.g. safety settings) but the real enforcement is the per-call gate (since we own the loop). Follows the signature shape of the other three translators.
- The per-call gate **reuses** `user-tier.ts` (`classifyToolUse`, `TIER_PROFILES`) and `permission-relay.ts` (`effectivePolicy`, the admin-relay routing) — no new tier logic. `GEMINI_CAPABILITIES.perToolCallback = true`.
- `GEMINI_CAPABILITIES` (4 fields per `ProviderCapabilities`): `perToolCallback: true`, `sandboxLevels: new Set()` (no SDK sandbox — enforcement is via the tool gate, like Claude), `supportsDelegation: false` (v1 — `delegate_gemini` deferred), `supportsResume: false`.

## MCP consumption

Gemini consumes the daemon's **existing** wechat stdio MCP server (the one Claude uses) via the standard `@modelcontextprotocol/sdk` client (NOT genai's experimental built-in `mcpToTool`, which is flagged experimental and Bun-risky). This reuses the daemon's tool surface (reply, memory, share_page, a2a_send, …) with zero new tool wiring. Tool name parsing/`server` extraction mirrors `mapCursorToolName`.

## Auth & packaging (mirror Cursor)

- `@google/genai` + `@modelcontextprotocol/sdk` as **`optionalDependencies`**; dynamic-imported at boot inside a try/catch (install hint on failure: `bun add @google/genai @modelcontextprotocol/sdk`).
- Boot guard: register Gemini only if `process.env.GEMINI_API_KEY` (or `GOOGLE_API_KEY`) is set **and** `agent-config.json` has `geminiModel`. Fail-fast message if key set without model (parallel to Cursor's `cursorModel` guard).
- New config field `geminiModel?: string` on `AgentConfigSchema`.

## cheapEval

Implement `cheapEval(prompt)` as a one-shot, no-tools `generateContent` on a Flash model (`gemini-flash-latest`, overridable via `WECHAT_GEMINI_CHEAP_MODEL`). Register in `CHEAP_EVAL_PREFERENCE` (`provider-registry.ts`) at the right cost position so Gemini-only users power chatroom moderation / companion introspect.

## Integration touchpoints (the ~13 places — from RFC 05 + the codebase)

**New:** `src/core/gemini-agent-provider.ts` (+ tier helper + MCP bridge).
**Edit:** `src/core/capability-matrix.ts` (one `CAPABILITIES_BY_PROVIDER` row); `src/daemon/bootstrap/index.ts` (registration + guard + MCP spec wiring); `src/lib/agent-config.ts` (`AgentProviderKind` union + `z.enum` + `geminiModel` field + resolution); `src/cli/schema.ts` (`AgentProviderKind` enum); `src/daemon/mode-commands.ts` (`/gemini` slash alias + the `支持:` message); `cli.ts` (`provider set gemini` guard + HELP_TEXT); `src/cli/doctor.ts` (gemini check + install action); `src/core/provider-registry.ts` (`CHEAP_EVAL_PREFERENCE`); `src/daemon/provider-display-names.ts` (`gemini: 'Gemini'`); `src/daemon/bootstrap/index.ts:171` (`BootstrapDeps.agentProviderKind` if gemini default-injectable); `src/daemon/__e2e__/harness.ts` (provider union).
**Already provider-agnostic (no change):** `ProviderId = string`, the delegate stdio MCP server (`WECHAT_DELEGATE_PEER`), internal-api `z.string()` mode fields, chatroom/coordinator/session-manager.

## Testing

- **Unit:** `tierProfileToGeminiSdkOpts` (the tier→opts mapping); the tool-loop event mapping + the per-call gate (mock the genai stream + a mock MCP client, like `codex-agent-provider.test.ts` / `cursor-agent-provider.test.ts` mock their SDKs) — assert: text→text events, functionCall→tool_call event + gate decision (allow executes, deny synthesizes error functionResponse, relay routes), multi-round loop terminates, result emitted, cancel aborts.
- **e2e:** a `user-tier-gemini.e2e.test.ts` parallel to the existing cursor/codex tier e2e (admin vs guest spawn options + gating), using a fake genai/MCP recorder in the harness.
- **Capability matrix:** the existing `assertMatrixComplete` boot check + a "gemini row exists" unit test (RFC 05 §6 ghost-gemini gate).

## Risks / open items

- **Bun compatibility of `@google/genai` and `@modelcontextprotocol/sdk`** is unverified. Both are Node-targeted; genai is HTTP/JSON (low risk), the MCP SDK already runs in this repo's context (the daemon spawns MCP servers). **Validate early** in the plan (a smoke import + a single generateContent + a single MCP listTools under Bun) before building the loop.
- **genai built-in MCP (`mcpToTool`) is experimental** — we deliberately avoid it in favor of the standard MCP client + manual functionDeclaration bridging.
- Streaming partial-text granularity and the exact `functionCall` shape across genai 2.x — pin against the installed version when wiring.

## Deferred follow-ups (post-v1)

- Desktop **wizard card** for Gemini (selectable in the 4-step wizard).
- **`delegate_gemini`** peer target (`delegate.ts` branch + bare provider construction) → `supportsDelegation: true`.
- **Session resume** (persist genai history) → `supportsResume: true`.
- **Vertex AI** auth path.
