# Gemini Provider — Phase 0 Validation Spike Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** De-risk the Gemini-via-`@google/genai` provider before building it: verify `@google/genai` + `@modelcontextprotocol/sdk` run under **Bun**, and **pin the exact runtime API shapes** (streaming, function-calling, MCP client) the provider's tool-use loop will depend on. Output a written findings doc + a go/no-go.

**Architecture:** A throwaway spike script (`scripts/gemini-spike.ts`) exercises, under Bun, the four operations the real provider needs — import/instantiate genai, a streaming `generateContent`, a function-calling round-trip, and an MCP-client `listTools` against the daemon's existing wechat stdio server — and records the observed API shapes. No production code; the spike artifacts are deleted at the end, leaving only a findings doc.

**Tech Stack:** Bun, TypeScript, `@google/genai`, `@modelcontextprotocol/sdk`.

**Spec:** `docs/superpowers/specs/2026-06-04-gemini-provider-design.md`. **Why this is its own phase:** the spec's "Risks" section flags Bun-compat + the genai 2.x API surface as unverified; the provider's tool loop (Phase A, written next) needs the *real* `generateContentStream` / `functionCall` / MCP-client shapes to be no-placeholder. This spike produces them.

---

## Scope note

This is **Phase 0 of 3** for the Gemini provider:
- **Phase 0 (this plan)** — validation spike → findings doc → go/no-go.
- **Phase A (next plan)** — `src/core/gemini-agent-provider.ts`: the provider + tool-use loop + tier gate + cheapEval, unit-tested in isolation (mock genai stream + mock MCP client). **Written against this spike's findings** so the genai/MCP API calls are exact, not guessed.
- **Phase B (next plan)** — the ~13 integration touchpoints (capability-matrix row, bootstrap registration, `AgentProviderKind` enum, `/gemini` command, doctor, display name, e2e tier test) — mechanical, mirrors the Cursor provider; written after Phase A lands so it wires the real module.

Each phase is a separate plan that produces self-contained, testable work. **Do not** attempt to write Phase A/B exact code until this spike resolves the API + Bun unknowns.

---

## Prerequisites

