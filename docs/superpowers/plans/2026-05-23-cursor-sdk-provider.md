# Cursor SDK Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `cursor` as a third registered `AgentProvider` (alongside `claude` and `codex`) with full tier integration, so `/cursor` slash command routes inbound to the Cursor SDK, with `wechat-mcp` + `delegate-mcp` wired through Cursor's `mcpServers` config and tier-based sandboxing via Cursor's single permission knob (`local.sandboxOptions.enabled`).

**Architecture:** New `src/core/cursor-agent-provider.ts` mirrors codex provider shape: pure `tierProfileToCursorSdkOpts` helper + provider factory using dynamic `import('@cursor/sdk')`. Bootstrap conditionally registers cursor on `CURSOR_API_KEY` + SDK presence (both required). Capability matrix gains cursor rows mirroring codex's coarse-permission stance (no per-tool callback). Tests parallel the existing codex test surface.

**Tech Stack:** TypeScript / Bun / vitest. Uses `@cursor/sdk@^1.0.12` (currently in `devDependencies` from the 2026-05-08 spike; this plan moves it to `optionalDependencies`).

**Source of truth for design decisions:** `docs/superpowers/specs/2026-05-23-cursor-sdk-provider-design.md`. If a step here disagrees with the spec, the spec wins — flag the conflict and ask before resolving.

---

## File Structure

**New files:**
- `src/core/cursor-agent-provider.ts` — provider factory, `tierProfileToCursorSdkOpts`, `mapCursorToolName`, SDKMessage→AgentEvent mapping
- `src/core/cursor-agent-provider.test.ts` — unit tests for the above
- `src/daemon/__e2e__/dispatch-solo-cursor.e2e.test.ts` — e2e mirror of codex solo dispatch
- `src/daemon/__e2e__/user-tier-cursor.e2e.test.ts` — e2e mirror of cursor tier enforcement

**Modified files:**
- `src/lib/agent-config.ts` — `AgentProviderKind` gains `'cursor'`; `AgentConfig` gains `cursorModel?: string`
- `src/cli/schema.ts` — `AgentProviderKind` zod enum + `AgentConfigSchema` mirror the above
- `src/core/capability-matrix.ts` — add 8 cursor rows (4 modes × 2 perms)
- `src/daemon/bootstrap/index.ts` — conditional cursor registration block after codex
- `src/daemon/__e2e__/fake-sdk.ts` — `installFakeCursor` + `installCursorSpawnRecorder`
- `src/daemon/__e2e__/harness.ts` — `recordCursorSpawnOptions?` opt-in hook
- `src/cli/doctor.ts` — probe for cursor SDK + API key
- `package.json` — move `@cursor/sdk` from `devDependencies` to `optionalDependencies`
- `README.md` — third provider note + tier-coarseness caveat

---

## Task 1: Move `@cursor/sdk` to `optionalDependencies`

**Files:**
- Modify: `package.json`

The SDK is currently in `devDependencies` from the spike. The spec calls for `optionalDependencies` because:
- Dev-time TypeScript imports still resolve (optional deps install by default)
- Bundling `wechat-cc-cli` only includes what's reachable at compile time
- Users who don't want Cursor can `bun remove @cursor/sdk`; bootstrap's dynamic-import + try/catch handles the absence gracefully

- [ ] **Step 1: Edit `package.json`**

Find the `"devDependencies": { "@cursor/sdk": "^1.0.12", ... }` block. Remove the cursor entry from devDependencies. Add an `optionalDependencies` field (top-level, next to `dependencies`) if it doesn't already exist:

```json
"optionalDependencies": {
  "@cursor/sdk": "^1.0.12"
}
```

- [ ] **Step 2: Verify install + typecheck still works**

Run: `bun install && bun run typecheck`
Expected: clean install (the package was already in node_modules; bun should not re-fetch); typecheck passes (any `import type` statements still resolve).

- [ ] **Step 3: Commit**

```bash
git add package.json bun.lock
git commit -m "chore(deps): move @cursor/sdk to optionalDependencies

Sets up the conditional-registration pattern: the provider's dynamic
import('@cursor/sdk') still resolves at dev time, but users who
remove the package via 'bun remove @cursor/sdk' get a clean bootstrap
skip (logged at BOOT) instead of a crash."
```

---

## Task 2: `AgentProviderKind` gains `'cursor'`

**Files:**
- Modify: `src/lib/agent-config.ts`
- Modify: `src/cli/schema.ts`

The two definitions must stay in sync — the TS type for runtime + the zod enum for CLI JSON parsing. Update both atomically.

- [ ] **Step 1: Write failing test**

