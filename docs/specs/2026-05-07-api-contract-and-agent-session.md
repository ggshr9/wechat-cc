# Spec · Daemon API contract + AgentSession unification

**Status**: Draft · 2026-05-07 (revised — added P1.A after discovering desktop ↔ daemon path)
**Author**: GSR + Claude Opus 4.7 (brainstorming session)
**Implementation**: Three independent PRs — PR-A1 (P1.A · CLI JSON), PR-A2 (P1.B · internal-api), PR-B (P2 · AgentSession)
**Predecessor context**: Architecture review identified P1/P2 as highest-priority cleanup items in the `v0.5.x` codebase

---

## TL;DR

Three surgical interface changes that close concrete architectural gaps surfaced during the 2026-05-07 architecture review:

1. **P1.A — CLI JSON contract** *(addresses the original "desktop schema drift" risk)*: ~30 CLI subcommands that emit `--json` get zod schemas in `src/cli/schema.ts`. Each subcommand calls `Schema.parse(payload)` before printing — daemon-side drift fails CI tests immediately. Desktop call sites import the inferred types via JSDoc. Renames the original "desktop schema drift" architectural concern to its actual surface: the CLI subprocess output format, not internal-api HTTP routes.

2. **P1.B — internal-api zod schemas**: The HTTP `internal-api`'s 24 routes get zod schemas in `src/daemon/internal-api/schema.ts`. Validation injected at request entry. Tightens MCP server / delegate-mcp client contract (the actual current consumers of internal-api). Type-only — no runtime validation on the consumer side.

3. **P2 — `AgentSession` interface unification**: Replace the dual return-value-plus-callback shape with a single `AsyncIterable<AgentEvent>`. Both providers (Claude, Codex) already iterate SDK events internally; this just exposes that stream rather than translating it twice. Drops the leaky `replyToolCalled` field — consumers derive it by observing `tool_call` events.

All three PRs are big-bang single-commit-tree changes (no coexistence/shim layer) and independent — order does not matter, though P1.A is recommended first because it directly closes the user-reported risk surface.

---

## Context

The current architecture has paper cuts the project keeps stepping on:

**P1.A motivation** (CLI JSON contract): `apps/desktop/src/` is plain JavaScript loaded directly by Tauri's webview. ~25 desktop call sites use `invoke("wechat_cli_json", { args: [...] })` to spawn the bundled `wechat-cc` CLI subprocess and parse its stdout JSON. The CLI subcommands (`doctor`, `conversations list`, `sessions read-jsonl`, `memory list`, `provider show`, `service status`, etc.) print JSON in a free-form structure with no shared contract. When a CLI subcommand's output shape changes, desktop silently breaks at runtime in a packaged build — observed in the 2026-05-04 v0.6 PR5 dashboard rewrite (caught via manual click-through, not CI). The architecture review initially framed this as an "internal-api schema" problem; investigating the actual call paths showed the contract surface is the CLI's `--json` output, not internal-api HTTP.

**P1.B motivation** (internal-api zod schemas): `internal-api`'s actual current consumers are the wechat-mcp stdio subprocess and the delegate-mcp dispatch path — both invoke routes via HTTP + bearer token. No schema, runtime body parsing is hand-rolled `typeof` ladders in each handler. Adding zod schemas tightens the MCP-client contract and cleans up the validation boilerplate. Lower urgency than P1.A but parallel mechanical work.

