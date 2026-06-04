# Gemini Provider — Phase A (provider + tool-use loop) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `src/core/gemini-agent-provider.ts` — a 4th `AgentProvider` that drives Gemini via `@google/genai`, running its own tool-use loop over the daemon's wechat MCP tools, with fine-grained per-tool tier gating and a Flash `cheapEval` — fully **unit-tested in isolation** (mock genai + mock MCP client). NOT yet wired into bootstrap (that's Phase B).

**Architecture:** Unlike Claude/Codex/Cursor (whose SDKs run the agentic loop), `@google/genai` only gives model calls + tool-calling primitives, so the provider owns the loop: per `dispatch`, call `ai.models.generateContent`, emit assistant text, and for each `functionCall` run the **injected tool gate** (reusing `classifyToolUse`/`effectivePolicy`), execute allowed calls via an MCP client connected to the daemon's wechat stdio server, append the `functionResponse`, and loop until the model stops calling tools. Decoupled from bootstrap via injected `genai`/`mcp`/`gate` factories so it's unit-testable.

**Tech Stack:** TypeScript, Bun, vitest, `@google/genai` 2.8.0, `@modelcontextprotocol/sdk` 1.29.0.

**Spec:** `docs/superpowers/specs/2026-06-04-gemini-provider-design.md`. **Spike findings:** `docs/superpowers/specs/2026-06-04-gemini-spike-findings.md` (GO — genai loads under Bun; MCP bridge proven; 24 tools listed under **bare names**; live streaming/functionCall shapes pinned from docs, confirmed against the real SDK in Task 6 / Phase B).

---

## Background — pinned facts these tasks depend on

**AgentProvider interface** (`src/core/agent-provider.ts`): `spawn(project, ctx): Promise<AgentSession>`; `AgentSession = { dispatch(text): AsyncIterable<AgentEvent>; cancel?(); close() }`; `AgentEvent = {kind:'text',text} | {kind:'tool_call',server?,tool} | {kind:'init',sessionId} | {kind:'result',sessionId,numTurns,durationMs} | {kind:'error',message,code?}`. `SpawnContext = { tierProfile, permissionMode, chatId, resumeSessionId? }`. `ProviderCapabilities = { perToolCallback, sandboxLevels, supportsDelegation, supportsResume }`.