Add to `src/lib/agent-config.test.ts` (create if it doesn't exist, but it likely does — check first):

```ts
import { describe, it, expect } from 'vitest'
import { loadAgentConfig } from './agent-config'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('loadAgentConfig — cursor provider', () => {
  it('accepts provider="cursor" with cursorModel', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-cfg-'))
    writeFileSync(join(dir, 'agent-config.json'), JSON.stringify({
      provider: 'cursor',
      cursorModel: 'composer-2',
      dangerouslySkipPermissions: false,
      autoStart: false,
      closeStopsDaemon: false,
    }))
    try {
      const cfg = loadAgentConfig(dir)
      expect(cfg.provider).toBe('cursor')
      expect(cfg.cursorModel).toBe('composer-2')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('cursorModel optional — defaults to undefined', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-cfg-'))
    writeFileSync(join(dir, 'agent-config.json'), JSON.stringify({
      provider: 'cursor',
      dangerouslySkipPermissions: false,
      autoStart: false,
      closeStopsDaemon: false,
    }))
    try {
      const cfg = loadAgentConfig(dir)
      expect(cfg.provider).toBe('cursor')
      expect(cfg.cursorModel).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `bun --bun vitest run src/lib/agent-config.test.ts`
Expected: FAIL — `provider: 'cursor'` falls back to `'claude'` (existing default branch); `cursorModel` undefined on the result type.

- [ ] **Step 3: Update `AgentProviderKind` + `AgentConfig` interface**

In `src/lib/agent-config.ts`:

```ts
export type AgentProviderKind = 'claude' | 'codex' | 'cursor'

export interface AgentConfig {
  provider: AgentProviderKind
  model?: string  // claude-specific (kept for backwards compat)
  cursorModel?: string  // NEW
  dangerouslySkipPermissions: boolean
  autoStart: boolean
  closeStopsDaemon: boolean
}
```

In `loadAgentConfig`, extend the provider parse:

```ts
const provider: AgentProviderKind =
  parsed.provider === 'codex' ? 'codex'
  : parsed.provider === 'cursor' ? 'cursor'
  : 'claude'
```

And in the return object, parse `cursorModel` like `model`:

```ts
return {
  provider,
  ...(typeof parsed.model === 'string' ? { model: parsed.model } : {}),
  ...(typeof parsed.cursorModel === 'string' ? { cursorModel: parsed.cursorModel } : {}),
  // ...
}
```

- [ ] **Step 4: Update `AgentProviderKind` enum + `AgentConfigSchema` in `src/cli/schema.ts`**

Line 60:
```ts
const AgentProviderKind = z.enum(['claude', 'codex', 'cursor'])
```

Line 173-179:
```ts
const AgentConfigSchema = z.object({
  provider: AgentProviderKind,
  model: z.string().optional(),
  cursorModel: z.string().optional(),
  dangerouslySkipPermissions: z.boolean(),
  autoStart: z.boolean(),
  closeStopsDaemon: z.boolean(),
})
```

- [ ] **Step 5: Run tests to verify pass**

Run: `bun --bun vitest run src/lib/agent-config.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `bun run typecheck`
Expected: PASS. If any other call site does an exhaustive switch on `AgentProviderKind`, the missing `cursor` case will surface here.

- [ ] **Step 7: Run full suite**

Run: `bun --bun vitest run`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add src/lib/agent-config.ts src/lib/agent-config.test.ts src/cli/schema.ts
git commit -m "feat(agent-config): allow provider='cursor' + cursorModel field

AgentProviderKind union and zod enum both gain 'cursor'.
AgentConfig.cursorModel? mirrors the existing model? field's
shape — operator can persist a Cursor model id via
\`wechat-cc provider set cursor --model composer-2\` (CLI
wiring follows in later task)."
```

---

## Task 3: `tierProfileToCursorSdkOpts` pure helper

**Files:**
- Create: `src/core/cursor-agent-provider.ts` (start with this helper + types)
- Create: `src/core/cursor-agent-provider.test.ts`

Pure function, no SDK call. Translates `TierProfile` → `{ sandboxOptions: { enabled: boolean } }`. Symmetric to Tasks 4/5 of the user-tier feature.

- [ ] **Step 1: Write failing test**

Create `src/core/cursor-agent-provider.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { tierProfileToCursorSdkOpts } from './cursor-agent-provider'
import { TIER_PROFILES } from './user-tier'

describe('tierProfileToCursorSdkOpts', () => {
  it('admin → sandbox disabled', () => {
    const out = tierProfileToCursorSdkOpts(TIER_PROFILES.admin)
    expect(out.sandboxOptions.enabled).toBe(false)
  })

  it('trusted → sandbox enabled', () => {
    const out = tierProfileToCursorSdkOpts(TIER_PROFILES.trusted)
    expect(out.sandboxOptions.enabled).toBe(true)
  })

  it('guest → sandbox enabled (lossier than codex read-only; documented)', () => {
    const out = tierProfileToCursorSdkOpts(TIER_PROFILES.guest)
    expect(out.sandboxOptions.enabled).toBe(true)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `bun --bun vitest run src/core/cursor-agent-provider.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement helper + types**

Create `src/core/cursor-agent-provider.ts`:

```ts
/**
 * Cursor SDK agent provider.
 *
 * Third registered provider alongside claude / codex. Uses
 * `@cursor/sdk` (loaded via dynamic import in bootstrap) and conforms
 * to the AgentProvider / AgentSession interface defined in
 * src/core/agent-provider.ts.
 *
 * Permission surface is the coarsest of the three providers — Cursor
 * has neither a per-tool callback (cf. Claude's canUseTool) nor a
 * granular sandbox shape (cf. Codex's read-only / workspace-write /
 * danger-full-access). `local.sandboxOptions: { enabled }` is the
 * entire permission surface. Tier mapping reflects that.
 *
 * See docs/superpowers/specs/2026-05-23-cursor-sdk-provider-design.md.
 */
import type { TierProfile } from './user-tier'

export interface CursorTierSdkOpts {
  sandboxOptions: { enabled: boolean }
}

/**
 * Translate daemon TierProfile → Cursor SDK options.
 *
 * Heuristic: a profile with no relay and no deny is admin-equivalent
 * (sandbox off). Any non-empty relay or deny → enable sandbox. Matches
 * the same size-based heuristic Codex uses.
 *
 * Guest gets the same sandbox as trusted — Cursor lacks a read-only
 * mode, so guest can write inside cwd. Documented in README as a
 * known limitation; operators with strict guest separation route
 * guests to Claude.
 */
export function tierProfileToCursorSdkOpts(tp: TierProfile): CursorTierSdkOpts {
  if (tp.relay.size === 0 && tp.deny.size === 0) {
    return { sandboxOptions: { enabled: false } }
  }
  return { sandboxOptions: { enabled: true } }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `bun --bun vitest run src/core/cursor-agent-provider.test.ts`
Expected: PASS, all 3 cases.

- [ ] **Step 5: Typecheck**

Run: `bun run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/core/cursor-agent-provider.ts src/core/cursor-agent-provider.test.ts
git commit -m "feat(cursor-provider): tierProfileToCursorSdkOpts pure helper

Translates daemon TierProfile to Cursor SDK's only permission knob:
local.sandboxOptions.enabled. Admin → false (full system access);
trusted + guest → true (sandboxed to cwd; guest gap documented).

Cursor SDK has neither a per-tool callback nor a granular sandbox
shape, making this the coarsest of the three providers' tier
mappings. Mirrors the size-based heuristic from
tierProfileToCodexSdkOpts."
```

---

## Task 4: `mapCursorToolName` parser

**Files:**
- Modify: `src/core/cursor-agent-provider.ts`
- Modify: `src/core/cursor-agent-provider.test.ts`

Spike open Q3: Cursor's `SDKToolUseMessage.name` field's format isn't statically documented. May be `mcp__<server>__<tool>` (Anthropic-style) or `<server>:<tool>` or just `<tool>`. The parser handles multiple formats with fallback to MCP-server-name lookup.

- [ ] **Step 1: Write failing tests**

Append to `src/core/cursor-agent-provider.test.ts`:

```ts
import { mapCursorToolName } from './cursor-agent-provider'

describe('mapCursorToolName', () => {
  const mcpServers = new Set(['wechat', 'delegate'])

  it('parses Anthropic-style mcp__<server>__<tool>', () => {
    expect(mapCursorToolName('mcp__wechat__reply', mcpServers)).toEqual({
      server: 'wechat', tool: 'reply',
    })
  })

  it('parses double-underscore <server>__<tool>', () => {
    expect(mapCursorToolName('wechat__reply', mcpServers)).toEqual({
      server: 'wechat', tool: 'reply',
    })
  })

  it('parses colon-separated <server>:<tool>', () => {
    expect(mapCursorToolName('wechat:reply', mcpServers)).toEqual({
      server: 'wechat', tool: 'reply',
    })
  })

  it('parses slash-separated <server>/<tool>', () => {
    expect(mapCursorToolName('wechat/reply', mcpServers)).toEqual({
      server: 'wechat', tool: 'reply',
    })
  })

  it('unknown server falls back to no-server (built-in)', () => {
    expect(mapCursorToolName('Read', mcpServers)).toEqual({ tool: 'Read' })
  })

  it('mcp__-prefix with unknown server falls back', () => {
    expect(mapCursorToolName('mcp__unknown__foo', mcpServers)).toEqual({
      tool: 'mcp__unknown__foo',
    })
  })

  it('handles tool name with multiple separators (greedy split on first match)', () => {
    expect(mapCursorToolName('wechat__memory__read', mcpServers)).toEqual({
      server: 'wechat', tool: 'memory__read',
    })
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `bun --bun vitest run src/core/cursor-agent-provider.test.ts -t mapCursorToolName`
Expected: FAIL — `mapCursorToolName` not exported.

- [ ] **Step 3: Implement parser**

Append to `src/core/cursor-agent-provider.ts`:

```ts
/**
 * Parse Cursor's tool name into { server?, tool } for AgentEvent.
 *
 * Cursor SDK docs say "tool call schema is not stable" — the exact
 * format of SDKToolUseMessage.name is unspecified. Handle multiple
 * plausible formats; fall back to no-server if no known MCP server
 * name appears as a prefix.
 *
 * First successful tool call from Cursor logs the observed format so
 * the implementer notices if it diverges (see cursor provider's
 * dispatch loop).
 */
export function mapCursorToolName(
  rawName: string,
  mcpServerNames: ReadonlySet<string>,
): { server?: string; tool: string } {
  // Anthropic-style: mcp__<server>__<tool>
  const m = /^mcp__([^_]+)__(.+)$/.exec(rawName)
  if (m && mcpServerNames.has(m[1]!)) return { server: m[1], tool: m[2]! }
  // Alternate separator forms
  for (const sep of ['__', ':', '/']) {
    const i = rawName.indexOf(sep)
    if (i > 0 && mcpServerNames.has(rawName.slice(0, i))) {
      return { server: rawName.slice(0, i), tool: rawName.slice(i + sep.length) }
    }
  }
  // Built-in tool or unrecognized — no server
  return { tool: rawName }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `bun --bun vitest run src/core/cursor-agent-provider.test.ts -t mapCursorToolName`
Expected: PASS, all 7 cases.

- [ ] **Step 5: Typecheck + full suite**

Run: `bun run typecheck && bun --bun vitest run`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/core/cursor-agent-provider.ts src/core/cursor-agent-provider.test.ts
git commit -m "feat(cursor-provider): mapCursorToolName multi-format parser

Handles Anthropic-style mcp__server__tool plus alternate separators
(__, :, /) with MCP server-name lookup as the disambiguation.
Cursor SDK docs explicitly say tool name format is unstable; the
parser is defensive and the dispatch loop will log the observed
format on first tool call so we can tighten if needed."
```

---

## Task 5: Cursor `SDKMessage` → `AgentEvent` mapping function

**Files:**
- Modify: `src/core/cursor-agent-provider.ts`
- Modify: `src/core/cursor-agent-provider.test.ts`

Per spike "Event-shape mapping" section. Pure function — easy to test against synthetic messages.

- [ ] **Step 1: Write failing tests**

Append to `src/core/cursor-agent-provider.test.ts`:

```ts
import { mapCursorMessage } from './cursor-agent-provider'
import type { AgentEvent } from './agent-provider'

describe('mapCursorMessage', () => {
  const mcpServers = new Set(['wechat', 'delegate'])

  it('assistant text → assistant_text event', () => {
    const msg = {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    }
    const events = [...mapCursorMessage(msg as never, mcpServers, 'agent-1')]
    expect(events).toEqual([{ kind: 'assistant_text', text: 'hello' }])
  })

  it('assistant tool_use → tool_call event with server/tool', () => {
    const msg = {
      type: 'assistant',
      message: { role: 'assistant', content: [{
        type: 'tool_use', name: 'mcp__wechat__reply',
        input: { text: 'hi' }, id: 'call-1',
      }] },
    }
    const events = [...mapCursorMessage(msg as never, mcpServers, 'agent-1')]
    expect(events).toEqual([{
      kind: 'tool_call', server: 'wechat', tool: 'reply',
    }])
  })

  it('status: FINISHED → result event with agentId as sessionId', () => {
    const msg = { type: 'status', status: 'FINISHED' }
    const events = [...mapCursorMessage(msg as never, mcpServers, 'agent-1')]
    expect(events).toEqual([{ kind: 'result', sessionId: 'agent-1' }])
  })

  it('status: ERROR → result event with error message', () => {
    const msg = { type: 'status', status: 'ERROR', error: { message: 'rate limited' } }
    const events = [...mapCursorMessage(msg as never, mcpServers, 'agent-1')]
    expect(events).toEqual([{
      kind: 'result', sessionId: 'agent-1', error: 'rate limited',
    }])
  })

  it('status: CANCELLED → result event with cancelled error', () => {
    const msg = { type: 'status', status: 'CANCELLED' }
    const events = [...mapCursorMessage(msg as never, mcpServers, 'agent-1')]
    expect(events).toEqual([{
      kind: 'result', sessionId: 'agent-1', error: 'cancelled',
    }])
  })

  it('thinking / system / user / request / task / RUNNING status → dropped', () => {
    const cases: Array<Record<string, unknown>> = [
      { type: 'thinking', text: '...' },
      { type: 'system', subtype: 'init' },
      { type: 'user', message: { role: 'user', content: [] } },
      { type: 'request', request_id: 'r1' },
      { type: 'task', text: 'progress' },
      { type: 'status', status: 'RUNNING' },
      { type: 'status', status: 'CREATING' },
    ]
    for (const msg of cases) {
      const events = [...mapCursorMessage(msg as never, mcpServers, 'agent-1')]
      expect(events).toEqual([])
    }
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `bun --bun vitest run src/core/cursor-agent-provider.test.ts -t mapCursorMessage`
Expected: FAIL — `mapCursorMessage` not exported.

- [ ] **Step 3: Implement mapper**

Append to `src/core/cursor-agent-provider.ts`:

```ts
import type { AgentEvent } from './agent-provider'

/**
 * Narrow shape of @cursor/sdk's SDKMessage discriminated union — only
 * the variants we branch on. The full union has more variants
 * (rate_limit, partial deltas, etc.); we drop them.
 *
 * Defined inline rather than importing from @cursor/sdk so this file
 * remains type-resolvable when the SDK is uninstalled
 * (optionalDependencies). The actual SDK types live alongside
 * Agent.create() in the dynamically-imported module.
 */
interface CursorMessageLike {
  type: string
  message?: { content?: Array<{ type?: string; text?: string; name?: string; input?: unknown }> }
  status?: string
  error?: { message?: string }
}

/**
 * Map one Cursor SDKMessage → zero-or-more AgentEvents.
 *
 * Generator shape so an assistant message with multiple content
 * blocks (text + tool_use + ...) yields each block as a separate
 * AgentEvent. The dispatch loop forwards each yielded event verbatim.
 *
 * `agentId` is the persisted session id; emitted in `result` events
 * so session-store can later resume via Agent.resume(agentId) (P1.1).
 */
export function* mapCursorMessage(
  msg: CursorMessageLike,
  mcpServerNames: ReadonlySet<string>,
  agentId: string,
): Generator<AgentEvent, void, void> {
  if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
    for (const block of msg.message.content) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
        yield { kind: 'assistant_text', text: block.text }
      } else if (block.type === 'tool_use' && typeof block.name === 'string') {
        const { server, tool } = mapCursorToolName(block.name, mcpServerNames)
        if (server !== undefined) {
          yield { kind: 'tool_call', server, tool }
        } else {
          yield { kind: 'tool_call', tool }
        }
      }
    }
    return
  }
  if (msg.type === 'status') {
    if (msg.status === 'FINISHED') {
      yield { kind: 'result', sessionId: agentId }
      return
    }
    if (msg.status === 'ERROR') {
      const errMsg = msg.error?.message ?? 'cursor agent error'
      yield { kind: 'result', sessionId: agentId, error: errMsg }
      return
    }
    if (msg.status === 'CANCELLED') {
      yield { kind: 'result', sessionId: agentId, error: 'cancelled' }
      return
    }
    if (msg.status === 'EXPIRED') {
      yield { kind: 'result', sessionId: agentId, error: 'expired' }
      return
    }
    // RUNNING / CREATING — drop
    return
  }
  // thinking / system / user (echo) / request / task — drop
}
```

- [ ] **Step 4: Run to verify pass**

Run: `bun --bun vitest run src/core/cursor-agent-provider.test.ts -t mapCursorMessage`
Expected: PASS, all 6 cases.

- [ ] **Step 5: Typecheck + full suite**

Run: `bun run typecheck && bun --bun vitest run`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/core/cursor-agent-provider.ts src/core/cursor-agent-provider.test.ts
git commit -m "feat(cursor-provider): mapCursorMessage SDKMessage → AgentEvent

Pure generator: takes one Cursor SDKMessage + the registered MCP
server names + the agentId, yields 0..N AgentEvents. Assistant
messages with multiple content blocks yield each block. Status
FINISHED/ERROR/CANCELLED/EXPIRED map to result events; thinking/
system/user-echo/request/task/RUNNING all drop.

Inline CursorMessageLike narrow type lets the mapper compile
without the @cursor/sdk types — important for the
optionalDependencies path."
```

---

## Task 6: Provider factory + session (`createCursorAgentProvider`)

**Files:**
- Modify: `src/core/cursor-agent-provider.ts`
- Modify: `src/core/cursor-agent-provider.test.ts`

The factory takes the dynamically-imported `@cursor/sdk` namespace + config, returns an `AgentProvider`. `spawn` creates an `Agent`, returns an `AgentSession` whose `dispatch()` calls `agent.send(text)` and streams `Run` events through `mapCursorMessage`.

- [ ] **Step 1: Write failing tests**

Append to `src/core/cursor-agent-provider.test.ts`:

```ts
import { createCursorAgentProvider } from './cursor-agent-provider'
import { TIER_PROFILES } from './user-tier'

// Minimal fake of @cursor/sdk's Agent for unit testing
function makeFakeAgent(scriptedMessages: unknown[]) {
  return {
    agentId: 'agent-test-1',
    async send() {
      return {
        id: 'run-1',
        agentId: 'agent-test-1',
        status: 'RUNNING' as const,
        async *stream() {
          for (const m of scriptedMessages) yield m
        },
        async wait() { return { status: 'completed' } },
        async cancel() {},
      }
    },
    close() {},
    async reload() {},
  }
}

function makeFakeSdk(agent: ReturnType<typeof makeFakeAgent>) {
  return {
    Agent: {
      create: vi.fn(async () => agent),
      resume: vi.fn(async () => agent),
    },
  }
}

describe('createCursorAgentProvider', () => {
  it('spawn calls Agent.create with apiKey + model + mcpServers + tier-derived sandbox', async () => {
    const agent = makeFakeAgent([{ type: 'status', status: 'FINISHED' }])
    const sdk = makeFakeSdk(agent)
    const provider = createCursorAgentProvider({
      sdk,
      apiKey: 'test-key',
      model: 'composer-2',
      mcpServers: { wechat: { command: 'node', args: ['mcp.js'] } },
    })
    const session = await provider.spawn(
      { alias: 'P', path: '/tmp/proj' },
      { tierProfile: TIER_PROFILES.admin, chatId: 'admin-chat' },
    )
    expect(sdk.Agent.create).toHaveBeenCalledTimes(1)
    const createArgs = sdk.Agent.create.mock.calls[0]![0]
    expect(createArgs.apiKey).toBe('test-key')
    expect(createArgs.model).toEqual({ id: 'composer-2' })
    expect(createArgs.mcpServers).toEqual({ wechat: { command: 'node', args: ['mcp.js'] } })
    expect(createArgs.local.cwd).toBe('/tmp/proj')
    expect(createArgs.local.sandboxOptions.enabled).toBe(false)  // admin → sandbox off
    expect(session).toBeDefined()
  })

  it('guest tier results in sandboxOptions.enabled=true', async () => {
    const agent = makeFakeAgent([{ type: 'status', status: 'FINISHED' }])
    const sdk = makeFakeSdk(agent)
    const provider = createCursorAgentProvider({ sdk, apiKey: 'test-key' })
    await provider.spawn(
      { alias: 'P', path: '/tmp/proj' },
      { tierProfile: TIER_PROFILES.guest, chatId: 'guest-chat' },
    )
    const createArgs = sdk.Agent.create.mock.calls[0]![0]
    expect(createArgs.local.sandboxOptions.enabled).toBe(true)
  })

  it('dispatch yields assistant_text events from agent.send stream', async () => {
    const agent = makeFakeAgent([
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] } },
      { type: 'status', status: 'FINISHED' },
    ])
    const sdk = makeFakeSdk(agent)
    const provider = createCursorAgentProvider({ sdk, apiKey: 'test-key' })
    const session = await provider.spawn(
      { alias: 'P', path: '/tmp/proj' },
      { tierProfile: TIER_PROFILES.admin, chatId: 'c' },
    )
    const events = []
    for await (const ev of session.dispatch('hi')) events.push(ev)
    expect(events).toEqual([
      { kind: 'assistant_text', text: 'hello' },
      { kind: 'result', sessionId: 'agent-test-1' },
    ])
  })

  it('close() calls agent.close', async () => {
    const agent = makeFakeAgent([{ type: 'status', status: 'FINISHED' }])
    const closeSpy = vi.spyOn(agent, 'close')
    const sdk = makeFakeSdk(agent)
    const provider = createCursorAgentProvider({ sdk, apiKey: 'test-key' })
    const session = await provider.spawn(
      { alias: 'P', path: '/tmp/proj' },
      { tierProfile: TIER_PROFILES.admin, chatId: 'c' },
    )
    await session.close()
    expect(closeSpy).toHaveBeenCalled()
  })

  it('error during stream becomes result event with error string', async () => {
    const agent = makeFakeAgent([
      { type: 'status', status: 'ERROR', error: { message: 'auth_failed' } },
    ])
    const sdk = makeFakeSdk(agent)
    const provider = createCursorAgentProvider({ sdk, apiKey: 'test-key' })
    const session = await provider.spawn(
      { alias: 'P', path: '/tmp/proj' },
      { tierProfile: TIER_PROFILES.admin, chatId: 'c' },
    )
    const events = []
    for await (const ev of session.dispatch('hi')) events.push(ev)
    expect(events).toContainEqual({ kind: 'result', sessionId: 'agent-test-1', error: 'auth_failed' })
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `bun --bun vitest run src/core/cursor-agent-provider.test.ts -t createCursorAgentProvider`
Expected: FAIL — `createCursorAgentProvider` not exported.

- [ ] **Step 3: Implement provider factory**

Append to `src/core/cursor-agent-provider.ts`:

```ts
import type { AgentProvider, AgentSession, AgentProject } from './agent-provider'

/**
 * Shape of the `@cursor/sdk` module's relevant exports — narrow
 * enough that the factory can compile even when the SDK is absent.
 * The dynamically-imported module is type-erased into this surface.
 */
export interface CursorSdkNamespace {
  Agent: {
    create(options: Record<string, unknown>): Promise<unknown>
    resume?(agentId: string, options?: Record<string, unknown>): Promise<unknown>
  }
}

/**
 * Spec for an MCP server passed to Cursor. Mirrors the stdio variant
 * of Cursor's McpServerConfig (command + args + env), which matches
 * our existing McpStdioSpec from src/daemon/bootstrap/mcp-specs.ts.
 */
export interface CursorMcpStdioSpec {
  command: string
  args?: string[]
  env?: Record<string, string>
}

export interface CursorAgentProviderOptions {
  /** The dynamically-imported `@cursor/sdk` namespace (bootstrap loads it via `await import('@cursor/sdk')`). */
  sdk: CursorSdkNamespace
  /** Required — Cursor API key. Bootstrap reads from `process.env.CURSOR_API_KEY`. */
  apiKey: string
  /** Optional Cursor model id (e.g. `'composer-2'`). When omitted, SDK picks its default. */
  model?: string
  /** MCP servers passed into Agent.create — `wechat` + `delegate` come from the bootstrap. */
  mcpServers?: Record<string, CursorMcpStdioSpec>
}

interface CursorAgentLike {
  agentId: string
  send(message: string): Promise<CursorRunLike>
  close(): void
}
interface CursorRunLike {
  id: string
  agentId: string
  stream(): AsyncIterable<unknown>
  cancel?(): Promise<void>
}

export function createCursorAgentProvider(opts: CursorAgentProviderOptions): AgentProvider {
  const mcpServerNames = new Set(Object.keys(opts.mcpServers ?? {}))
  let firstToolNameLogged = false

  return {
    async spawn(project: AgentProject, spawnOpts) {
      const tierOpts = tierProfileToCursorSdkOpts(spawnOpts.tierProfile)
      const createOptions: Record<string, unknown> = {
        apiKey: opts.apiKey,
        ...(opts.model ? { model: { id: opts.model } } : {}),
        ...(opts.mcpServers ? { mcpServers: opts.mcpServers } : {}),
        local: {
          cwd: project.path,
          sandboxOptions: tierOpts.sandboxOptions,
        },
      }
      const agent = (await opts.sdk.Agent.create(createOptions)) as CursorAgentLike

      return makeCursorSession(agent, mcpServerNames, (rawName) => {
        if (!firstToolNameLogged) {
          firstToolNameLogged = true
          // Single observability log: helps the next engineer notice if
          // the SDK's tool name format diverges from our parser.
          // eslint-disable-next-line no-console
          console.log(`[CURSOR_TOOL] first observed tool name: ${rawName}`)
        }
      })
    },
  }
}

function makeCursorSession(
  agent: CursorAgentLike,
  mcpServerNames: ReadonlySet<string>,
  onFirstToolName: (rawName: string) => void,
): AgentSession {
  return {
    dispatch(text: string) {
      return (async function* dispatchGenerator() {
        let run: CursorRunLike
        try {
          run = await agent.send(text)
        } catch (err) {
          yield { kind: 'result', sessionId: agent.agentId, error: err instanceof Error ? err.message : String(err) } as const
          return
        }
        try {
          for await (const raw of run.stream() as AsyncIterable<CursorMessageLike>) {
            // Side-effect hook: log first observed tool name once
            if (raw?.type === 'assistant' && Array.isArray(raw.message?.content)) {
              for (const block of raw.message.content) {
                if (block.type === 'tool_use' && typeof block.name === 'string') {
                  onFirstToolName(block.name)
                  break
                }
              }
            }
            for (const ev of mapCursorMessage(raw, mcpServerNames, agent.agentId)) {
              yield ev
            }
          }
        } catch (err) {
          yield { kind: 'result', sessionId: agent.agentId, error: err instanceof Error ? err.message : String(err) } as const
        }
      })()
    },
    async close() {
      try { agent.close() } catch { /* swallow */ }
    },
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `bun --bun vitest run src/core/cursor-agent-provider.test.ts`
Expected: all tests pass.

- [ ] **Step 5: Typecheck**

Run: `bun run typecheck`
Expected: clean. Note: `AgentSession.dispatch` returns `AsyncIterable<AgentEvent>`; the generator function matches. `AgentProvider.spawn` signature includes `chatId` (from Task 6 of user-tier feature) — cursor provider accepts it as part of `spawnOpts` but doesn't use it (no canUseTool wiring).

- [ ] **Step 6: Full suite**

Run: `bun --bun vitest run`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/core/cursor-agent-provider.ts src/core/cursor-agent-provider.test.ts
git commit -m "feat(cursor-provider): createCursorAgentProvider factory

Provider conforms to AgentProvider/AgentSession interface. spawn
calls @cursor/sdk's Agent.create with apiKey + model + mcpServers +
tier-derived sandboxOptions. dispatch streams Run events through
mapCursorMessage. close calls agent.close.

The CursorSdkNamespace type is intentionally minimal — the SDK is
loaded via dynamic import at bootstrap, so types come from the
import site at runtime, not from a static import in this file.

First observed MCP tool name is logged once per provider lifetime
so the parser's format guess can be verified at first dispatch."
```

---

## Task 7: Add cursor rows to capability-matrix

**Files:**
- Modify: `src/core/capability-matrix.ts`
- Modify: `src/core/capability-matrix.test.ts` (if it exists)

`assertMatrixComplete(providers)` is called from bootstrap with the registered providers list. When cursor is registered, the matrix must have a row for every (mode × provider × permissionMode) — 4 × 2 = 8 cursor rows.

Cursor has no per-tool callback, no approval policy concept — same shape as codex's rows.

- [ ] **Step 1: Write failing tests (if applicable)**

Look at `src/core/capability-matrix.test.ts`. The existing tests likely assert `lookup` returns expected rows for claude/codex. Add:

```ts
import { lookup } from './capability-matrix'

describe('capability-matrix — cursor rows', () => {
  it('cursor solo strict: askUser=never, replyPrefix=never, no delegate', () => {
    const cap = lookup('solo', 'cursor', 'strict')
    expect(cap.askUser).toBe('never')
    expect(cap.replyPrefix).toBe('never')
    expect(cap.approvalPolicy).toBeNull()
    expect(cap.delegate).toBe('unloaded')
    expect(cap.forbidden).toBe(false)
  })

  it('cursor chatroom dangerously: askUser=never, replyPrefix=always', () => {
    const cap = lookup('chatroom', 'cursor', 'dangerously')
    expect(cap.askUser).toBe('never')
    expect(cap.replyPrefix).toBe('always')
  })

  it('cursor primary_tool: delegate loaded', () => {
    const cap = lookup('primary_tool', 'cursor', 'strict')
    expect(cap.delegate).toBe('loaded')
  })

  it('assertMatrixComplete accepts cursor', () => {
    const { assertMatrixComplete } = require('./capability-matrix') as { assertMatrixComplete: (p: string[]) => void }
    expect(() => assertMatrixComplete(['claude', 'codex', 'cursor'])).not.toThrow()
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `bun --bun vitest run src/core/capability-matrix.test.ts -t cursor`
Expected: FAIL — `lookup('solo', 'cursor', 'strict')` throws "no row" error.

- [ ] **Step 3: Add cursor rows**

In `src/core/capability-matrix.ts`, append to `CAPABILITY_MATRIX` array (after the existing chatroom-codex rows, before the closing `]`):

```ts
  // ─── solo · cursor ──────────────────────────────────────────────
  { mode: 'solo', provider: 'cursor', permissionMode: 'strict',
    askUser: 'never', replyPrefix: 'never', approvalPolicy: null,
    delegate: 'unloaded', forbidden: false,
    notes: 'cursor SDK no per-tool callback; sandboxOptions is the only knob (per-spawn from tierProfile)' },
  { mode: 'solo', provider: 'cursor', permissionMode: 'dangerously',
    askUser: 'never', replyPrefix: 'never', approvalPolicy: null,
    delegate: 'unloaded', forbidden: false, notes: '' },

  // ─── parallel · cursor ──────────────────────────────────────────
  { mode: 'parallel', provider: 'cursor', permissionMode: 'strict',
    askUser: 'never', replyPrefix: 'always', approvalPolicy: null,
    delegate: 'unloaded', forbidden: false, notes: '' },
  { mode: 'parallel', provider: 'cursor', permissionMode: 'dangerously',
    askUser: 'never', replyPrefix: 'always', approvalPolicy: null,
    delegate: 'unloaded', forbidden: false, notes: '' },

  // ─── primary_tool · cursor ──────────────────────────────────────
  { mode: 'primary_tool', provider: 'cursor', permissionMode: 'strict',
    askUser: 'never', replyPrefix: 'on-fallback-only', approvalPolicy: null,
    delegate: 'loaded', forbidden: false,
    notes: 'primary=cursor; claude callable via delegate_claude' },
  { mode: 'primary_tool', provider: 'cursor', permissionMode: 'dangerously',
    askUser: 'never', replyPrefix: 'on-fallback-only', approvalPolicy: null,
    delegate: 'loaded', forbidden: false, notes: '' },

  // ─── chatroom · cursor ──────────────────────────────────────────
  { mode: 'chatroom', provider: 'cursor', permissionMode: 'strict',
    askUser: 'never', replyPrefix: 'always', approvalPolicy: null,
    delegate: 'unloaded', forbidden: false, notes: '' },
  { mode: 'chatroom', provider: 'cursor', permissionMode: 'dangerously',
    askUser: 'never', replyPrefix: 'always', approvalPolicy: null,
    delegate: 'unloaded', forbidden: false, notes: '' },
```

Also update the comment at the end:
```ts
// 4 modes × 3 providers × 2 permissionModes = 24 rows ✓
```

- [ ] **Step 4: Run tests**

Run: `bun --bun vitest run src/core/capability-matrix.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + full suite**

Run: `bun run typecheck && bun --bun vitest run`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/core/capability-matrix.ts src/core/capability-matrix.test.ts
git commit -m "feat(capability-matrix): add cursor rows (8 = 4 modes × 2 perm)

Cursor mirrors codex's coarse-permission stance — askUser='never'
(no per-tool callback in SDK), approvalPolicy=null (Cursor SDK has
no approval policy concept; sandboxOptions is the entire permission
surface, set per-spawn from tierProfile). primary_tool rows load
delegate-mcp; other modes don't.

assertMatrixComplete(['claude','codex','cursor']) now passes —
bootstrap can register all three without the boot-time check
throwing."
```

---

## Task 8: Bootstrap conditional registration

**Files:**
- Modify: `src/daemon/bootstrap/index.ts`
- Modify: `src/daemon/bootstrap.test.ts` (if any new assertions)

After the codex registration block (around line 453-487), add a cursor block that probes `CURSOR_API_KEY` + dynamic `import('@cursor/sdk')`. Both must succeed.

- [ ] **Step 1: Read the existing codex registration block**

Look at `src/daemon/bootstrap/index.ts` lines 453-490 to see the codex pattern. Cursor's block mirrors it closely.

- [ ] **Step 2: Add the cursor block**

After the codex registration (after the codex block's closing `}`):

```ts
  // ──────────────────────────────────────────────────────────────
  // Cursor SDK provider — third registered provider.
  //
  // CURSOR_API_KEY is env-only — not stored in agent-config.json.
  // (Secret-on-disk in plaintext is a worse posture than an env var
  // in the operator's shell rc / systemd unit.) The SDK is loaded via
  // dynamic import so wechat-cc remains installable without
  // @cursor/sdk — operators who don't want Cursor can `bun remove
  // @cursor/sdk` and the registration silently skips.
  //
  // See docs/superpowers/specs/2026-05-23-cursor-sdk-provider-design.md.
  const cursorKey = process.env.CURSOR_API_KEY
  if (cursorKey) {
    try {
      const cursorMod = await import('@cursor/sdk') as unknown as import('../../core/cursor-agent-provider').CursorSdkNamespace
      const cursorWechat = deps.internalApi ? wechatStdioMcpSpec(deps.internalApi, 'cursor') : null
      const cursorDelegate = deps.internalApi ? delegateStdioMcpSpec(deps.internalApi, 'claude') : null
      const { createCursorAgentProvider } = await import('../../core/cursor-agent-provider')
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
          // P1 ships with resume disabled — Agent.resume(agentId) is documented
          // but unverified in the spike beyond static types. Enable in a P1.1
          // follow-up after dogfooding.
          canResume: () => false,
        },
      )
      deps.log('BOOT', 'cursor: SDK + API key present — provider registered')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      deps.log('BOOT', `cursor: SDK not available (${msg}) — run \`bun add @cursor/sdk\` to enable; provider not registered`)
    }
  } else {
    deps.log('BOOT', 'cursor: CURSOR_API_KEY not set — provider not registered')
  }
```

Note: `wechatStdioMcpSpec` and `delegateStdioMcpSpec` are existing functions used by claude/codex registration — reuse them.

- [ ] **Step 3: Verify the existing claude/codex tests still pass**

Run: `bun --bun vitest run src/daemon/bootstrap.test.ts`
Expected: all existing tests pass (no test sets `CURSOR_API_KEY`, so the cursor block silently skips, leaving the registered set as `['claude', 'codex']`).

- [ ] **Step 4: Add a bootstrap test for cursor registration**

Append to `src/daemon/bootstrap.test.ts`:

```ts
it('registers cursor provider when CURSOR_API_KEY is set + @cursor/sdk installed', async () => {
  // @cursor/sdk is already in optionalDependencies; this env-var path is the gate
  const prevKey = process.env.CURSOR_API_KEY
  process.env.CURSOR_API_KEY = 'test-cursor-key'
  try {
    const boot = await buildBootstrapForTest({ /* whatever deps the helper takes */ })
    expect(boot.registry.list()).toContain('cursor')
  } finally {
    if (prevKey === undefined) delete process.env.CURSOR_API_KEY
    else process.env.CURSOR_API_KEY = prevKey
  }
})

it('skips cursor registration when CURSOR_API_KEY is unset', async () => {
  const prevKey = process.env.CURSOR_API_KEY
  delete process.env.CURSOR_API_KEY
  try {
    const boot = await buildBootstrapForTest({ /* ... */ })
    expect(boot.registry.list()).not.toContain('cursor')
  } finally {
    if (prevKey !== undefined) process.env.CURSOR_API_KEY = prevKey
  }
})
```

Adapt to the actual `buildBootstrapForTest` helper / fixture pattern in `bootstrap.test.ts`. Look at the existing codex registration tests for guidance.

- [ ] **Step 5: Run + typecheck**

Run: `bun --bun vitest run src/daemon/bootstrap.test.ts && bun run typecheck`
Expected: PASS, clean.

- [ ] **Step 6: Commit**

```bash
git add src/daemon/bootstrap/index.ts src/daemon/bootstrap.test.ts
git commit -m "feat(bootstrap): conditional cursor provider registration

Registers 'cursor' on the daemon's ProviderRegistry when both
CURSOR_API_KEY is set AND @cursor/sdk imports successfully. Either
missing → silent skip with [BOOT] log entry. cursorModel from
agent-config.json (if set) flows into Agent.create's model option.

wechat-mcp + delegate-mcp wired through Cursor's mcpServers config —
same shape as the claude / codex registrations."
```

---

## Task 9: `/cursor` slash command verification

**Files:**
- (Verify only) `src/daemon/mode-commands.ts`
- Possibly modify: `src/daemon/mode-commands.test.ts`

The slash command parser already accepts arbitrary `ProviderId` strings. If you grep `mode-commands.ts` for the existing claude/codex shortcuts, the pattern is likely a switch/lookup. We need to add `'/cursor'` to whatever list exists.

- [ ] **Step 1: Read the existing slash command shape**

Run: `grep -n "'/cc'\|'/codex'\|'/claude'\|case.*claude\|case.*codex" src/daemon/mode-commands.ts`

Find the dispatch table or switch that maps slash commands to mode-set calls.

- [ ] **Step 2: Add `/cursor` to the dispatch**

Mirror the `/codex` entry. The mode-commands likely has:

```ts
if (text === '/codex') { coordinator.setMode(chatId, { kind: 'solo', provider: 'codex' }); ... }
```

Add the parallel:

```ts
if (text === '/cursor') { coordinator.setMode(chatId, { kind: 'solo', provider: 'cursor' }); ... }
```

If `setMode` validates against the registry, the registry must have cursor registered for the command to succeed at runtime. Already covered by Task 8.

- [ ] **Step 3: Add a test**

Append to `src/daemon/mode-commands.test.ts`:

```ts
it('/cursor sets mode to solo+cursor', async () => {
  const setMode = vi.fn()
  const cmds = makeModeCommands({
    coordinator: { setMode, getMode: () => ({ kind: 'solo', provider: 'claude' }), cancel: () => false },
    defaultProviderId: 'claude',
    sendMessage: vi.fn(async () => ({ msgId: 'm1' })),
    log: () => {},
  })
  const handled = await cmds.handle({ chatId: 'c1', userId: 'u', text: '/cursor', msgType: 'text', createTimeMs: Date.now(), accountId: 'a' })
  expect(handled).toBe(true)
  expect(setMode).toHaveBeenCalledWith('c1', { kind: 'solo', provider: 'cursor' })
})
```

(Adapt to the actual test helper shape used in `mode-commands.test.ts`.)

- [ ] **Step 4: Run + typecheck**

Run: `bun --bun vitest run src/daemon/mode-commands.test.ts && bun run typecheck`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/mode-commands.ts src/daemon/mode-commands.test.ts
git commit -m "feat(mode-commands): /cursor slash command

Mirrors /cc and /codex shape. The coordinator's setMode validates
against the provider registry, so /cursor returns an error message
when cursor isn't registered (no CURSOR_API_KEY or @cursor/sdk not
installed)."
```

---

## Task 10: Fake Cursor SDK + spawn recorder in `fake-sdk.ts`

**Files:**
- Modify: `src/daemon/__e2e__/fake-sdk.ts`

The e2e harness installs fake SDKs to avoid hitting real models. Adding fake cursor support: `installFakeCursor(script)` + `installCursorSpawnRecorder(callback)`, mirroring the existing claude + codex shapes.

- [ ] **Step 1: Read existing fake-sdk patterns**

Run: `grep -n "installFakeCodex\|installFakeClaude\|installClaudeSpawnRecorder\|installCodexSpawnRecorder" src/daemon/__e2e__/fake-sdk.ts | head`

Look at `installFakeCodex` + `installCodexSpawnRecorder` (added in the codex tier e2e task) — `installFakeCursor` mirrors them. The fake-sdk uses `vi.mock` to intercept the SDK's module exports.

- [ ] **Step 2: Add fake cursor + recorder**

Append to `src/daemon/__e2e__/fake-sdk.ts`:

```ts
import { vi } from 'vitest'

export interface FakeCursorScript {
  /** Messages the fake agent's run.stream() should yield. */
  messages: ReadonlyArray<unknown>
  /** Optional: log of all dispatched prompts. */
  dispatched?: string[]
}

let cursorSpawnRecorder: ((options: Record<string, unknown>) => void) | null = null

export function installCursorSpawnRecorder(): { uninstall(): void } {
  const snapshots: Record<string, unknown>[] = []
  cursorSpawnRecorder = (options) => { snapshots.push(options) }
  return {
    uninstall() { cursorSpawnRecorder = null },
    get snapshots() { return snapshots },
  } as never
}

export function installFakeCursor(script: FakeCursorScript): { uninstall(): void } {
  vi.mock('@cursor/sdk', () => {
    let counter = 0
    return {
      Agent: {
        create: vi.fn(async (options: Record<string, unknown>) => {
          if (cursorSpawnRecorder) cursorSpawnRecorder(options)
          counter++
          const agentId = `fake-cursor-agent-${counter}`
          return {
            agentId,
            async send(prompt: string) {
              script.dispatched?.push(prompt)
              return {
                id: `run-${counter}`,
                agentId,
                async *stream() {
                  for (const m of script.messages) yield m
                },
                async wait() { return { status: 'completed' } },
                async cancel() {},
              }
            },
            close() {},
            async reload() {},
          }
        }),
        resume: vi.fn(async () => { throw new Error('fake cursor SDK: resume not implemented') }),
      },
    }
  })
  return {
    uninstall() {
      vi.unmock('@cursor/sdk')
      cursorSpawnRecorder = null
    },
  }
}
```

Adapt to the actual import/export style used by the existing fake-sdk functions — if they use `vi.doMock` with a factory call inside a setup hook, follow that pattern instead.

- [ ] **Step 3: Run existing e2e suite to ensure no regression**

Run: `bun --bun vitest run -c vitest.e2e.config.ts`
Expected: all 13+ existing e2e tests still pass — the new exports are unused so they have no effect yet.

- [ ] **Step 4: Typecheck**

Run: `bun run typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/__e2e__/fake-sdk.ts
git commit -m "test(e2e): installFakeCursor + installCursorSpawnRecorder

Parallel to installFakeClaude/Codex + installClaudeSpawnRecorder/
installCodexSpawnRecorder. Lets the upcoming dispatch-solo-cursor
and user-tier-cursor e2e tests drive cursor with scripted
messages + inspect spawn options (sandboxOptions etc.)."
```

---

## Task 11: harness `recordCursorSpawnOptions` hook

**Files:**
- Modify: `src/daemon/__e2e__/harness.ts`

The harness already takes `recordClaudeSpawnOptions?` and `recordCodexSpawnOptions?` opt-in hooks. Add the cursor parallel.

- [ ] **Step 1: Add the field + wiring**

In `src/daemon/__e2e__/harness.ts`, find `TestDaemonOpts` (or whatever the harness's options interface is called) — it already has the claude/codex variants. Add:

```ts
/** Opt-in: receive the AgentOptions object that Cursor's Agent.create was called with. */
recordCursorSpawnOptions?: (options: Record<string, unknown>) => void
```

Then in the harness setup (where `installCodexSpawnRecorder` is called if `recordCodexSpawnOptions` is set), add the parallel:

```ts
if (opts.recordCursorSpawnOptions) {
  // installCursorSpawnRecorder wires a module-level closure inside fake-sdk
  // that fakeCursor's Agent.create calls before returning.
  installCursorSpawnRecorder()
  // ... harness handle records snapshots → forwards to recordCursorSpawnOptions
}
```

Adapt to the actual recorder API exposed by `fake-sdk.ts` from Task 10.

- [ ] **Step 2: Run existing e2e tests for regression check**

Run: `bun --bun vitest run -c vitest.e2e.config.ts`
Expected: all pass — the new hook is unused.

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/daemon/__e2e__/harness.ts
git commit -m "test(e2e): harness recordCursorSpawnOptions hook

Opt-in callback, parallel to recordClaudeSpawnOptions /
recordCodexSpawnOptions. Used by user-tier-cursor.e2e.test.ts to
verify tier-mapped sandboxOptions flow through to Agent.create."
```

---

## Task 12: `dispatch-solo-cursor.e2e.test.ts`

**Files:**
- Create: `src/daemon/__e2e__/dispatch-solo-cursor.e2e.test.ts`

Mirror of `dispatch-solo-codex.e2e.test.ts`. Boots the daemon with fake cursor + fake ilink, sends an inbound from a known chat, asserts cursor receives the dispatch and the reply tool fires an outbound.

- [ ] **Step 1: Read the existing codex e2e for the pattern**

```bash
cat src/daemon/__e2e__/dispatch-solo-codex.e2e.test.ts | head -80
```

Note: it likely calls `installFakeCodex` with a script that emits a tool_use for `mcp__wechat__reply`, asserts an outbound `sendmessage` lands in fake-ilink.

- [ ] **Step 2: Write the cursor e2e**

Create `src/daemon/__e2e__/dispatch-solo-cursor.e2e.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { startTestDaemon, type TestDaemonHandle } from './harness'

describe('e2e: solo cursor — inbound dispatched, reply MCP tool fires outbound', () => {
  let daemon: TestDaemonHandle | null = null

  afterEach(async () => {
    if (daemon) {
      await daemon.stop()
      daemon = null
    }
  })

  it('inbound from cursor-bound chat → Cursor dispatch → mcp__wechat__reply → outbound', async () => {
    daemon = await startTestDaemon({
      env: { CURSOR_API_KEY: 'test-cursor-key' },
      cursorScript: {
        messages: [
          {
            type: 'assistant',
            message: {
              role: 'assistant',
              content: [
                { type: 'tool_use', name: 'mcp__wechat__reply', input: { text: 'hi from cursor' }, id: 'call-1' },
              ],
            },
          },
          { type: 'status', status: 'FINISHED' },
        ],
      },
      // Pin the test chat to cursor via mode
      modeForChat: { c1: { kind: 'solo', provider: 'cursor' } },
      access: {
        dmPolicy: 'allowlist',
        allowFrom: ['c1'],
        admins: ['c1'],
      },
    })

    daemon.sendInbound({ chatId: 'c1', userId: 'c1', text: 'hello', msgType: 'text' })
    await daemon.waitForOutboundCount(1, 5_000)
    const outbound = daemon.getOutbound()
    expect(outbound).toHaveLength(1)
    expect(outbound[0]?.text).toBe('hi from cursor')
  })
})
```

Adapt parameter names to the actual `startTestDaemon` API — e.g., the existing codex e2e likely uses `claudeScript` / `codexScript`. Add `cursorScript` symmetrically. (If the harness doesn't take `cursorScript`, add it as part of this task — same pattern as the codex one.)

- [ ] **Step 3: Run the new test**

Run: `bun --bun vitest run -c vitest.e2e.config.ts src/daemon/__e2e__/dispatch-solo-cursor.e2e.test.ts`
Expected: PASS.

- [ ] **Step 4: Full e2e + unit**

Run: `bun --bun vitest run -c vitest.e2e.config.ts && bun --bun vitest run`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/__e2e__/dispatch-solo-cursor.e2e.test.ts src/daemon/__e2e__/harness.ts
git commit -m "test(e2e): dispatch-solo-cursor — inbound → reply MCP → outbound

Boots daemon with fake @cursor/sdk + CURSOR_API_KEY=test, pins chat
c1 to solo+cursor mode, sends an inbound, asserts the cursor session
fires mcp__wechat__reply which lands as a sendmessage outbound in
fake-ilink. Mirror of dispatch-solo-codex.e2e.test.ts."
```

---

## Task 13: `user-tier-cursor.e2e.test.ts`

**Files:**
- Create: `src/daemon/__e2e__/user-tier-cursor.e2e.test.ts`

Mirror of `user-tier-codex.e2e.test.ts`. Two chats — admin and guest — both routed through cursor. Spawn snapshots prove tier → sandboxOptions wiring works end-to-end.

- [ ] **Step 1: Read the existing cursor codex parallel**

```bash
cat src/daemon/__e2e__/user-tier-codex.e2e.test.ts
```

- [ ] **Step 2: Write the cursor e2e**

Create `src/daemon/__e2e__/user-tier-cursor.e2e.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { startTestDaemon, type TestDaemonHandle } from './harness'

describe('e2e: user-tier × cursor — tier maps to sandboxOptions', () => {
  let daemon: TestDaemonHandle | null = null
  const spawnSnapshots: Array<Record<string, unknown>> = []

  afterEach(async () => {
    if (daemon) { await daemon.stop(); daemon = null }
    spawnSnapshots.length = 0
  })

  it('admin chat → sandbox disabled; guest chat → sandbox enabled', async () => {
    daemon = await startTestDaemon({
      env: { CURSOR_API_KEY: 'test-cursor-key' },
      cursorScript: {
        messages: [{ type: 'status', status: 'FINISHED' }],
      },
      access: {
        dmPolicy: 'allowlist',
        allowFrom: ['admin_chat', 'guest_chat'],
        admins: ['admin_chat'],
        // guest_chat is in allowFrom but NOT admins → guest tier
      },
      modeForChat: {
        admin_chat: { kind: 'solo', provider: 'cursor' },
        guest_chat: { kind: 'solo', provider: 'cursor' },
      },
      recordCursorSpawnOptions: (opts) => { spawnSnapshots.push(opts) },
    })

    // Send from admin, wait for completion, then from guest
    daemon.sendInbound({ chatId: 'admin_chat', userId: 'admin_chat', text: 'hi', msgType: 'text' })
    await daemon.waitForDispatchToComplete('admin_chat', 5_000)
    daemon.sendInbound({ chatId: 'guest_chat', userId: 'guest_chat', text: 'hi', msgType: 'text' })
    await daemon.waitForDispatchToComplete('guest_chat', 5_000)

    expect(spawnSnapshots.length).toBeGreaterThanOrEqual(2)

    const adminSnap = spawnSnapshots.find((s) => {
      const local = s.local as Record<string, unknown> | undefined
      return (local?.sandboxOptions as { enabled?: boolean } | undefined)?.enabled === false
    })
    expect(adminSnap).toBeDefined()

    const guestSnap = spawnSnapshots.find((s) => {
      const local = s.local as Record<string, unknown> | undefined
      return (local?.sandboxOptions as { enabled?: boolean } | undefined)?.enabled === true
    })
    expect(guestSnap).toBeDefined()
  })
})
```

Adapt the harness API names — `waitForDispatchToComplete` may be `waitForRunCompletion` or similar in the actual harness; check the existing user-tier-codex test for the right primitive.

- [ ] **Step 3: Run the new test**

Run: `bun --bun vitest run -c vitest.e2e.config.ts src/daemon/__e2e__/user-tier-cursor.e2e.test.ts`
Expected: PASS.

- [ ] **Step 4: Full suite**

Run: `bun --bun vitest run -c vitest.e2e.config.ts && bun --bun vitest run`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/__e2e__/user-tier-cursor.e2e.test.ts
git commit -m "test(e2e): user-tier-cursor — tier maps to sandboxOptions

Two chats, same alias, both pinned to solo+cursor. Admin chat's
spawn snapshot has sandboxOptions.enabled=false; guest chat's has
sandboxOptions.enabled=true. Proves the chain resolveTier →
tierProfile → tierProfileToCursorSdkOpts → Agent.create wires
correctly. Mirror of user-tier-codex.e2e.test.ts."
```

---

## Task 14: Doctor probe for cursor

**Files:**
- Modify: `src/cli/doctor.ts`
- Modify: `src/cli/schema.ts` (DoctorReport interface)
- Modify: `src/cli/doctor.test.ts` (if it exists)

`wechat-cc doctor --json` already reports claude + codex presence. Add cursor: probe `CURSOR_API_KEY` + try to `require.resolve('@cursor/sdk')` (or dynamic import).

- [ ] **Step 1: Find existing claude/codex probe in doctor.ts**

Run: `grep -n "claudeAvailable\|codexAvailable\|claudeBinary\|codex.*check" src/cli/doctor.ts | head`

The doctor probes for SDKs/binaries and reports `{ok, path?, version?}` per provider.

- [ ] **Step 2: Add a cursor probe**

Mirror the existing pattern. Cursor doesn't have a binary in PATH (unlike codex CLI), so the probe is:
- `CURSOR_API_KEY` set?
- `@cursor/sdk` resolvable?

```ts
function probeCursor(): { ok: boolean; apiKeySet: boolean; sdkInstalled: boolean } {
  const apiKeySet = !!process.env.CURSOR_API_KEY
  let sdkInstalled = false
  try {
    require.resolve('@cursor/sdk')
    sdkInstalled = true
  } catch { /* not installed */ }
  return { ok: apiKeySet && sdkInstalled, apiKeySet, sdkInstalled }
}
```

In the JSON output structure, add a `cursor` field next to `claude` / `codex`:

```ts
checks: {
  claude: { ok: ... },
  codex: { ok: ... },
  cursor: { ok, apiKeySet, sdkInstalled },
  // ...
}
```

Update `DoctorCheckBase` / similar interface in `src/cli/schema.ts` to include the cursor field.

- [ ] **Step 3: Update the human-readable output**

If doctor has a non-JSON mode (`wechat-cc doctor` without `--json`), find the section that prints `claude: ok` / `codex: missing` and add a cursor line.

- [ ] **Step 4: Add a test (if doctor.test.ts exists)**

```ts
it('reports cursor as registered when CURSOR_API_KEY set + @cursor/sdk installed', () => {
  const prev = process.env.CURSOR_API_KEY
  process.env.CURSOR_API_KEY = 'test'
  try {
    const report = runDoctorForTest()
    expect(report.checks.cursor.ok).toBe(true)
  } finally {
    if (prev === undefined) delete process.env.CURSOR_API_KEY
    else process.env.CURSOR_API_KEY = prev
  }
})
```

- [ ] **Step 5: Run + typecheck**

Run: `bun --bun vitest run src/cli/doctor.test.ts && bun run typecheck`
Expected: PASS, clean.

- [ ] **Step 6: Commit**

```bash
git add src/cli/doctor.ts src/cli/doctor.test.ts src/cli/schema.ts
git commit -m "feat(doctor): probe cursor SDK + CURSOR_API_KEY

\`wechat-cc doctor --json\` now reports cursor's status:
{ ok, apiKeySet, sdkInstalled }. Both must be true for the daemon
to register cursor at boot. The human-readable doctor output gets
a parallel 'cursor: ok / missing api key / missing sdk' line."
```

---

## Task 15: README update

**Files:**
- Modify: `README.md`

Two edits: brief note that cursor is the third provider, and a Known-limitations entry about tier coarseness.

- [ ] **Step 1: Find the existing provider mention in README**

Run: `grep -n "claude\|codex\|provider" README.md | head -20`

The README likely lists `/cc` / `/codex` as slash commands. Add `/cursor`.

- [ ] **Step 2: Add `/cursor` to the slash-command section**

Wherever `/cc` and `/codex` are documented, add the parallel `/cursor` entry. Match the existing tone.

- [ ] **Step 3: Add the Known-limitations entry**

In the `## Known limitations` section, append:

```markdown
- **Cursor tier enforcement is the coarsest of the three providers** — Cursor SDK
  has only one permission knob (`local.sandboxOptions.enabled`). Admin tier disables
  the sandbox; trusted + guest both enable it. There's no read-only-mode equivalent
  to Codex's guest tier, so a guest using Cursor can write inside the project's
  working directory. If you have guests you don't trust to write inside cwd, route
  them to Claude (whose `disallowedTools` array enforces strict per-tool blocks
  for guest tier).
```

- [ ] **Step 4: Add a setup note**

If there's an installation / configuration section, add a brief note:

```markdown
### Cursor (optional third provider)

To enable Cursor:

1. `bun add @cursor/sdk` (if not already installed — it's in optionalDependencies)
2. Set `CURSOR_API_KEY` in your shell or systemd unit
3. Restart the daemon. `wechat-cc doctor` should show `cursor: ok`.
4. Send `/cursor` in WeChat to route that chat to Cursor.

You can persist Cursor as your default provider via:
\`wechat-cc provider set cursor --model composer-2\`
```

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs(readme): document cursor as third provider + tier caveats

Adds /cursor slash command to the slash command list, the
'Cursor tier enforcement is coarsest' note to Known limitations,
and a brief setup section explaining bun add @cursor/sdk +
CURSOR_API_KEY + doctor verification."
```

---

## Task 16: Acceptance verification

**Files:** None (verification only)

End-to-end smoke. Verify the full chain is healthy before declaring P1 done.

- [ ] **Step 1: Full typecheck**

Run: `bun run typecheck`
Expected: clean.

- [ ] **Step 2: Full unit suite**

Run: `bun --bun vitest run`
Expected: all pass.

- [ ] **Step 3: Full e2e suite**

Run: `bun --bun vitest run -c vitest.e2e.config.ts`
Expected: all pass — including the two new cursor e2e tests.

- [ ] **Step 4: Manual smoke test (optional, requires CURSOR_API_KEY)**

If you have a real Cursor API key:

1. `CURSOR_API_KEY=<key> bun run cli.ts run` (or equivalent dev-run command)
2. From WeChat, send `/cursor` to the bound bot
3. Send a follow-up message — should be dispatched to Cursor, reply lands in WeChat
4. Check daemon logs for `[CURSOR_TOOL] first observed tool name: <X>` — the value of `<X>` confirms which tool-name format Cursor actually emits

If the format isn't `mcp__server__tool` (Anthropic-style), file a follow-up to tighten `mapCursorToolName` based on the observed shape. Not blocking — the parser handles multiple formats.

- [ ] **Step 5: Doctor verification**

Run: `bun run cli.ts doctor --json | jq .checks.cursor`
Expected:
- With `CURSOR_API_KEY` unset: `{ "ok": false, "apiKeySet": false, "sdkInstalled": true }` (or similar)
- With `CURSOR_API_KEY` set + `@cursor/sdk` installed: `{ "ok": true, "apiKeySet": true, "sdkInstalled": true }`

- [ ] **Step 6: Modular install verification**

Run: `bun remove @cursor/sdk`
Run: `bun run cli.ts run` (or however dev-mode is run)
Expected: log line `cursor: SDK not available (...) — run \`bun add @cursor/sdk\` to enable; provider not registered`

Then restore: `bun add @cursor/sdk@^1.0.12`

- [ ] **Step 7: Final commit (only if anything accumulated)**

If any small fixes surfaced during the acceptance pass that aren't already committed:

```bash
git status
git add <files>
git commit -m "fix(cursor): <what>"
```

---

## Acceptance gate

P1 done when all of these hold:

- [ ] `bun run typecheck` clean
- [ ] `bun --bun vitest run` full unit suite passes
- [ ] `bun --bun vitest run -c vitest.e2e.config.ts` full e2e suite passes (including 2 new cursor tests)
- [ ] `dispatch-solo-cursor.e2e.test.ts` passes
- [ ] `user-tier-cursor.e2e.test.ts` passes (admin spawn snapshot has `sandboxOptions.enabled=false`; guest snapshot has `enabled=true`)
- [ ] `wechat-cc doctor --json` reports cursor status accurately
- [ ] `bun remove @cursor/sdk` causes silent skip with informative log; existing claude/codex paths unaffected
- [ ] `bun add @cursor/sdk` + `CURSOR_API_KEY=x` causes cursor to register at boot
- [ ] README documents `/cursor`, the modular install path, and the tier-coarseness caveat

## Self-review notes (for the executing engineer)

- Cursor SDK's `SDKMessage` types are RICH (many variants); the provider only branches on `assistant` + `status`. Other variants drop. Don't over-engineer.
- The first-tool-name console.log in the provider is intentional — single observability hook so the next engineer can spot a parser format mismatch. If it gets noisy in production, gate it behind `WECHAT_DEBUG_CURSOR=1`.
- `tierProfileToCursorSdkOpts` uses the same size-based heuristic as `tierProfileToCodexSdkOpts` — works for the 3 default profiles. If a custom profile arrives with `relay+deny=0` but isn't admin, the heuristic mis-classifies it. Today there are no custom profiles. Document at the function header so future profile authors know.
- Mode-commands' `/cursor` validation will fail when cursor isn't registered. That's intentional — the user gets a clear "unknown provider" error, not a silent dispatch elsewhere.
- The dynamic import path in bootstrap is `await import('@cursor/sdk')` (string literal, not a variable). This is important — bundlers can see the literal and skip the dep when it's absent. A dynamic-string import wouldn't get this treatment.
- If `wechat-cc-cli` is compiled with `bun build --compile`, the bundler resolves `@cursor/sdk` at compile time. Users compiling from source without the package installed need `bun install` first; with the package as an `optionalDependency`, this happens by default unless they explicitly removed it.
- Cursor SDK pinned at `^1.0.12` per spike. The SDK is public-beta and the docs explicitly warn that tool-call schema is unstable. If the spike's version goes EOL, re-validate `mapCursorMessage` + `mapCursorToolName` against the new types before bumping.
- No P2 (Claude API direct) work in this plan — deferred per the 2026-05-08 spec.
- No P3 (N-way modes) work in this plan — follow-up after P1 is dogfooded.
- No session resume in P1 — `canResume: () => false`. P1.1 follow-up adds `Agent.resume(agentId)` wiring + session-store persistence.