- A **`GEMINI_API_KEY`** (AI Studio, https://aistudio.google.com/apikey) for the live-API steps. If unavailable, the import/instantiate/MCP steps still run and still give a partial Bun-compat signal; the live steps are skipped and that gap is recorded in the findings as "live API unverified."
- The daemon's wechat stdio MCP server is launchable for the MCP step (`src/mcp-servers/wechat/main.ts` — confirm the entry + env it needs during the task).

---

## Task 1: Add the SDK dependencies (optional)

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add the two SDKs as optionalDependencies**

The provider will treat these as optional (boot-guarded, like Cursor's `@cursor/sdk`). Add to `package.json` `optionalDependencies` (create the block if absent — confirm with `grep -n optionalDependencies package.json`):

```json
  "optionalDependencies": {
    "@cursor/sdk": "^1.0.12",
    "@google/genai": "^2.8.0",
    "@modelcontextprotocol/sdk": "^1.0.0"
  }
```
(Keep any existing `@cursor/sdk` entry; add the two new ones. Pin loosely — the spike's Step in Task 2 records the exact resolved versions.)

- [ ] **Step 2: Install**

Run: `bun install`
Expected: resolves and writes `bun.lock`. Record the exact resolved versions of `@google/genai` and `@modelcontextprotocol/sdk` (from `bun pm ls | grep -E 'genai|modelcontextprotocol'`) — you'll cite them in the findings doc.

- [ ] **Step 3: Commit**

```bash
git add package.json bun.lock
git commit -m "build(gemini): add @google/genai + @modelcontextprotocol/sdk as optionalDependencies (spike)"
```

---

## Task 2: Bun-compat smoke — import + instantiate (no API key needed)

**Files:**
- Create: `scripts/gemini-spike.ts`

- [ ] **Step 1: Write the import/instantiate smoke**

Create `scripts/gemini-spike.ts`:
```ts
// Throwaway spike — deleted in Task 6. Verifies @google/genai + MCP SDK under Bun.
/* eslint-disable no-console */

async function smokeImport() {
  console.log('=== Task 2: import + instantiate under Bun ===')
  const genai = await import('@google/genai')
  console.log('genai exports:', Object.keys(genai).slice(0, 20).join(', '))
  // The constructor name has changed across versions (GoogleGenAI vs GoogleGenerativeAI).
  // Record which one this version exports.
  const Ctor = (genai as any).GoogleGenAI ?? (genai as any).GoogleGenerativeAI
  console.log('constructor present:', Ctor?.name ?? 'NONE')
  const ai = new Ctor({ apiKey: process.env.GEMINI_API_KEY ?? 'dummy-no-call' })
  console.log('instantiated ok; has .models:', typeof (ai as any).models)

  const mcp = await import('@modelcontextprotocol/sdk/client/index.js')
  console.log('mcp client export:', Object.keys(mcp).join(', '))
  const transport = await import('@modelcontextprotocol/sdk/client/stdio.js')
  console.log('mcp stdio transport export:', Object.keys(transport).join(', '))
  console.log('IMPORT-SMOKE: OK')
}

const which = process.argv[2] ?? 'import'
if (which === 'import') await smokeImport()
```

- [ ] **Step 2: Run it under Bun**

Run: `bun scripts/gemini-spike.ts import`
Expected: prints the genai exports, the constructor name (record it — `GoogleGenAI` vs `GoogleGenerativeAI`), `has .models: object` (or function), the MCP client/transport exports, and `IMPORT-SMOKE: OK`.
**If it throws** (Bun can't load either SDK): STOP — record the exact error in the findings doc; this is a potential no-go. Try `bun --bun scripts/gemini-spike.ts import` (forces Bun's runtime) and note any difference. Note the genai constructor/`.models` API name actually observed (the loop in Phase A depends on it).

- [ ] **Step 3: Commit the spike script (temporary)**

```bash
git add scripts/gemini-spike.ts
git commit -m "spike(gemini): import/instantiate smoke under Bun"
```

---

## Task 3: Streaming + function-calling round-trip (needs GEMINI_API_KEY)

**Files:**
- Modify: `scripts/gemini-spike.ts`

- [ ] **Step 1: Add a streaming + tool-call probe**

Append to `scripts/gemini-spike.ts` a function that exercises the two API behaviors the loop needs — **streamed text** and a **functionCall round-trip** — and PRINTS THE OBSERVED SHAPES (so Phase A can be written exactly):
```ts
async function smokeLive() {
  console.log('=== Task 3: streaming + function-calling (live) ===')
  if (!process.env.GEMINI_API_KEY) { console.log('LIVE-SKIP: no GEMINI_API_KEY'); return }
  const { GoogleGenAI } = await import('@google/genai') as any
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
  const model = process.env.GEMINI_SPIKE_MODEL ?? 'gemini-flash-latest'

  // (a) streaming text — record how chunks expose text
  console.log('--- streaming ---')
  const stream = await ai.models.generateContentStream({
    model,
    contents: [{ role: 'user', parts: [{ text: 'Say hello in 3 words.' }] }],
  })
  let chunks = 0
  for await (const chunk of stream) {
    chunks++
    // RECORD: how does a chunk expose text? .text? .candidates[0].content.parts[].text?
    if (chunks <= 2) console.log('chunk keys:', Object.keys(chunk), '| chunk.text =', (chunk as any).text)
  }
  console.log('stream chunks:', chunks)

  // (b) function-calling round-trip — record the functionCall shape + how to send functionResponse
  console.log('--- function calling ---')
  const tools = [{ functionDeclarations: [{
    name: 'get_time',
    description: 'Returns the current time for a city.',
    parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  }] }]
  const r1 = await ai.models.generateContent({
    model,
    contents: [{ role: 'user', parts: [{ text: 'What time is it in Tokyo? Use the tool.' }] }],
    config: { tools },
  })
  // RECORD: where do functionCalls live? r1.functionCalls? r1.candidates[0].content.parts[].functionCall?
  console.log('r1.functionCalls =', JSON.stringify((r1 as any).functionCalls))
  console.log('r1.candidates[0].content.parts =', JSON.stringify((r1 as any).candidates?.[0]?.content?.parts))
  const fc = (r1 as any).functionCalls?.[0] ?? (r1 as any).candidates?.[0]?.content?.parts?.find((p: any) => p.functionCall)?.functionCall
  console.log('extracted functionCall:', JSON.stringify(fc))

  // send the functionResponse back — RECORD the content shape that works
  const r2 = await ai.models.generateContent({
    model,
    contents: [
      { role: 'user', parts: [{ text: 'What time is it in Tokyo? Use the tool.' }] },
      { role: 'model', parts: [{ functionCall: fc }] },
      { role: 'user', parts: [{ functionResponse: { name: fc?.name, response: { time: '14:00 JST' } } }] },
    ],
    config: { tools },
  })
  console.log('r2 final text:', (r2 as any).text)
  console.log('LIVE-SMOKE: OK')
}
```
And update the dispatcher at the bottom:
```ts
if (which === 'import') await smokeImport()
else if (which === 'live') await smokeLive()
```

- [ ] **Step 2: Run it**

Run: `GEMINI_API_KEY=<key> bun scripts/gemini-spike.ts live`
Expected: prints the streaming chunk shape, the `functionCalls` shape, the extracted call, and a final text answer, then `LIVE-SMOKE: OK`.
**Record in the findings (Task 5) the EXACT shapes:** how a stream chunk exposes text; where `functionCall`s live on the response; the `functionResponse` content shape that produced a valid `r2`. These are the precise API facts Phase A's loop will encode. If any call errors, record the error + the genai version.

- [ ] **Step 3: Commit**

```bash
git add scripts/gemini-spike.ts
git commit -m "spike(gemini): live streaming + function-calling probe (records API shapes)"
```

---

## Task 4: MCP client → daemon's wechat stdio server (listTools)

**Files:**
- Modify: `scripts/gemini-spike.ts`

- [ ] **Step 1: Find how the daemon launches its wechat stdio MCP server**

Run: `grep -rn "wechatStdioMcpSpec\|mcp-servers/wechat\|command.*bun\|StdioServerParameters" src/daemon/bootstrap/mcp-specs.ts src/daemon/bootstrap/index.ts | head`
Record the exact command + args + env the daemon uses to spawn the wechat MCP server (the spike must launch it the same way). Note the entry file (likely `src/mcp-servers/wechat/main.ts`) and any required env (internal-api base URL/token).

- [ ] **Step 2: Add an MCP listTools probe**

Append a function that connects an MCP **client** over stdio to that server and lists tools — recording the tool shape (name + inputSchema) the provider will convert to Gemini `functionDeclarations`:
```ts
async function smokeMcp() {
  console.log('=== Task 4: MCP client listTools ===')
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js')
  // Use the EXACT command/args/env recorded in Step 1. Example shape (replace with the real one):
  const transport = new StdioClientTransport({
    command: process.env.SPIKE_MCP_CMD ?? 'bun',
    args: (process.env.SPIKE_MCP_ARGS ?? 'src/mcp-servers/wechat/main.ts').split(' '),
    env: { ...process.env },
  })
  const client = new Client({ name: 'gemini-spike', version: '0.0.0' }, { capabilities: {} })
  await client.connect(transport)
  const tools = await client.listTools()
  console.log('tool count:', tools.tools.length)
  // RECORD: the shape of one tool — name, description, inputSchema (JSON Schema)
  console.log('first tool:', JSON.stringify(tools.tools[0], null, 2).slice(0, 600))
  await client.close()
  console.log('MCP-SMOKE: OK')
}
```
Add `else if (which === 'mcp') await smokeMcp()` to the dispatcher.

- [ ] **Step 3: Run it**

Run: `SPIKE_MCP_CMD=<cmd> SPIKE_MCP_ARGS="<args>" bun scripts/gemini-spike.ts mcp`
Expected: connects, prints a tool count > 0, and the shape of the first tool (name + inputSchema). `MCP-SMOKE: OK`.
**Record the tool shape** — specifically the `inputSchema` (JSON Schema) format, because Phase A converts it to Gemini's `parameters`. If the wechat server needs the daemon's internal-api running (it may, for tools that call back), record that dependency; for the spike, a connect + listTools that works without a live internal-api is enough to confirm the bridge. If listTools requires the internal-api, note it and run a minimal internal-api or stub per what Step 1 revealed.

- [ ] **Step 4: Commit**

```bash
git add scripts/gemini-spike.ts
git commit -m "spike(gemini): MCP client listTools against the wechat stdio server"
```

---

## Task 5: Write the findings doc + go/no-go

**Files:**
- Create: `docs/superpowers/specs/2026-06-04-gemini-spike-findings.md`

- [ ] **Step 1: Record everything the spike observed**

Create `docs/superpowers/specs/2026-06-04-gemini-spike-findings.md` with these sections (fill from the actual runs — this is the deliverable Phase A is written against):
```markdown
# Gemini provider — Phase 0 spike findings (2026-06-04)

## Versions
- @google/genai: <resolved version>
- @modelcontextprotocol/sdk: <resolved version>
- Bun: <bun --version>

## Bun compatibility
- import + instantiate: <OK | error: ...>
- live streaming: <OK | SKIP-no-key | error: ...>
- function-calling: <OK | SKIP | error: ...>
- MCP client listTools: <OK | error: ...>
- Verdict: <Bun runs the stack cleanly | needs `bun --bun` | BLOCKED — see note>

## Pinned API shapes (for Phase A)
- genai constructor: <GoogleGenAI | GoogleGenerativeAI>, entry `ai.models.generateContentStream(...)` / `generateContent(...)`
- stream chunk → text: <exact accessor, e.g. `chunk.text`>
- response → functionCalls: <exact accessor, e.g. `resp.functionCalls` / `candidates[0].content.parts[].functionCall`>
- functionResponse content shape: <the exact `{ role:'user', parts:[{ functionResponse: { name, response } }] }` that worked>
- tools config: <`config: { tools: [{ functionDeclarations: [...] }] }`, systemInstruction via `config.systemInstruction`>

## MCP
- wechat server launch: <command + args + env the daemon uses>
- tool shape: <name, description, inputSchema(JSON Schema) — how to map to Gemini `parameters`>
- internal-api dependency for listTools: <yes/no + note>

## Go / No-Go
- <GO: proceed to Phase A as designed | GO-with-changes: <what to adjust in the spec> | NO-GO: <why, and the fallback — e.g. Node sidecar / ADK reconsider>>
```

- [ ] **Step 2: Commit the findings**

```bash
git add docs/superpowers/specs/2026-06-04-gemini-spike-findings.md
git commit -m "docs(gemini): phase-0 spike findings + go/no-go"
```

---

## Task 6: Clean up the throwaway spike

**Files:**
- Delete: `scripts/gemini-spike.ts`

- [ ] **Step 1: Remove the spike script**

The findings doc captured everything; the script is throwaway.
Run: `rm scripts/gemini-spike.ts`

- [ ] **Step 2: Confirm the SDK deps + findings remain**

Run: `grep -E 'genai|modelcontextprotocol' package.json && ls docs/superpowers/specs/2026-06-04-gemini-spike-findings.md`
Expected: both present (the optionalDependencies stay — Phase A needs them; the findings stay).

- [ ] **Step 3: Typecheck (deps didn't break the build)**

Run: `bun run typecheck`
Expected: exit 0 (adding optionalDependencies + removing the spike script shouldn't affect the TS build).

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore(gemini): remove throwaway spike script (findings captured)"
```

---

## Decision gate (controller, after Task 6)

Read the findings doc's **Go / No-Go**:
- **GO** → write the **Phase A plan** (`gemini-agent-provider.ts` + tool loop + tier gate + cheapEval) using the pinned API shapes, then Phase B (integration).
- **GO-with-changes** → update the spec (`2026-06-04-gemini-provider-design.md`) per the findings, then write Phase A.
- **NO-GO** (Bun can't run the stack) → reconsider: a Node-subprocess sidecar for genai, or revisit the ADK/A2A options. Surface to the user — do not force Phase A.

---

## Self-Review notes (applied)

- **Spec coverage:** this plan covers exactly the spec's "Risks / open items" (Bun-compat of genai + MCP SDK; the experimental-MCP avoidance is implicit — the spike uses the standard MCP client, not `mcpToTool`; genai 2.x functionCall/stream shapes get pinned). The provider, tier gate, cheapEval, and the ~13 touchpoints are explicitly Phase A/B — out of scope here by design, because writing their exact code requires this spike's output.
- **No placeholders:** every step is an exact command or concrete code. The spike script's `(as any)` casts and "RECORD:" comments are intentional — the spike's *purpose* is to discover the typed shapes, so it runs untyped and the findings doc records the real ones for Phase A to type against.
- **Type consistency:** N/A for production types (no production code here); the findings doc is the contract Phase A consumes.