**Tier gate to reuse** (verbatim signatures):
- `classifyToolUse(toolName: string, input: Record<string,unknown>): ToolKind` — matches `mcp__wechat__<sub>` → ToolKind. **Bare MCP tool names must be normalized to `mcp__wechat__<name>` before calling it.**
- `effectivePolicy(base: Capability, tp: TierProfile, kind: ToolKind): 'allow'|'relay'|'deny'`.
- `TIER_PROFILES`, `ToolKind`, `TierProfile` from `src/core/user-tier.ts`.
- `lookup(mode, provider, permissionMode): Capability` from `src/core/capability-matrix.ts` (for `effectivePolicy`'s `base`).
- Relay enaction (Phase B builds the real one): `askUser(adminChatId, prompt, hash, timeoutMs): Promise<'allow'|'deny'|'timeout'>`.

**MCP client API** (confirmed live by the spike): `new Client({name,version},{capabilities:{}})`; `new StdioClientTransport({command,args,env})`; `await client.connect(transport)`; `await client.listTools()` → `{ tools: [{ name, description, inputSchema }] }` (inputSchema = JSON-Schema draft-07 `{type:'object',properties,required,$schema}`); `await client.callTool({ name, arguments })` → `{ content: [{ type:'text', text }], isError? }`; `await client.close()`.

**genai API** (genai 2.8.0; constructor `GoogleGenAI` confirmed by spike; the call/response shapes below are the documented genai 2.x shapes — **Task 6 confirms them against the installed SDK with a real key; the unit-test mocks define the contract the loop codes to**):
- `const ai = new GoogleGenAI({ apiKey })`
- `const resp = await ai.models.generateContent({ model, contents: Content[], config: { systemInstruction?: string, tools?: [{ functionDeclarations: FunctionDeclaration[] }] } })`
- `resp.text` → concatenated assistant text (string, possibly empty)
- `resp.functionCalls` → `Array<{ name: string, args: Record<string,unknown> }> | undefined`
- `Content = { role: 'user'|'model', parts: Part[] }`; `Part = { text } | { functionCall: {name,args} } | { functionResponse: {name, response} }`
- `FunctionDeclaration = { name, description?, parameters?: <JSON-Schema object> }`

**Design choice — non-streaming `generateContent` (not `generateContentStream`) for v1.** The spike couldn't verify streaming↔functionCall interleaving (no key). Non-streaming `generateContent` per round is deterministic and sufficient: user-facing messages go out via the `reply` MCP tool, so incremental text streaming isn't load-bearing. Streaming is a deferred enhancement (noted in the spec).

**MCP tool-name convention:** the wechat server exposes **bare** names (`reply`, `memory_read`, …). So: Gemini `FunctionDeclaration.name` = bare name; a `functionCall` for `reply` → emit `AgentEvent{kind:'tool_call', server:'wechat', tool:'reply'}` (server is always `'wechat'` — that's the only MCP server we connect); the gate classifies via `classifyToolUse('mcp__wechat__'+name, args)`; execution = `client.callTool({ name, arguments: args })`.

**Run tests with `bun run test`** (NOT `bun test`). Typecheck: `bun run typecheck`.

---

## File Structure

- **Create** `src/core/gemini-agent-provider.ts` — capabilities, tier opts, the MCP→functionDeclaration bridge, the event-mapping helpers, the tool-use loop, the session, the `createGeminiAgentProvider` factory, `cheapEval`. One responsibility: (project, ctx, text) → AgentEvent stream via genai + MCP. Decoupled via injected `genai`/`mcpConnect`/`buildGate` so it's unit-testable.
- **Create** `src/core/gemini-agent-provider.test.ts` — unit tests with mock genai + mock MCP client + fake gate.

Phase B wires it into `capability-matrix.ts`, `bootstrap/index.ts`, the `AgentProviderKind` enum, `/gemini`, doctor, etc. — out of scope here.

---

## Task 1: Capabilities + tier opts + injectable types

**Files:**
- Create: `src/core/gemini-agent-provider.ts`
- Create: `src/core/gemini-agent-provider.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/core/gemini-agent-provider.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { GEMINI_CAPABILITIES, tierProfileToGeminiSdkOpts } from './gemini-agent-provider'
import { TIER_PROFILES } from './user-tier'

describe('GEMINI_CAPABILITIES', () => {
  it('declares per-tool gating, no SDK sandbox, no delegation/resume in v1', () => {
    expect(GEMINI_CAPABILITIES.perToolCallback).toBe(true)
    expect([...GEMINI_CAPABILITIES.sandboxLevels]).toEqual([])
    expect(GEMINI_CAPABILITIES.supportsDelegation).toBe(false)
    expect(GEMINI_CAPABILITIES.supportsResume).toBe(false)
  })
})

describe('tierProfileToGeminiSdkOpts', () => {
  it('dangerously → gate disabled; strict → gate enabled (all tiers)', () => {
    expect(tierProfileToGeminiSdkOpts(TIER_PROFILES.admin, 'dangerously')).toEqual({ gateEnabled: false })
    expect(tierProfileToGeminiSdkOpts(TIER_PROFILES.admin, 'strict')).toEqual({ gateEnabled: true })
    expect(tierProfileToGeminiSdkOpts(TIER_PROFILES.guest, 'strict')).toEqual({ gateEnabled: true })
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run test src/core/gemini-agent-provider.test.ts`
Expected: FAIL — module not found / exports undefined.

- [ ] **Step 3: Create the module with capabilities + tier opts + injectable types**

Create `src/core/gemini-agent-provider.ts`:
```ts
/**
 * Gemini agent provider — drives Gemini via @google/genai.
 *
 * Unlike claude/codex/cursor (whose SDKs run the agentic loop), @google/genai
 * gives only model calls + tool-calling primitives, so THIS provider owns the
 * tool-use loop: generateContent → emit text → for each functionCall, gate it
 * (reusing classifyToolUse/effectivePolicy) and execute via an MCP client
 * connected to the daemon's wechat stdio server → append functionResponse →
 * loop until no functionCall → result.
 *
 * Decoupled from bootstrap via injected genai / mcpConnect / buildGate so the
 * loop is unit-testable. See docs/superpowers/specs/2026-06-04-gemini-provider-design.md.
 */
import type { AgentEvent, AgentProject, AgentProvider, AgentSession, PermissionMode, ProviderCapabilities, SpawnContext } from './agent-provider'
import type { TierProfile } from './user-tier'

/** RFC 05 Phase 2 capability declaration. We OWN the loop → per-tool gating is
 *  realisable (perToolCallback). No SDK sandbox (enforcement is the tool gate,
 *  like Claude). Delegation + resume deferred to a follow-up. */
export const GEMINI_CAPABILITIES: ProviderCapabilities = {
  perToolCallback: true,
  sandboxLevels: new Set(),
  supportsDelegation: false,
  supportsResume: false,
}

export interface GeminiTierSdkOpts {
  /** strict ⇒ the per-tool gate runs; dangerously ⇒ operator bypassed everything. */
  gateEnabled: boolean
}

export function tierProfileToGeminiSdkOpts(_tp: TierProfile, permissionMode: PermissionMode): GeminiTierSdkOpts {
  return { gateEnabled: permissionMode !== 'dangerously' }
}

/** A per-spawn tool gate. allow → execute; deny → synthesize an error
 *  functionResponse so the model sees the refusal. Phase B builds the real one
 *  from effectivePolicy + askUser; tests inject a fake. */
export type ToolGateDecision = { allow: true } | { allow: false; message: string }
export type ToolGate = (toolName: string, input: Record<string, unknown>) => Promise<ToolGateDecision>
```

- [ ] **Step 4: Run it to verify it passes**

Run: `bun run test src/core/gemini-agent-provider.test.ts`
Expected: PASS (both describe blocks).

- [ ] **Step 5: Typecheck + commit**

Run: `bun run typecheck` → exit 0.
```bash
git add src/core/gemini-agent-provider.ts src/core/gemini-agent-provider.test.ts
git commit -m "feat(gemini): GEMINI_CAPABILITIES + tier opts + ToolGate types"
```

---

## Task 2: MCP tools → Gemini functionDeclarations bridge

**Files:**
- Modify: `src/core/gemini-agent-provider.ts`, `src/core/gemini-agent-provider.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/core/gemini-agent-provider.test.ts`:
```ts
import { mcpToolsToFunctionDeclarations } from './gemini-agent-provider'

describe('mcpToolsToFunctionDeclarations', () => {
  it('maps MCP tools to Gemini functionDeclarations, stripping JSON-Schema meta keys', () => {
    const mcpTools = [
      { name: 'reply', description: 'reply to the user', inputSchema: { type: 'object', properties: { chat_id: { type: 'string' }, text: { type: 'string' } }, required: ['chat_id', 'text'], $schema: 'http://json-schema.org/draft-07/schema#', additionalProperties: false } },
      { name: 'ping', description: 'ping', inputSchema: { type: 'object', properties: {}, $schema: 'http://json-schema.org/draft-07/schema#' } },
    ]
    const fns = mcpToolsToFunctionDeclarations(mcpTools)
    expect(fns).toEqual([
      { name: 'reply', description: 'reply to the user', parameters: { type: 'object', properties: { chat_id: { type: 'string' }, text: { type: 'string' } }, required: ['chat_id', 'text'] } },
      { name: 'ping', description: 'ping', parameters: { type: 'object', properties: {} } },
    ])
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run test src/core/gemini-agent-provider.test.ts`
Expected: FAIL — `mcpToolsToFunctionDeclarations` not exported.

- [ ] **Step 3: Implement the bridge**

Append to `src/core/gemini-agent-provider.ts`:
```ts
export interface McpToolDef {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}
export interface GeminiFunctionDeclaration {
  name: string
  description?: string
  parameters?: Record<string, unknown>
}

/** Strip JSON-Schema meta keys Gemini rejects ($schema, additionalProperties)
 *  and reshape an MCP tool's inputSchema into a Gemini FunctionDeclaration. */
export function mcpToolsToFunctionDeclarations(tools: McpToolDef[]): GeminiFunctionDeclaration[] {
  return tools.map(t => {
    const fn: GeminiFunctionDeclaration = { name: t.name }
    if (t.description) fn.description = t.description
    if (t.inputSchema) {
      const { $schema: _s, additionalProperties: _a, ...rest } = t.inputSchema as Record<string, unknown>
      fn.parameters = rest
    }
    return fn
  })
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `bun run test src/core/gemini-agent-provider.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/gemini-agent-provider.ts src/core/gemini-agent-provider.test.ts
git commit -m "feat(gemini): MCP tools → Gemini functionDeclarations bridge"
```

---

## Task 3: The tool-use loop (the core)

**Files:**
- Modify: `src/core/gemini-agent-provider.ts`, `src/core/gemini-agent-provider.test.ts`

This task implements the heart: a `runDispatchLoop` async generator driven by injected `genai` + `mcp` + `gate` ports (so it's pure-logic + unit-testable). The factory (Task 4) wires the real ones.

- [ ] **Step 1: Write the failing test**

Append to `src/core/gemini-agent-provider.test.ts`:
```ts
import { runDispatchLoop, type GenaiPort, type McpPort } from './gemini-agent-provider'
import { collectTurn } from './agent-provider'

// A scripted genai: each generateContent call returns the next queued response.
function fakeGenai(responses: Array<{ text?: string; functionCalls?: Array<{ name: string; args: Record<string, unknown> }> }>): GenaiPort {
  let i = 0
  return {
    async generateContent() {
      const r = responses[i++] ?? { text: '' }
      return { text: r.text ?? '', functionCalls: r.functionCalls }
    },
  }
}
function fakeMcp(results: Record<string, unknown>): McpPort {
  return {
    async callTool(name) {
      return { content: [{ type: 'text', text: JSON.stringify(results[name] ?? { ok: true }) }] }
    },
  }
}

describe('runDispatchLoop', () => {
  it('emits text then result for a no-tool turn', async () => {
    const history: any[] = []
    const events = runDispatchLoop({
      genai: fakeGenai([{ text: 'hello there' }]),
      mcp: fakeMcp({}),
      gate: async () => ({ allow: true }),
      model: 'gemini-flash-latest', systemInstruction: 'sys', functionDeclarations: [],
      history, sessionId: 's1', userText: 'hi',
    })
    const summary = await collectTurn(events)
    expect(summary.assistantText.join('')).toBe('hello there')
    expect(summary.result?.sessionId).toBe('s1')
    // history now has the user turn + the model turn
    expect(history.length).toBe(2)
    expect(history[0]).toEqual({ role: 'user', parts: [{ text: 'hi' }] })
  })

  it('runs a tool round: functionCall → tool_call event → execute → functionResponse → final text', async () => {
    const history: any[] = []
    const calls: string[] = []
    const events = runDispatchLoop({
      genai: fakeGenai([
        { functionCalls: [{ name: 'reply', args: { chat_id: 'c', text: 'hi user' } }] },
        { text: 'done' },
      ]),
      mcp: { async callTool(name, args) { calls.push(`${name}:${JSON.stringify(args)}`); return { content: [{ type: 'text', text: '{"ok":true}' }] } } },
      gate: async () => ({ allow: true }),
      model: 'm', systemInstruction: 'sys', functionDeclarations: [{ name: 'reply' }],
      history, sessionId: 's2', userText: 'say hi',
    })
    const evs: any[] = []
    for await (const e of events) evs.push(e)
    // a tool_call event for reply, with server=wechat
    expect(evs.find(e => e.kind === 'tool_call')).toEqual({ kind: 'tool_call', server: 'wechat', tool: 'reply' })
    expect(calls).toEqual(['reply:{"chat_id":"c","text":"hi user"}'])
    expect(evs.some(e => e.kind === 'text' && e.text === 'done')).toBe(true)
    expect(evs.at(-1).kind).toBe('result')
    // history: user, model(functionCall), user(functionResponse), model(text) = 4
    expect(history.length).toBe(4)
    expect(history[2]).toEqual({ role: 'user', parts: [{ functionResponse: { name: 'reply', response: { content: [{ type: 'text', text: '{"ok":true}' }] } } }] })
  })

  it('denied tool: no callTool, synthesizes an error functionResponse, model continues', async () => {
    const history: any[] = []
    let executed = false
    const events = runDispatchLoop({
      genai: fakeGenai([
        { functionCalls: [{ name: 'memory_delete', args: { path: 'x' } }] },
        { text: 'ok, I will not delete' },
      ]),
      mcp: { async callTool() { executed = true; return { content: [] } } },
      gate: async (tool) => tool === 'memory_delete' ? { allow: false, message: 'denied by tier' } : { allow: true },
      model: 'm', systemInstruction: 's', functionDeclarations: [{ name: 'memory_delete' }],
      history, sessionId: 's3', userText: 'delete x',
    })
    const evs: any[] = []
    for await (const e of events) evs.push(e)
    expect(executed).toBe(false)
    expect(history[2]).toEqual({ role: 'user', parts: [{ functionResponse: { name: 'memory_delete', response: { error: 'denied by tier' } } }] })
    expect(evs.some(e => e.kind === 'text' && e.text === 'ok, I will not delete')).toBe(true)
  })

  it('caps tool rounds to avoid infinite loops', async () => {
    const history: any[] = []
    // always returns a functionCall → would loop forever without a cap
    const genai: GenaiPort = { async generateContent() { return { text: '', functionCalls: [{ name: 'ping', args: {} }] } } }
    const events = runDispatchLoop({
      genai, mcp: fakeMcp({}), gate: async () => ({ allow: true }),
      model: 'm', systemInstruction: 's', functionDeclarations: [{ name: 'ping' }],
      history, sessionId: 's4', userText: 'loop', maxRounds: 3,
    })
    const summary = await collectTurn(events)
    // terminates with a result (or error) rather than hanging
    expect(summary.result || summary.error).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run test src/core/gemini-agent-provider.test.ts`
Expected: FAIL — `runDispatchLoop` / ports not exported.

- [ ] **Step 3: Implement the loop**

Append to `src/core/gemini-agent-provider.ts`:
```ts
/** Minimal genai surface the loop needs (real: ai.models). */
export interface GenaiPort {
  generateContent(req: {
    model: string
    contents: unknown[]
    config?: { systemInstruction?: string; tools?: Array<{ functionDeclarations: GeminiFunctionDeclaration[] }> }
  }): Promise<{ text: string; functionCalls?: Array<{ name: string; args: Record<string, unknown> }> }>
}
/** Minimal MCP surface the loop needs (real: @modelcontextprotocol/sdk Client). */
export interface McpPort {
  callTool(name: string, args: Record<string, unknown>): Promise<{ content: unknown[]; isError?: boolean }>
}

export interface DispatchLoopArgs {
  genai: GenaiPort
  mcp: McpPort
  gate: ToolGate
  model: string
  systemInstruction: string
  functionDeclarations: GeminiFunctionDeclaration[]
  /** Mutated in place — the running conversation history (persists across dispatches). */
  history: unknown[]
  sessionId: string
  userText: string
  /** Safety cap on tool rounds per dispatch (default 12). */
  maxRounds?: number
}

/** The tool-use loop. Yields AgentEvents; mutates `history`. */
export async function* runDispatchLoop(args: DispatchLoopArgs): AsyncIterable<AgentEvent> {
  const startMs = Date.now()
  const cap = args.maxRounds ?? 12
  args.history.push({ role: 'user', parts: [{ text: args.userText }] })
  const config = {
    systemInstruction: args.systemInstruction,
    ...(args.functionDeclarations.length > 0 ? { tools: [{ functionDeclarations: args.functionDeclarations }] } : {}),
  }
  let rounds = 0
  try {
    while (true) {
      rounds++
      const resp = await args.genai.generateContent({ model: args.model, contents: args.history, config })
      const text = resp.text ?? ''
      const calls = resp.functionCalls ?? []

      if (text) yield { kind: 'text', text }

      if (calls.length === 0) {
        // model finished — record its text turn and stop
        if (text) args.history.push({ role: 'model', parts: [{ text }] })
        yield { kind: 'result', sessionId: args.sessionId, numTurns: rounds, durationMs: Date.now() - startMs }
        return
      }

      // record the model's function-call turn
      args.history.push({ role: 'model', parts: calls.map(c => ({ functionCall: { name: c.name, args: c.args } })) })

      // execute each call through the gate, collect functionResponse parts
      const responseParts: unknown[] = []
      for (const call of calls) {
        yield { kind: 'tool_call', server: 'wechat', tool: call.name }
        const decision = await args.gate(call.name, call.args)
        if (!decision.allow) {
          responseParts.push({ functionResponse: { name: call.name, response: { error: decision.message } } })
          continue
        }
        try {
          const result = await args.mcp.callTool(call.name, call.args)
          responseParts.push({ functionResponse: { name: call.name, response: { content: result.content } } })
        } catch (err) {
          responseParts.push({ functionResponse: { name: call.name, response: { error: err instanceof Error ? err.message : String(err) } } })
        }
      }
      args.history.push({ role: 'user', parts: responseParts })

      if (rounds >= cap) {
        yield { kind: 'result', sessionId: args.sessionId, numTurns: rounds, durationMs: Date.now() - startMs }
        return
      }
    }
  } catch (err) {
    yield { kind: 'error', message: err instanceof Error ? err.message : String(err) }
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `bun run test src/core/gemini-agent-provider.test.ts`
Expected: PASS (all four loop cases).

- [ ] **Step 5: Typecheck + commit**

Run: `bun run typecheck` → exit 0.
```bash
git add src/core/gemini-agent-provider.ts src/core/gemini-agent-provider.test.ts
git commit -m "feat(gemini): tool-use loop (generateContent → gate → MCP → functionResponse → repeat)"
```

---

## Task 4: The provider factory + session + cheapEval

**Files:**
- Modify: `src/core/gemini-agent-provider.ts`, `src/core/gemini-agent-provider.test.ts`

Wires the real genai client + an MCP-client connection + the loop into an `AgentProvider`. Construction deps are injected (genai client, an `mcpConnect` that returns `{ port, listTools, close }`, and a `buildGate(ctx)`), so the factory is unit-testable without the real SDKs.

- [ ] **Step 1: Write the failing test**

Append to `src/core/gemini-agent-provider.test.ts`:
```ts
import { createGeminiAgentProvider } from './gemini-agent-provider'
import { TIER_PROFILES } from './user-tier'

describe('createGeminiAgentProvider', () => {
  function deps(genaiResponses: any[], gate = async () => ({ allow: true as const })) {
    const calls: string[] = []
    const provider = createGeminiAgentProvider({
      genai: (() => { let i = 0; return { models: { async generateContent() { return genaiResponses[i++] ?? { text: '' } } } } })() as any,
      model: 'gemini-flash-latest',
      systemInstruction: 'you are gemini',
      async mcpConnect() {
        return {
          listTools: async () => ([{ name: 'reply', description: 'r', inputSchema: { type: 'object', properties: {} } }]),
          callTool: async (name: string, args: any) => { calls.push(name); return { content: [{ type: 'text', text: '{}' }] } },
          close: async () => {},
        }
      },
      buildGate: () => gate as any,
    })
    return { provider, calls }
  }

  it('spawn → dispatch streams text + result; uses listTools as functionDeclarations', async () => {
    const { provider } = deps([{ text: 'hi from gemini' }])
    const session = await provider.spawn({ alias: 'P', path: '/p' }, { tierProfile: TIER_PROFILES.admin, permissionMode: 'strict', chatId: 'c1' })
    const out: any[] = []
    for await (const e of session.dispatch('hello')) out.push(e)
    expect(out.some(e => e.kind === 'text' && e.text === 'hi from gemini')).toBe(true)
    expect(out.at(-1).kind).toBe('result')
    await session.close()
  })

  it('cheapEval does a no-tools generateContent and returns text', async () => {
    const { provider } = deps([{ text: 'cheap answer' }])
    expect(provider.cheapEval).toBeDefined()
    const ans = await provider.cheapEval!('rate 1-10')
    expect(ans).toBe('cheap answer')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run test src/core/gemini-agent-provider.test.ts`
Expected: FAIL — `createGeminiAgentProvider` not exported.

- [ ] **Step 3: Implement the factory**

Append to `src/core/gemini-agent-provider.ts`:
```ts
/** The real genai client shape we use (ai.models.generateContent). */
export interface GenaiClient {
  models: GenaiPort
}
/** A connected MCP session: list tools + call them + close. The factory's
 *  mcpConnect builds this (real: @modelcontextprotocol/sdk Client over stdio). */
export interface McpConnection {
  listTools(): Promise<McpToolDef[]>
  callTool(name: string, args: Record<string, unknown>): Promise<{ content: unknown[]; isError?: boolean }>
  close(): Promise<void>
}

export interface GeminiAgentProviderOptions {
  genai: GenaiClient
  model: string
  systemInstruction: string
  /** Connect an MCP client to the daemon's wechat server (per spawn). */
  mcpConnect: () => Promise<McpConnection>
  /** Build the per-spawn tool gate from the SpawnContext. Phase B supplies the
   *  real one (effectivePolicy + askUser); default = allow-all (e.g. delegate). */
  buildGate?: (ctx: SpawnContext) => ToolGate
  /** cheapEval model (default = the dispatch model). */
  cheapModel?: string
}

export function createGeminiAgentProvider(opts: GeminiAgentProviderOptions): AgentProvider {
  let uuidCounter = 0
  const newSessionId = () => `gemini-${Date.now()}-${++uuidCounter}`

  return {
    async spawn(_project: AgentProject, ctx: SpawnContext): Promise<AgentSession> {
      const conn = await opts.mcpConnect()
      const mcpTools = await conn.listTools()
      const functionDeclarations = mcpToolsToFunctionDeclarations(mcpTools)
      const gate: ToolGate = opts.buildGate ? opts.buildGate(ctx) : async () => ({ allow: true })
      const sessionId = ctx.resumeSessionId ?? newSessionId()
      const history: unknown[] = []

      return {
        dispatch(text: string) {
          return runDispatchLoop({
            genai: opts.genai.models,
            mcp: { callTool: (n, a) => conn.callTool(n, a) },
            gate,
            model: opts.model,
            systemInstruction: opts.systemInstruction,
            functionDeclarations,
            history,
            sessionId,
            userText: text,
          })
        },
        async close() {
          try { await conn.close() } catch { /* swallow */ }
        },
      }
    },
    async cheapEval(prompt: string): Promise<string> {
      const resp = await opts.genai.models.generateContent({
        model: opts.cheapModel ?? opts.model,
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
      })
      return resp.text ?? ''
    },
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `bun run test src/core/gemini-agent-provider.test.ts`
Expected: PASS (all cases across all 4 tasks).

- [ ] **Step 5: Typecheck + commit**

Run: `bun run typecheck` → exit 0.
```bash
git add src/core/gemini-agent-provider.ts src/core/gemini-agent-provider.test.ts
git commit -m "feat(gemini): provider factory + session + cheapEval (injected genai/mcp/gate)"
```

---

## Task 5: Full Phase-A verification

**Files:** none

- [ ] **Step 1: Typecheck**

Run: `bun run typecheck` → exit 0 (the new module is self-contained; not yet imported anywhere, so it can't break other files).

- [ ] **Step 2: The gemini provider tests**

Run: `bun run test src/core/gemini-agent-provider.test.ts`
Expected: all green (capabilities, tier opts, bridge, the 4 loop cases, the 2 factory cases).

- [ ] **Step 3: Full unit suite (no regression)**

Run: `bun run test`
Expected: prior baseline + the new gemini tests; all green. (The module is unreferenced by production code yet, so the only delta is the new test file.)

- [ ] **Step 4: Commit (only if Steps 1–3 surfaced a fix)**

```bash
git add -A
git commit -m "chore(gemini): phase-A verification fixes"
```

---

## Task 6: Confirm the genai response contract against the real SDK (key-gated)

**Files:** none (a one-off confirmation; may be deferred to Phase B's e2e if no key now)

The loop codes to the documented genai 2.8 contract (`resp.text`, `resp.functionCalls`, the `functionResponse` part shape). The unit tests mock that contract, so they'd pass even if the real shape differs. **Confirm it once against the installed SDK with a real key.**

- [ ] **Step 1: If a `GEMINI_API_KEY` is available, write a throwaway confirm**

If no key: SKIP and record in the commit that the genai contract is confirmed in Phase B's e2e instead. If a key is available, create a temporary `scripts/gemini-contract.ts`:
```ts
import { GoogleGenAI } from '@google/genai'
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! })
const r = await ai.models.generateContent({
  model: 'gemini-flash-latest',
  contents: [{ role: 'user', parts: [{ text: 'Use the tool to get Tokyo time.' }] }],
  config: { tools: [{ functionDeclarations: [{ name: 'get_time', description: 'time for a city', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }] }] },
})
console.log('typeof r.text:', typeof r.text, '| r.text:', r.text)
console.log('r.functionCalls:', JSON.stringify(r.functionCalls))
```
Run: `GEMINI_API_KEY=<key> bun scripts/gemini-contract.ts`
- Confirm `r.text` is a string and `r.functionCalls` is `[{ name, args }]`. If the real accessors differ (e.g. `r.functionCalls` is a method, or text is `r.candidates[0]...`), **fix `GenaiPort` + the loop's `resp.text`/`resp.functionCalls` reads** in `gemini-agent-provider.ts`, update the mock in the tests to match, and re-run Step 2 of Task 5.
- Delete the throwaway: `rm scripts/gemini-contract.ts`.

- [ ] **Step 2: Commit any contract fix (or a note)**

```bash
git add -A
git commit -m "test(gemini): confirm genai 2.8 generateContent response contract"
```

---

## Self-Review notes (applied)

- **Spec coverage:** the provider + tool-use loop (spec "Architecture"/"The tool-use loop") = Tasks 3-4; tier translation + per-tool gate reuse (spec "Tier translation + gating") = Task 1 + the `gate` port wired in Tasks 3-4 (real gate built in Phase B); MCP consumption (spec) = Task 2 bridge + Task 4 `mcpConnect`; cheapEval (spec) = Task 4; `GEMINI_CAPABILITIES` = Task 1. The ~13 integration touchpoints, the wizard card, `delegate_gemini`, resume, Vertex = Phase B / deferred — out of scope here by design.
- **The injected-ports design** (`GenaiPort`/`McpPort`/`ToolGate`/`mcpConnect`/`buildGate`) is the decomposition that makes the loop unit-testable without the real SDKs and keeps the provider decoupled from bootstrap — Phase B supplies the real genai client, the real MCP-over-stdio `mcpConnect`, and the real `buildGate` (effectivePolicy + askUser).
- **Residual risk (called out, Task 6):** the genai response accessor shape (`resp.text`/`resp.functionCalls`) is documented-but-unverified-live; the unit tests prove the *loop logic* against that contract; Task 6 (or Phase B's e2e) confirms the contract against the real SDK + a key and adjusts the two accessor reads if needed.
- **No placeholders:** every step has literal code + exact commands. The `as any` casts in tests are deliberate (mocking SDK shapes), consistent with how `cursor-agent-provider.test.ts` mocks `@cursor/sdk`.
- **Type consistency:** `ToolGate`/`ToolGateDecision`, `GenaiPort`/`McpPort`, `mcpToolsToFunctionDeclarations`, `runDispatchLoop`/`DispatchLoopArgs`, `createGeminiAgentProvider`/`GeminiAgentProviderOptions`, `GEMINI_CAPABILITIES`, `tierProfileToGeminiSdkOpts` are used identically across tasks. The loop emits `{kind:'tool_call', server:'wechat', tool}` matching `isReplyToolCall`'s `server === 'wechat'` check.