**P2 motivation**: `AgentSession.dispatch()` returns `Promise<{ assistantText[]; replyToolCalled }>` AND exposes `onAssistantText` / `onResult` listener registration. Same data, two paths. The `replyToolCalled` field is a leaky abstraction (it encodes "did the agent call the wechat-mcp reply tool family?" — a wechat-channel concept) up into the provider interface. Coordinator dispatch logic (`solo`, `parallel`, `chatroom`) all hand-roll fallback semantics around this field. Mature SDKs in this space (Anthropic's own, Vercel AI SDK, LangGraph) ship a single async iterator instead.

---

## Scope

**In — P1.A (CLI JSON contract)**:
- New file `src/cli/schema.ts` with zod schemas for ~30 `--json`-emitting CLI subcommands (every subcommand listed in `cli.ts` help text, even ones desktop doesn't currently call — CLI is also a user-facing scripting surface)
- Each subcommand handler imports its `OutputSchema` and calls `Schema.parse(payload)` before `console.log(JSON.stringify(payload))`
- `tsconfig.json` includes specific desktop `.js` files that consume CLI JSON; `allowJs: true`
- `// @ts-check` directives + JSDoc imports in those desktop files (10+ files: `doctor-poller.js`, `conversations-poller.js`, `main.js`, `modules/*.js` for any module that calls `invoke("wechat_cli_json", ...)`)
- New tests asserting each subcommand's output parses against its schema

**In — P1.B (internal-api zod schemas)**:
- New file `src/daemon/internal-api/schema.ts` with zod schemas for all 24 routes
- Validation step injected in `src/daemon/internal-api/index.ts`
- Tightened handler parameter types in `src/daemon/internal-api/routes.ts`
- Type-only consumer adoption (no runtime validation) — there's no current desktop consumer of internal-api; future MCP-server-side adoption left as opportunistic follow-up

**In — P2 (AgentSession unification)**:
- `AgentEvent` discriminated union + new `AgentSession` shape in `src/core/agent-provider.ts`
- Rewrite of `src/core/claude-agent-provider.ts` to yield events instead of accumulating
- Rewrite of `src/core/codex-agent-provider.ts` similarly
- New `collectTurn` + `isReplyToolCall` helpers in `src/core/agent-provider.ts`
- Coordinator dispatch updates (`solo` / `parallel` / `chatroom`) to consume via `collectTurn`
- All affected tests rewritten for new shapes

**Out**:
- Frontend toolchain introduction (vite/esbuild) — separate P0.5 spec when it happens
- Desktop `.js` files that don't call the CLI — left untouched
- `routes.ts` decomposition into per-route files
- `cli.ts` decomposition into per-subcommand files (currently a single ~700-line file with inline subcommand handlers — also a future refactor)
- AgentSession `cancel()` / `abort()` API (still via `close()`)
- OpenAPI / tRPC / additional contract layers — zod is sufficient
- Provider behavior changes (reply-tool detection logic, error handling philosophy unchanged)
- MCP-server-side schema adoption (P1.B's MCP client side stays as-is; consumer adoption is a follow-up if/when MCP server contracts get refactored)

---

## P1.A Design — CLI JSON contract

### Architecture

```
┌─────────────────────────────────────────────┐
│ src/cli/schema.ts                           │  ← single source of truth
│   - ~30 OutputSchemas (zod)                 │
│   - one <Schema>T type alias per schema     │
└──────────────┬──────────────────────────────┘
               │
       ┌───────┴────────────────┐
       ↓                        ↓
┌──────────────────────┐  ┌────────────────────────────┐
│ cli.ts + src/cli/*   │  │ apps/desktop/src/*.js +    │
│   ↳ producer-side    │  │   modules/*.js (~10 files) │
│     Schema.parse()   │  │   // @ts-check + JSDoc     │
│     before stdout    │  │   types only, no runtime   │
└──────────────────────┘  └────────────────────────────┘
```

### Components

#### `src/cli/schema.ts` (new)

Single file with one zod schema per `--json`-emitting CLI subcommand, plus inferred type aliases (same `<Schema>` value + `<Schema>T` type pattern as P1.B):

```ts
import { z } from 'zod'

// wechat-cc doctor --json
export const DoctorOutput = z.object({
  ok: z.boolean(),
  daemon_pid: z.number().optional(),
  // ... fields the actual cli.ts doctor handler emits
})
export type DoctorOutputT = z.infer<typeof DoctorOutput>

// wechat-cc conversations list --json
// Existing handler emits: { ok: true, conversations: [...] }
export const ConversationsListOutput = z.object({
  ok: z.literal(true),
  conversations: z.array(z.object({
    chatId: z.string(),
    mode: z.unknown(), // or refined Mode union from src/core/conversation
    last_user_name: z.string().optional(),
    user_id: z.string().optional(),
    account_id: z.string().optional(),
  })),
})
export type ConversationsListOutputT = z.infer<typeof ConversationsListOutput>

// ... ~30 more schemas
```

Most CLI commands emit `{ ok: false, error: "..." }` on failure — express success/failure shapes via `z.discriminatedUnion('ok', [...])`:

```ts
export const UpdateOutput = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), pulled: z.boolean(), version: z.string() }),
  z.object({ ok: z.literal(false), error: z.string() }),
])
```

**Subcommand enumeration** (from `cli.ts` help text + grep on `console.log(JSON.stringify(`):

`doctor`, `setup`, `setup-poll`, `setup-status`, `service status/install/start/stop/uninstall`, `account remove`, `daemon kill`, `memory list/read/write`, `events list`, `observations list/archive`, `milestones list`, `sessions list-projects/read-jsonl/delete/search`, `demo seed/unseed`, `reply`, `logs`, `update [--check]`, `provider show`, `conversations list`, `guard status/enable/disable`, `avatar info/set/remove`, `install-progress`.

Roughly 30 subcommand variants. Wide scope per the design decision — even subcommands desktop doesn't currently call get schemas, because operators run them from the shell + scripts pipe to jq. CLI is itself a user-facing scripting surface.

#### CLI subcommand handlers (modified — `cli.ts` + `src/cli/*.ts`)

Each `--json` emit site imports its `OutputSchema` and calls `parse` before printing:

```ts
import { DoctorOutput } from '../src/cli/schema'

// in cli.ts's doctor subcommand:
const report = collectDoctorReport(...)
if (args.json) {
  const validated = DoctorOutput.parse(report)
  console.log(JSON.stringify(validated, null, 2))
} else {
  printHumanReadable(report)
}
```

`parse` (not `safeParse`) is intentional — a schema mismatch is a programming error in the daemon, not user input. Throw, exit non-zero, fail tests loudly.

For commands using `--json` for both success and failure JSON output, the schema is a discriminated union and parses both paths.

#### `tsconfig.json` (modified)

```diff
   "compilerOptions": {
     ...
+    "allowJs": true
   },
   "include": [
     "**/*.ts",
     "src/**/*.ts",
-    "types/**/*.d.ts"
+    "types/**/*.d.ts",
+    "apps/desktop/src/conversations-poller.js",
+    "apps/desktop/src/doctor-poller.js",
+    "apps/desktop/src/main.js",
+    "apps/desktop/src/modules/service.js",
+    "apps/desktop/src/modules/sessions.js",
+    "apps/desktop/src/modules/update.js",
+    "apps/desktop/src/modules/memory.js",
+    "apps/desktop/src/modules/qr.js"
   ],
```

The exact desktop file list is whatever calls `invoke("wechat_cli_json", { args: [...] })` — implementation discovers via `grep -rn 'wechat_cli_json' apps/desktop/src/`. Per-file `// @ts-check` keeps untouched files unaffected.

#### Desktop `.js` consumer files (modified)

Each file that calls the CLI gets a `// @ts-check` directive + JSDoc type aliases:

```js
// @ts-check
/** @typedef {import('../../../src/cli/schema').DoctorOutputT} DoctorOutput */
/** @typedef {import('../../../src/cli/schema').ConversationsListOutputT} ConversationsList */

/** @returns {Promise<ConversationsList>} */
async function refreshConversations() {
  const report = await invoke("wechat_cli_json", { args: ["conversations", "list", "--json"] })
  return report
}
```

Same JSDoc convention as P1.B — `@typedef` aliases at the top, then `@returns`/`@param` per function. The `@typedef`'d type names are local aliases; they let downstream code use short names.

### Migration sequence (single PR)

1. Enumerate all `--json` subcommands (grep + read `cli.ts` help output).
2. Write `src/cli/schema.ts` with all ~30 schemas + `<Schema>T` type aliases.
3. Write `src/cli/schema.test.ts` with round-trip parse tests (valid + invalid fixture per schema).
4. For each subcommand handler in `cli.ts` and `src/cli/*.ts`: import its schema, add `Schema.parse(payload)` line before `console.log(JSON.stringify(...))`.
5. Run existing CLI command tests — they pass if schemas match reality. Fix any drifts.
6. Modify `tsconfig.json` (`allowJs` + desktop file include paths).
7. Add `// @ts-check` + JSDoc to ~10 desktop consumer files.
8. Run `bun run typecheck` — should pass.
9. Run Playwright + shim e2e — desktop UI exercises every CLI subcommand path.

### Tests

**New**:
- `src/cli/schema.test.ts` — for each of ~30 schemas: valid + invalid fixture parse (~60 tests).
- For any subcommand currently lacking a test: smoke test that runs the subcommand and confirms `Schema.parse(parsedOutput)` doesn't throw.

**Modified**: existing CLI subcommand tests already do `JSON.parse(consoleSpy.mock.calls[0][0])`. The producer-side `Schema.parse` runs implicitly during the test. Add an explicit `expect(() => OutputSchema.parse(parsed)).not.toThrow()` only where the existing test doesn't already assert structural shape.

**Unchanged**: Playwright + shim e2e — they invoke the real CLI; the JSON shapes match because the schema describes what the CLI emits.

---

## P1.B Design — internal-api zod schemas

### Architecture

```
┌─────────────────────────────────────┐
│ src/daemon/internal-api/schema.ts   │  ← single source of truth
│   - 24 RequestSchemas (zod)         │
│   - 24 ResponseSchemas (zod)        │
│   - REQUEST_SCHEMAS lookup table    │
└──────────────┬──────────────────────┘
               │
               ↓
┌──────────────────────────────────┐
│ src/daemon/internal-api/index.ts │
│   validates POST body /          │
│   GET query before handler runs  │
└──────────────────────────────────┘
        consumed via HTTP by:
   wechat-mcp stdio child + delegate-mcp dispatch
   (NOT desktop — desktop talks to CLI, see P1.A)
```

### Components

#### `src/daemon/internal-api/schema.ts` (new)

Single file mirroring `routes.ts`'s key order. For each route:

```ts
import { z } from 'zod'

// GET /v1/health
export const HealthResponse = z.object({
  ok: z.boolean(),
  daemon_pid: z.number(),
})

// POST /v1/memory/read
export const MemoryReadRequest = z.object({
  path: z.string(),
})
export const MemoryReadResponse = z.union([
  z.object({ exists: z.literal(false) }),
  z.object({ exists: z.literal(true), content: z.string() }),
  z.object({ error: z.string() }),
])

// ... 22 more routes ...

// Inferred types — exported alongside zod values so JSDoc consumers can
// import them by name without nested generics. Naming convention:
// `<Schema>` is the zod value; `<Schema>T` is the inferred TS type.
export type HealthResponseT = z.infer<typeof HealthResponse>
export type MemoryReadRequestT = z.infer<typeof MemoryReadRequest>
export type MemoryReadResponseT = z.infer<typeof MemoryReadResponse>
// ... one type alias per schema ...

export const REQUEST_SCHEMAS: Record<string, z.ZodTypeAny | undefined> = {
  'POST /v1/memory/read': MemoryReadRequest,
  'POST /v1/memory/write': MemoryWriteRequest,
  // ... and so on; both *Request and *Query schemas are listed
}

export const RESPONSE_SCHEMAS: Record<string, z.ZodTypeAny | undefined> = {
  'GET /v1/health': HealthResponse,
  // ...
}
```

`MemoryWriteRequest`, `ProjectsListResponse`, etc. follow the same pattern — value `Schema` + type alias `SchemaT`. The schema test file (`schema.test.ts`) will spot any forgotten alias because untested zod values catch CI's eye via the test count.

GET routes that read query parameters get a `QuerySchema` instead of (or in addition to) request body schemas:

```ts
// GET /v1/memory/list?dir=...
export const MemoryListQuery = z.object({
  dir: z.string().optional(),
})
export const MemoryListResponse = z.union([
  z.object({ files: z.array(z.string()) }),
  z.object({ error: z.string() }),
])
```

GET routes with no query parameters (e.g. `/v1/health`) only get a `Response` schema.

#### `src/daemon/internal-api/index.ts` (modified)

Validation injected before route handler dispatch:

```ts
import { REQUEST_SCHEMAS } from './schema'

// inside the request handler, after parsing body:
const key = `${method} ${path}`
const reqSchema = REQUEST_SCHEMAS[key]
if (reqSchema && method === 'POST') {
  const parsed = reqSchema.safeParse(body)
  if (!parsed.success) {
    deps.log?.('INTERNAL_API', `400 ${key} schema mismatch`, {
      path: key,
      issues: parsed.error.issues,
    })
    return {
      status: 400,
      body: { error: 'invalid_request', detail: parsed.error.flatten() },
    }
  }
  body = parsed.data
}
const out = await route(url.searchParams, body)
```

GET query validation uses the same pattern but parses `Object.fromEntries(url.searchParams)` against the route's `QuerySchema`.

#### `src/daemon/internal-api/routes.ts` (modified)

Each handler signature gets explicit body type via `z.infer`:

```ts
'POST /v1/memory/read': (_q, body: z.infer<typeof MemoryReadRequest>) => {
  // body is now typed; no `as` casts inside the handler
  return deps.memory.read(body.chatId, body.name)
},
```

The handler **logic** does not change. This is purely tightening the type signature so internal type errors surface during `bun run typecheck`.

### Migration sequence (single PR)

1. Write `schema.ts` with all 24 schemas + `<Schema>T` type aliases + `REQUEST_SCHEMAS`/`RESPONSE_SCHEMAS` lookup tables.
2. Write `schema.test.ts` with round-trip parse tests for each schema (valid + invalid fixture each).
3. Modify `index.ts` to call the validation step before route dispatch.
4. Modify `routes.ts` handler signatures to use `z.infer` types.
5. Verify existing route handler tests pass unchanged (no behavior change).
6. Verify `bun run typecheck` passes.

### Tests

**New**:
- `src/daemon/internal-api/schema.test.ts` — for each of 24 schemas: one valid parse + one invalid parse (~50 tests total)
- `src/daemon/internal-api/index.test.ts` adds:
  - "POST with malformed body returns 400 + error detail"
  - "POST with valid body has handler receive parsed `data`"
  - "POST with no schema (e.g. internal route) skips validation"
  - "GET with malformed query returns 400"

**Unchanged**: All 24 route handler tests in `routes.test.ts` (handler logic is not changing).

---

## P2 Design — `AgentSession` unification

### Architecture

```
┌──────────────────────────────────────────────────┐
│ src/core/agent-provider.ts                       │
│   type AgentEvent = TextEvent | ToolCallEvent    │
│                   | InitEvent | ResultEvent      │
│                   | ErrorEvent                   │
│   interface AgentSession {                       │
│     dispatch(text): AsyncIterable<AgentEvent>    │
│     close(): Promise<void>                       │
│   }                                              │
│   helper collectTurn(events) → TurnSummary       │
│   helper isReplyToolCall(event) → boolean        │
└──────────────────────────────────────────────────┘
              ↑                    ↑
              │                    │
   ┌──────────┴──────┐  ┌──────────┴──────────┐
   │ claude-provider │  │ codex-provider      │
   │  yields events  │  │  yields events      │
   │  per dispatch   │  │  per dispatch       │
   └─────────────────┘  └─────────────────────┘
              ↑                    ↑
              └────────┬───────────┘
                       │
              ┌────────┴────────────────┐
              │ conversation-coordinator│
              │  uses collectTurn()     │
              │  in solo/parallel/chat  │
              └─────────────────────────┘
```

### Components

#### `src/core/agent-provider.ts` (rewritten)

```ts
export interface AgentProject {
  alias: string
  path: string
}

export type AgentEvent =
  | { kind: 'text'; text: string }
  | { kind: 'tool_call'; server?: string; tool: string }
  | { kind: 'init'; sessionId: string }
  | { kind: 'result'; sessionId: string; numTurns: number; durationMs: number }
  | { kind: 'error'; message: string }

export interface AgentSession {
  dispatch(text: string): AsyncIterable<AgentEvent>
  close(): Promise<void>
}

export interface AgentProvider {
  spawn(
    project: AgentProject,
    opts?: { resumeSessionId?: string },
  ): Promise<AgentSession>
}

// Reply-tool detection moves to consumer space (was duplicated in both providers).
const REPLY_TOOLS = new Set([
  'reply', 'reply_voice', 'send_file', 'edit_message', 'broadcast',
])

export function isReplyToolCall(ev: AgentEvent): boolean {
  return ev.kind === 'tool_call' && ev.server === 'wechat' && REPLY_TOOLS.has(ev.tool)
}

export interface TurnSummary {
  assistantText: string[]
  replyToolCalled: boolean
  result?: { sessionId: string; numTurns: number; durationMs: number }
  error?: string
}

export async function collectTurn(events: AsyncIterable<AgentEvent>): Promise<TurnSummary> {
  const texts: string[] = []
  let replyToolCalled = false
  let result: TurnSummary['result']
  let error: string | undefined
  for await (const ev of events) {
    if (ev.kind === 'text') texts.push(ev.text)
    else if (ev.kind === 'tool_call' && isReplyToolCall(ev)) replyToolCalled = true
    else if (ev.kind === 'result') {
      result = { sessionId: ev.sessionId, numTurns: ev.numTurns, durationMs: ev.durationMs }
    } else if (ev.kind === 'error') {
      error = ev.message
    }
  }
  return { assistantText: texts, replyToolCalled, result, error }
}
```

**Removed from this file**:
- `AgentResult` interface (subsumed into `result` event variant)
- `AgentSession.onAssistantText` / `onResult` listener methods
- `dispatch` return value's `assistantText` / `replyToolCalled` fields

#### Tool name normalization

| Provider | SDK source | Normalized output |
|---|---|---|
| Claude | tool_use block: `name: 'mcp__wechat__reply'` | `{ kind: 'tool_call', server: 'wechat', tool: 'reply' }` |
| Codex | mcp_tool_call item with `server: 'wechat'`, `tool: 'reply'` | `{ kind: 'tool_call', server: 'wechat', tool: 'reply' }` (passthrough) |
| Either, non-MCP | Built-in tools (Read, Bash, etc.) | `{ kind: 'tool_call', tool: '<sdk_name>' }` (no server field) |

Each provider does its own normalization in the event emit step. Consumers (and `isReplyToolCall`) rely on the normalized shape.

#### Error semantics

| SDK signal | Event/exception |
|---|---|
| Claude `result` with `subtype !== 'success'` | yield `{ kind: 'error', message }`, then exit normally |
| Claude SDK iterator throws | iterator throws; consumer's `for await` catches |
| Codex `turn.failed` event | yield `{ kind: 'error', message: ev.error.message }`, then exit |
| Codex `error` event | yield `{ kind: 'error', message: ev.message }`, then exit |
| Codex `runStreamed` rejects | iterator throws; consumer catches |

`collectTurn` captures the error event into `summary.error` rather than rethrowing — consumers decide what to do based on `summary.error` presence + `summary.assistantText` (e.g., partial response with terminal error).

#### `src/core/claude-agent-provider.ts` (rewritten)

Internal `pendingTurns` queue and Promise-based `dispatch` resolution **deleted**. New shape:

```ts
async function spawn(project, spawnOpts) {
  const sdkQueue = new AsyncQueue<SDKUserMessage>()
  const q = query({ prompt: sdkQueue.iterable(), options })
  let activeEventQueue: AsyncQueue<AgentEvent> | null = null
  let closed = false

  ;(async () => {
    try {
      for await (const raw of q as AsyncGenerator<SDKMessage>) {
        const msg = narrow(raw)
        if (!msg) continue
        if (!activeEventQueue) {
          // No in-flight dispatch — preserves v1.2-era [STREAM_DROP] behavior.
          // Trailing chunks after a result, or assistant text from an SDK quirk,
          // get logged but not attributed to a future turn.
          if (msg.type === 'assistant') {
            const text = extractText(msg.message?.content)
            if (text) {
              droppedAssistantChunks++
              console.warn(`wechat channel: [STREAM_DROP] alias=${project.alias} count=${droppedAssistantChunks} preview=${JSON.stringify(text.slice(0, 80))}`)
            }
          }
          continue
        }
        if (msg.type === 'system' && msg.subtype === 'init') {
          activeEventQueue.push({ kind: 'init', sessionId: msg.session_id ?? '' })
        } else if (msg.type === 'assistant') {
          const content = msg.message?.content
          // Emit tool_call events for tool_use blocks
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'tool_use') {
                activeEventQueue.push(parseToolUseToEvent(block))
              }
            }
          }
          // Emit text event for any text blocks
          const text = extractText(content)
          if (text) activeEventQueue.push({ kind: 'text', text })
        } else if (msg.type === 'result') {
          if (msg.subtype && msg.subtype !== 'success') {
            activeEventQueue.push({ kind: 'error', message: `subtype=${msg.subtype}` })
          }
          activeEventQueue.push({
            kind: 'result',
            sessionId: msg.session_id ?? '',
            numTurns: msg.num_turns ?? 0,
            durationMs: msg.duration_ms ?? 0,
          })
          activeEventQueue.end()  // close iterator after result
          activeEventQueue = null
        }
      }
    } catch (e) {
      if (activeEventQueue) {
        activeEventQueue.push({ kind: 'error', message: errMsg(e) })
        activeEventQueue.end()
      }
    }
  })()

  let droppedAssistantChunks = 0

  return {
    dispatch(text) {
      if (closed) {
        // Already closed — return an iterable that yields nothing and ends.
        return { async *[Symbol.asyncIterator]() {} }
      }
      // Serialize: only one in-flight dispatch at a time. The previous queue
      // must have ended before we set a new one.
      if (activeEventQueue) {
        throw new Error('claude provider: previous dispatch still in flight')
      }
      const queue = new AsyncQueue<AgentEvent>()
      activeEventQueue = queue
      sdkQueue.push({ type: 'user', parent_tool_use_id: null,
        message: { role: 'user', content: [{ type: 'text', text }] } })
      return queue.iterable()
    },
    async close() {
      closed = true
      sdkQueue.end()
      ;(q as any).close?.()
      ;(q as any).interrupt?.()
      if (activeEventQueue) {
        activeEventQueue.end()
        activeEventQueue = null
      }
    },
  }
}
```

`AsyncQueue` (already in this file) gains an `end()` method (it has it).

`parseToolUseToEvent(block)` parses `mcp__wechat__reply` into `{ server: 'wechat', tool: 'reply' }`, falling back to `{ tool: <name> }` for non-MCP tools.

The `[STREAM_DROP]` warning behavior is preserved: if the SDK iterator emits assistant text after the event queue has already ended, log via `console.warn` and continue.

#### `src/core/codex-agent-provider.ts` (rewritten)

Codex's translation is more direct because `thread.runStreamed` already returns a per-turn `AsyncGenerator<ThreadEvent>`:

```ts
return {
  dispatch(text) {
    return {
      async *[Symbol.asyncIterator]() {
        if (closed) return
        const turnAborter = new AbortController()
        activeAborter = turnAborter
        const turnStarted = Date.now()
        let dispatchedText = text
        if (!instructionsInjected && opts.appendInstructions) {
          dispatchedText = `${opts.appendInstructions}\n\n---\n\n${text}`
          instructionsInjected = true
        }
        try {
          const { events } = await thread.runStreamed(dispatchedText, { signal: turnAborter.signal })
          for await (const ev of events) {
            if (ev.type === 'thread.started') {
              yield { kind: 'init', sessionId: ev.thread_id }
            } else if (ev.type === 'item.completed') {
              const item = ev.item
              if (item.type === 'agent_message') {
                yield { kind: 'text', text: item.text }
              } else if (item.type === 'mcp_tool_call') {
                yield { kind: 'tool_call', server: item.server, tool: item.tool }
              }
            } else if (ev.type === 'turn.completed') {
              yield {
                kind: 'result',
                sessionId: thread.id ?? '',
                numTurns: ++turnCount,
                durationMs: Date.now() - turnStarted,
              }
            } else if (ev.type === 'turn.failed') {
              yield { kind: 'error', message: ev.error.message }
            } else if (ev.type === 'error') {
              yield { kind: 'error', message: ev.message }
            }
          }
        } finally {
          if (activeAborter === turnAborter) activeAborter = null
        }
      },
    }
  },
  async close() { closed = true; activeAborter?.abort() },
}
```

The closure-scoped state (`activeAborter`, `instructionsInjected`, `turnCount`, `closed`) is preserved verbatim. Listener storage (`assistantListeners`, `resultListeners`) is **deleted**.

#### `src/core/conversation-coordinator.ts` (modified)

Replace each `await handle.dispatch(text)` with `await collectTurn(handle.dispatch(text))`. The `assistantText` / `replyToolCalled` extraction continues to work because `TurnSummary` has the same shape:

```diff
   const handle = await deps.manager.acquire(proj.alias, proj.path, providerId)
   const text = deps.format(msg)
-  const result = await handle.dispatch(text)
-  const assistantTexts = result.assistantText
-  const replyToolCalled = result.replyToolCalled
+  const summary = await collectTurn(handle.dispatch(text))
+  const assistantTexts = summary.assistantText
+  const replyToolCalled = summary.replyToolCalled
```

This pattern repeats in:
- `dispatchSolo` (one occurrence)
- `dispatchParallel` (inside `Promise.allSettled` map: `handles.map(h => collectTurn(h.dispatch(text)))`)
- `dispatchChatroom` (per-speaker `await collectTurn(handle.dispatch(dispatchedPrompt))`)

All other coordinator logic — capability matrix gating, fallback degradation, abort controller, history tracking — is unchanged.

### Migration sequence (single PR)

1. Define `AgentEvent`, new `AgentSession`, `collectTurn`, `isReplyToolCall`, `TurnSummary` in `agent-provider.ts`.
2. Rewrite `claude-agent-provider.ts`.
3. Rewrite `codex-agent-provider.ts`.
4. Update `conversation-coordinator.ts` (3 dispatch functions).
5. Rewrite `claude-agent-provider.test.ts` (assert event sequence).
6. Rewrite `codex-agent-provider.test.ts` (same).
7. Add `agent-provider.test.ts` (collectTurn + isReplyToolCall units).
8. Update `conversation-coordinator.test.ts` — rewrite all `makeFakeSession()` call sites to yield events.
9. Run full test suite + `bun run typecheck`.
10. Spot-check a chat session against a real Claude / Codex session via shim.

### Tests

**New**:
- `src/core/agent-provider.test.ts` — `collectTurn` (5-7 tests covering text/tool_call/result/error event sequences) + `isReplyToolCall` (4 tests covering wechat-mcp tools, non-wechat-server tools, non-tool events).

**Rewritten**:
- `src/core/claude-agent-provider.test.ts` — assertions shift from "dispatch returns aggregated `{texts, replyToolCalled}`" to "dispatch yields events in this sequence".
- `src/core/codex-agent-provider.test.ts` — same.
- `src/core/conversation-coordinator.test.ts` — fixture helper `makeFakeSession({ events: AgentEvent[] })` produces an `AgentSession` whose `dispatch()` returns an iterable of the supplied events. All ~30 test cases consume this helper. Existing assertions on coordinator behavior (fallback fan-out, parallel, chatroom routing) are preserved.

**Unchanged**:
- All e2e tests in `src/daemon/__e2e__/` — these test daemon-level behavior, not provider internals. Their fake-sdk implementations get swapped to the new shape.
- All inbound middleware tests — coordinator interface (`dispatch(msg): Promise<void>`) is unchanged.
- `apps/desktop/shim.e2e.test.ts` and Playwright — completely orthogonal.

---

## Risks

### P1.A

1. **Schema must match every code path that writes JSON**: a CLI subcommand might have multiple `--json` print sites (e.g., success branch vs error branch). All must parse against the same union schema. Mitigation: enumerate via grep `console.log(JSON.stringify(...)`; one schema test per print-site shape.

2. **`Schema.parse` overhead on hot paths**: most CLI commands run once per shell invocation, so parse cost is negligible. Mitigation: not relevant — but if a command becomes a hot loop, switch its `parse` to `safeParse` + log on failure.

3. **`@typedef` import path verbosity in JSDoc**: `import('../../../src/cli/schema').DoctorOutputT` is ugly. Mitigation: declare each type alias once at the top of each desktop file; downstream usage stays clean.

4. **`allowJs` ripple effects**: enabling `allowJs` widens what TypeScript considers part of the project. Mitigation: explicit `include` list — only the named files are compiled, not all `.js` in the repo. Verified by inspecting `tsc --listFiles`.

### P1.B

1. **Schema/handler return-shape drift**: response schemas are declared but not actively asserted against handler return values (in contrast to P1.A which asserts producer-side). Mitigation: type-only contracts caught by `tsc` if the handler return type doesn't match `z.infer`; optional dev-mode `.parse()` assertion is a possible follow-up.

2. **MCP server clients (wechat-mcp, delegate-mcp) don't currently use the schemas**: the server-side validates incoming bodies, but clients still hand-craft request payloads. Mitigation: out of scope for this PR; client-side schema adoption is opportunistic when MCP server contracts are next refactored.

### P2

1. **`conversation-coordinator.test.ts` rewrite volume**: 367 lines, ~30 test cases. Mitigation: write `makeFakeSession({ events })` helper first; mechanical substitution after.

2. **Claude provider `[STREAM_DROP]` semantics**: current code logs when assistant text arrives without a pending turn. New shape: when assistant text arrives without an `activeEventQueue`, the warn fires identically — no functional change.

3. **Concurrent dispatch**: Claude provider currently serializes via FIFO `pendingTurns`. New shape throws on second `dispatch()` while one is in flight (cleaner contract). Coordinator currently never makes parallel dispatches against the same session, so this is a no-op in practice — but a behavioral tightening worth noting.

4. **Codex `instructionsInjected` first-dispatch state**: preserved exactly. The injection happens inside the iterator body before the first `runStreamed` call.

---

## Non-goals (explicit)

1. **Frontend toolchain introduction** — out of scope. Z option's whole point: desktop stays `.js`, no vite/esbuild.
2. **`routes.ts` decomposition** — remains a single object literal. Splitting into per-route files is a separate refactor.
3. **`cli.ts` decomposition** — currently a ~700-line file with inline subcommand handlers. Splitting into per-subcommand files is a separate refactor; P1.A only adds schema imports and parse calls.
4. **MCP server client-side schema adoption** — P1.B's wechat-mcp / delegate-mcp clients keep hand-crafting requests. Adoption is a follow-up.
5. **OpenAPI / tRPC / contract spec layer** — zod is the contract.
6. **AgentSession streaming-text events at sub-message granularity** — events are emitted at SDK message boundaries (full text per assistant block), not per token. Sub-message streaming is a future API contract change if dashboard ever needs it.
7. **`AgentSession.cancel()` / explicit per-dispatch abort** — `close()` covers session shutdown; per-dispatch abort is a future API addition only if needed.
8. **`replyToolCalled` for non-wechat tool families** — `isReplyToolCall` is hardcoded to `server === 'wechat'`. If the channel ever ships another MCP server with reply-like semantics, this gets a list parameter.

---

## Open questions / future work

- **P1.A follow-up**: schema reuse across CLI and HTTP — some commands (`memory list/read/write`) have analogous internal-api routes; could share core type aliases. Decision deferred — P1.A and P1.B intentionally have separate schema files for now.
- **P1.B follow-up**: dev-mode `.parse()` assertion on handler return values to catch shape drift even when types align formally but runtime returns diverge.
- **P2 follow-up**: should `init` and `error` events surface to dashboard? Currently consumed only by `collectTurn`. Decision deferred until dashboard has a reason to render them.
- **All three**: when frontend toolchain (vite/esbuild) lands, the JSDoc desktop files graduate to full `.ts`. The `// @ts-check` markers become redundant; the schema imports become regular TS imports. No behavior change.

---

## Implementation order

Three independent PRs — no shared files, no shared tests. Can be implemented in any order or in parallel by separate sessions/agents.

| PR | Surface | Why this priority |
|---|---|---|
| **PR-A1 (P1.A · CLI JSON)** | recommended first | Closes the actual user-reported "desktop schema drift" risk. Producer-side validation gives immediate CI-level safety. |
| **PR-A2 (P1.B · internal-api)** | next | MCP-server contract tightening; lower direct user impact but parallel mechanical work. |
| **PR-B (P2 · AgentSession)** | last | Internal cleanup; no user-visible behavior change. Largest test fixture rewrite (`conversation-coordinator.test.ts`). |
