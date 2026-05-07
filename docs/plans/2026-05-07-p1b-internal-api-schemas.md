# P1.B · internal-api Zod Schemas Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add zod schemas for all 24 routes in `src/daemon/internal-api/`. Inject body / query validation at request entry. Tighten handler signatures via `z.infer`. Type-only contract — no consumer-side runtime validation (MCP server clients keep hand-crafting requests for now).

**Architecture:** `src/daemon/internal-api/schema.ts` is the single source of truth. `index.ts` looks up the schema by `${method} ${path}` and parses the body / query before dispatch; rejects with 400 on mismatch. `routes.ts` handlers use `z.infer<typeof X>` for parameter types so the body access pattern becomes statically typed.

**Tech Stack:** zod v4 (already in `package.json`), TypeScript 6, vitest, Bun runtime.

**Reference spec:** `docs/specs/2026-05-07-api-contract-and-agent-session.md` §P1.B

**Discovery checklist:**
- All 24 routes are in `src/daemon/internal-api/routes.ts`. The route key format is `'METHOD /v1/path'`.
- Each handler's body shape is hand-rolled with `(body as { field?: unknown } | null)?.field` ladders — those are the schema fields.
- Each handler's response shape is the `body` field of `{ status, body }` returned objects (often union: success vs error).
- Read the full file at the start: `cat src/daemon/internal-api/routes.ts`.

---

### Task 1: schema.ts skeleton + health/memory routes (4 routes)

**Files:**
- Create: `src/daemon/internal-api/schema.ts`
- Create: `src/daemon/internal-api/schema.test.ts`

- [ ] **Step 1: Read the routes for these 4 endpoints**

```bash
sed -n '23,57p' src/daemon/internal-api/routes.ts
```

Note the body shapes:
- `GET /v1/health` — no body; response `{ ok: true, daemon_pid: number }`
- `POST /v1/memory/read` — body `{ path: string }`; response union of `{ exists: false }`, `{ exists: true, content }`, `{ error }`
- `POST /v1/memory/write` — body `{ path, content }`; response union of `{ ok: true }`, `{ ok: false, error }`
- `GET /v1/memory/list` — query `{ dir?: string }`; response `{ files: string[] } | { error }`

- [ ] **Step 2: Write failing tests**

```ts
// src/daemon/internal-api/schema.test.ts
import { describe, it, expect } from 'vitest'
import {
  HealthResponse,
  MemoryReadRequest, MemoryReadResponse,
  MemoryWriteRequest, MemoryWriteResponse,
  MemoryListQuery, MemoryListResponse,
} from './schema'

describe('HealthResponse', () => {
  it('accepts valid response', () => {
    expect(HealthResponse.safeParse({ ok: true, daemon_pid: 12345 }).success).toBe(true)
  })
  it('rejects missing daemon_pid', () => {
    expect(HealthResponse.safeParse({ ok: true }).success).toBe(false)
  })
})

describe('MemoryReadRequest', () => {
  it('accepts { path }', () => {
    expect(MemoryReadRequest.safeParse({ path: 'foo/bar.md' }).success).toBe(true)
  })
  it('rejects missing path', () => {
    expect(MemoryReadRequest.safeParse({}).success).toBe(false)
  })
})

describe('MemoryReadResponse', () => {
  it('accepts exists=false', () => {
    expect(MemoryReadResponse.safeParse({ exists: false }).success).toBe(true)
  })
  it('accepts exists=true with content', () => {
    expect(MemoryReadResponse.safeParse({ exists: true, content: 'hi' }).success).toBe(true)
  })
  it('accepts error variant', () => {
    expect(MemoryReadResponse.safeParse({ error: 'ENOENT' }).success).toBe(true)
  })
})

describe('MemoryWriteRequest', () => {
  it('accepts { path, content }', () => {
    expect(MemoryWriteRequest.safeParse({ path: 'a.md', content: 'b' }).success).toBe(true)
  })
  it('rejects missing content', () => {
    expect(MemoryWriteRequest.safeParse({ path: 'a.md' }).success).toBe(false)
  })
})

describe('MemoryWriteResponse', () => {
  it('accepts ok=true', () => {
    expect(MemoryWriteResponse.safeParse({ ok: true }).success).toBe(true)
  })
  it('accepts ok=false with error', () => {
    expect(MemoryWriteResponse.safeParse({ ok: false, error: 'EACCES' }).success).toBe(true)
  })
})

describe('MemoryListQuery', () => {
  it('accepts empty query', () => {
    expect(MemoryListQuery.safeParse({}).success).toBe(true)
  })
  it('accepts { dir }', () => {
    expect(MemoryListQuery.safeParse({ dir: 'sub' }).success).toBe(true)
  })
})

describe('MemoryListResponse', () => {
  it('accepts file array', () => {
    expect(MemoryListResponse.safeParse({ files: ['a.md', 'b.md'] }).success).toBe(true)
  })
  it('accepts error variant', () => {
    expect(MemoryListResponse.safeParse({ error: 'EBADF' }).success).toBe(true)
  })
})
```

- [ ] **Step 3: Run tests, expect failure**

```bash
bun --bun vitest run src/daemon/internal-api/schema.test.ts
```

Expected: FAIL — "Cannot find module './schema'".

- [ ] **Step 4: Implement the schemas**

```ts
// src/daemon/internal-api/schema.ts
/**
 * Zod schemas for every internal-api route. Single source of truth for
 * the HTTP contract between the daemon and its in-process / out-of-process
 * clients (wechat-mcp stdio child, delegate-mcp dispatch).
 *
 * Convention: <SchemaName> is the zod value; <SchemaName>T is the
 * inferred TS type (added in Task 6 when the lookup tables are wired).
 *
 * Validation is performed by index.ts BEFORE the route handler runs.
 * Handler logic in routes.ts uses z.infer<typeof Request> for body
 * typing, so handlers never reach into `body as { ... }` casts.
 */
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

// POST /v1/memory/write
export const MemoryWriteRequest = z.object({
  path: z.string(),
  content: z.string(),
})
export const MemoryWriteResponse = z.union([
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), error: z.string() }),
])

// GET /v1/memory/list?dir=...
export const MemoryListQuery = z.object({
  dir: z.string().optional(),
})
export const MemoryListResponse = z.union([
  z.object({ files: z.array(z.string()) }),
  z.object({ error: z.string() }),
])
```

- [ ] **Step 5: Run tests, expect pass**

```bash
bun --bun vitest run src/daemon/internal-api/schema.test.ts
```

Expected: PASS — 14 tests.

- [ ] **Step 6: Commit**

```bash
git add src/daemon/internal-api/schema.ts src/daemon/internal-api/schema.test.ts
git commit -m "feat(internal-api): zod schemas for health + memory routes"
```

---

### Task 2: Schema batch — projects + user (5 routes)

**Files:**
- Modify: `src/daemon/internal-api/schema.ts`
- Modify: `src/daemon/internal-api/schema.test.ts`

- [ ] **Step 1: Read the routes**

```bash
sed -n '59,113p' src/daemon/internal-api/routes.ts
```

Routes:
- `GET /v1/projects/list` — no body; response is the legacy raw array (not wrapped). Determine the array element shape from `WechatProjectsDep.list` in `src/daemon/wechat-tool-deps.ts`.
- `POST /v1/projects/switch` — body `{ alias: string }`; response is whatever `deps.projects.switchTo(alias)` returns.
- `POST /v1/projects/add` — body `{ alias, path }`; response `{ ok: true } | { ok: false, error }`.
- `POST /v1/projects/remove` — body `{ alias }`; response `{ ok: true } | { ok: false, error }`.
- `POST /v1/user/set_name` — body `{ chat_id, name }` (snake_case! intentional); response `{ ok: true } | { ok: false, error }`.

- [ ] **Step 2: Write failing tests**

Append to `schema.test.ts`:

```ts
import {
  ProjectsListResponse,
  ProjectsSwitchRequest, ProjectsSwitchResponse,
  ProjectsAddRequest, ProjectsAddResponse,
  ProjectsRemoveRequest, ProjectsRemoveResponse,
  UserSetNameRequest, UserSetNameResponse,
} from './schema'

describe('ProjectsListResponse', () => {
  it('accepts an empty array', () => {
    expect(ProjectsListResponse.safeParse([]).success).toBe(true)
  })
  it('accepts an array with items', () => {
    expect(ProjectsListResponse.safeParse([{ alias: 'foo', path: '/tmp' }]).success).toBe(true)
  })
})

describe('ProjectsSwitchRequest', () => {
  it('accepts { alias }', () => {
    expect(ProjectsSwitchRequest.safeParse({ alias: 'foo' }).success).toBe(true)
  })
  it('rejects missing alias', () => {
    expect(ProjectsSwitchRequest.safeParse({}).success).toBe(false)
  })
})

describe('ProjectsAddRequest', () => {
  it('accepts { alias, path }', () => {
    expect(ProjectsAddRequest.safeParse({ alias: 'foo', path: '/tmp' }).success).toBe(true)
  })
  it('rejects missing path', () => {
    expect(ProjectsAddRequest.safeParse({ alias: 'foo' }).success).toBe(false)
  })
})

describe('ProjectsAddResponse', () => {
  it('accepts ok=true', () => {
    expect(ProjectsAddResponse.safeParse({ ok: true }).success).toBe(true)
  })
  it('accepts ok=false with error', () => {
    expect(ProjectsAddResponse.safeParse({ ok: false, error: 'duplicate' }).success).toBe(true)
  })
})

describe('UserSetNameRequest', () => {
  it('accepts snake_case chat_id', () => {
    expect(UserSetNameRequest.safeParse({ chat_id: 'abc', name: 'Alice' }).success).toBe(true)
  })
  it('rejects camelCase chatId', () => {
    expect(UserSetNameRequest.safeParse({ chatId: 'abc', name: 'Alice' }).success).toBe(false)
  })
})

// ... add the simple valid/invalid tests for ProjectsSwitchResponse,
// ProjectsRemoveRequest, ProjectsRemoveResponse, UserSetNameResponse
// following the same pattern.
```

- [ ] **Step 3: Run tests, expect failure**

- [ ] **Step 4: Implement the schemas**

Append to `schema.ts`:

```ts
// GET /v1/projects/list  (legacy: returns the array directly, NOT wrapped)
const ProjectListItem = z.object({
  alias: z.string(),
  path: z.string(),
  // Add any additional fields that deps.projects.list() returns; check
  // src/daemon/wechat-tool-deps.ts for the WechatProjectsDep interface.
})
export const ProjectsListResponse = z.array(ProjectListItem)

// POST /v1/projects/switch
export const ProjectsSwitchRequest = z.object({
  alias: z.string(),
})
// Response is whatever deps.projects.switchTo returns — pin a structural
// shape based on what the dep returns. If it's e.g. { ok, alias, path }
// match that. If it varies, use z.unknown() and tighten in a follow-up.
export const ProjectsSwitchResponse = z.unknown()  // refine after reading WechatProjectsDep

// POST /v1/projects/add
export const ProjectsAddRequest = z.object({
  alias: z.string(),
  path: z.string(),
})
export const ProjectsAddResponse = z.union([
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), error: z.string() }),
])

// POST /v1/projects/remove
export const ProjectsRemoveRequest = z.object({
  alias: z.string(),
})
export const ProjectsRemoveResponse = z.union([
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), error: z.string() }),
])

// POST /v1/user/set_name  (snake_case chat_id is intentional)
export const UserSetNameRequest = z.object({
  chat_id: z.string(),
  name: z.string(),
})
export const UserSetNameResponse = z.union([
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), error: z.string() }),
])
```

- [ ] **Step 5: Run tests, expect pass**

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(internal-api): projects + user route schemas"
```

---

### Task 3: Schema batch — share + voice (4 routes)

**Files:**
- Modify: `src/daemon/internal-api/schema.ts`
- Modify: `src/daemon/internal-api/schema.test.ts`

- [ ] **Step 1: Read the routes**

```bash
sed -n '115,165p' src/daemon/internal-api/routes.ts
sed -n '396,425p' src/daemon/internal-api/routes.ts
```

Routes:
- `POST /v1/share/page` — body `{ title, content, needs_approval?, chat_id?, account_id? }`; response `{ url, slug } | { ok: false, error }`.
- `POST /v1/share/resurface` — body `{ slug?, title_fragment? }`; response `{ url, slug } | { ok: false, reason: 'not found' } | { ok: false, error }`.
- `GET /v1/voice/status` — no body; response is whatever `deps.voice.configStatus()` returns. Check `WechatVoiceDep` in `src/daemon/wechat-tool-deps.ts`.
- `POST /v1/voice/save_config` — body `{ provider: 'http_tts'|'qwen', base_url?, model?, api_key?, default_voice? }`; response is whatever `deps.voice.saveConfig` returns (typically `{ ok: true } | { ok: false, reason, ... }`).

- [ ] **Step 2: Write failing tests**

```ts
import {
  SharePageRequest, SharePageResponse,
  ShareResurfaceRequest, ShareResurfaceResponse,
  VoiceStatusResponse,
  VoiceSaveConfigRequest, VoiceSaveConfigResponse,
} from './schema'

describe('SharePageRequest', () => {
  it('accepts title + content only', () => {
    expect(SharePageRequest.safeParse({ title: 'T', content: 'C' }).success).toBe(true)
  })
  it('accepts all optional fields', () => {
    expect(SharePageRequest.safeParse({
      title: 'T', content: 'C',
      needs_approval: true, chat_id: 'abc', account_id: 'acct',
    }).success).toBe(true)
  })
  it('rejects missing title', () => {
    expect(SharePageRequest.safeParse({ content: 'C' }).success).toBe(false)
  })
})

describe('ShareResurfaceRequest', () => {
  it('accepts slug', () => {
    expect(ShareResurfaceRequest.safeParse({ slug: 'foo' }).success).toBe(true)
  })
  it('accepts title_fragment', () => {
    expect(ShareResurfaceRequest.safeParse({ title_fragment: 'foo' }).success).toBe(true)
  })
  it('accepts empty (server returns not-found)', () => {
    expect(ShareResurfaceRequest.safeParse({}).success).toBe(true)
  })
})

describe('VoiceSaveConfigRequest', () => {
  it('accepts http_tts provider', () => {
    expect(VoiceSaveConfigRequest.safeParse({ provider: 'http_tts' }).success).toBe(true)
  })
  it('accepts qwen provider', () => {
    expect(VoiceSaveConfigRequest.safeParse({ provider: 'qwen', api_key: 'sk-x' }).success).toBe(true)
  })
  it('rejects unknown provider', () => {
    expect(VoiceSaveConfigRequest.safeParse({ provider: 'foo' }).success).toBe(false)
  })
})

// ... add similar tests for SharePageResponse, ShareResurfaceResponse,
// VoiceStatusResponse, VoiceSaveConfigResponse based on the actual handler
// return shapes (read the WechatVoiceDep interface for the exact shape).
```

- [ ] **Step 3: Run tests, expect failure**

- [ ] **Step 4: Implement the schemas**

```ts
// POST /v1/share/page
export const SharePageRequest = z.object({
  title: z.string(),
  content: z.string(),
  needs_approval: z.boolean().optional(),
  chat_id: z.string().optional(),
  account_id: z.string().optional(),
})
export const SharePageResponse = z.union([
  z.object({ url: z.string(), slug: z.string() }),
  z.object({ ok: z.literal(false), error: z.string() }),
])

// POST /v1/share/resurface
export const ShareResurfaceRequest = z.object({
  slug: z.string().optional(),
  title_fragment: z.string().optional(),
})
export const ShareResurfaceResponse = z.union([
  z.object({ url: z.string(), slug: z.string() }),
  z.object({ ok: z.literal(false), reason: z.literal('not found') }),
  z.object({ ok: z.literal(false), error: z.string() }),
])

// GET /v1/voice/status
// Pin to whatever WechatVoiceDep.configStatus returns. Read it from
// src/daemon/wechat-tool-deps.ts and match its shape. If it's a complex
// object, write a literal z.object({...}) here.
export const VoiceStatusResponse = z.object({
  // ... fields the configStatus interface declares
})

// POST /v1/voice/save_config
export const VoiceSaveConfigRequest = z.object({
  provider: z.enum(['http_tts', 'qwen']),
  base_url: z.string().optional(),
  model: z.string().optional(),
  api_key: z.string().optional(),
  default_voice: z.string().optional(),
})
export const VoiceSaveConfigResponse = z.union([
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), reason: z.string() }),
  // The handler's catch path returns { ok: false, reason: 'unexpected_error', detail }
  z.object({ ok: z.literal(false), reason: z.string(), detail: z.string() }),
])
```

- [ ] **Step 5: Run tests, expect pass**

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(internal-api): share + voice route schemas"
```

---

### Task 4: Schema batch — companion (4 routes)

**Files:**
- Modify: `src/daemon/internal-api/schema.ts`
- Modify: `src/daemon/internal-api/schema.test.ts`

- [ ] **Step 1: Read the routes**

```bash
sed -n '166,200p' src/daemon/internal-api/routes.ts
```

Routes:
- `GET /v1/companion/status` — no body; response is `deps.companion.status()` shape (read `WechatCompanionDep`).
- `POST /v1/companion/enable` — no body; response is `deps.companion.enable()` return.
- `POST /v1/companion/disable` — no body; response is `deps.companion.disable()` return.
- `POST /v1/companion/snooze` — body `{ minutes: int 1-1440 }`; response is `deps.companion.snooze(minutes)` return.

- [ ] **Step 2: Write failing tests**

```ts
import {
  CompanionStatusResponse,
  CompanionEnableResponse,
  CompanionDisableResponse,
  CompanionSnoozeRequest,
  CompanionSnoozeResponse,
} from './schema'

describe('CompanionSnoozeRequest', () => {
  it('accepts 1 minute', () => {
    expect(CompanionSnoozeRequest.safeParse({ minutes: 1 }).success).toBe(true)
  })
  it('accepts 1440 minutes (24h)', () => {
    expect(CompanionSnoozeRequest.safeParse({ minutes: 1440 }).success).toBe(true)
  })
  it('rejects 0 minutes', () => {
    expect(CompanionSnoozeRequest.safeParse({ minutes: 0 }).success).toBe(false)
  })
  it('rejects > 1440 minutes', () => {
    expect(CompanionSnoozeRequest.safeParse({ minutes: 1441 }).success).toBe(false)
  })
  it('rejects non-integer', () => {
    expect(CompanionSnoozeRequest.safeParse({ minutes: 1.5 }).success).toBe(false)
  })
})

// ... tests for CompanionStatusResponse, CompanionEnable/Disable/Snooze
// Response shapes; refer to WechatCompanionDep for the exact return types.
```

- [ ] **Step 3: Run tests, expect failure**

- [ ] **Step 4: Implement the schemas**

```ts
// GET /v1/companion/status
// Pin to deps.companion.status() return shape — read WechatCompanionDep.
export const CompanionStatusResponse = z.object({
  // ... status fields
})

// POST /v1/companion/enable
export const CompanionEnableResponse = z.union([
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), error: z.string() }),
])

// POST /v1/companion/disable
export const CompanionDisableResponse = z.union([
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), error: z.string() }),
])

// POST /v1/companion/snooze
export const CompanionSnoozeRequest = z.object({
  minutes: z.number().int().min(1).max(1440),
})
export const CompanionSnoozeResponse = z.union([
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), error: z.string() }),
])
```

- [ ] **Step 5: Run tests, expect pass**

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(internal-api): companion route schemas"
```

---

### Task 5: Schema batch — wechat reply family + delegate + conversation set-mode (8 routes)

**Files:**
- Modify: `src/daemon/internal-api/schema.ts`
- Modify: `src/daemon/internal-api/schema.test.ts`

- [ ] **Step 1: Read the routes**

```bash
sed -n '202,395p' src/daemon/internal-api/routes.ts
```

Routes:
- `POST /v1/wechat/reply` — body `{ chat_id, text, participant_tag? }`; response `{ ok: true, msg_id } | { ok: false, error }`.
- `POST /v1/wechat/reply_voice` — body `{ chat_id, text }` (text ≤ 500); response `{ ok: ..., reason?: 'too_long' | 'unexpected_error', limit?, detail? }`.
- `POST /v1/wechat/send_file` — body `{ chat_id, path }`; response `{ ok } | { ok: false, error }`.
- `POST /v1/wechat/edit_message` — body `{ chat_id, msg_id, text }`; response `{ ok } | { ok: false, error }`.
- `POST /v1/wechat/broadcast` — body `{ text, account_id? }`; response is `deps.ilink.broadcast()` return ({ ok, failed counts }) or `{ ok: false, error }`.
- `POST /v1/delegate` — body `{ peer, prompt, context_summary?, cwd?, depth? }`; response union with success / various 400 / nested-rejected / dispatch-failure shapes.
- `POST /v1/conversation/set-mode` — body `{ chatId (camelCase!), mode: { kind: 'solo'|'parallel'|'primary_tool'|'chatroom', ... } }`; response `{ ok: true } | { error }` (400 on invalid).

- [ ] **Step 2: Write failing tests**

```ts
import {
  WechatReplyRequest, WechatReplyResponse,
  WechatReplyVoiceRequest, WechatReplyVoiceResponse,
  WechatSendFileRequest, WechatSendFileResponse,
  WechatEditMessageRequest, WechatEditMessageResponse,
  WechatBroadcastRequest, WechatBroadcastResponse,
  DelegateRequest, DelegateResponse,
  ConversationSetModeRequest, ConversationSetModeResponse,
} from './schema'

describe('WechatReplyRequest', () => {
  it('accepts chat_id + text', () => {
    expect(WechatReplyRequest.safeParse({ chat_id: 'abc', text: 'hi' }).success).toBe(true)
  })
  it('accepts participant_tag', () => {
    expect(WechatReplyRequest.safeParse({ chat_id: 'abc', text: 'hi', participant_tag: 'claude' }).success).toBe(true)
  })
  it('rejects missing chat_id', () => {
    expect(WechatReplyRequest.safeParse({ text: 'hi' }).success).toBe(false)
  })
})

describe('WechatReplyVoiceRequest', () => {
  it('accepts text up to 500 chars', () => {
    expect(WechatReplyVoiceRequest.safeParse({ chat_id: 'abc', text: 'a'.repeat(500) }).success).toBe(true)
  })
  it('rejects text over 500 chars', () => {
    expect(WechatReplyVoiceRequest.safeParse({ chat_id: 'abc', text: 'a'.repeat(501) }).success).toBe(false)
  })
})

describe('DelegateRequest', () => {
  it('accepts minimal peer + prompt', () => {
    expect(DelegateRequest.safeParse({ peer: 'codex', prompt: 'hi' }).success).toBe(true)
  })
  it('rejects missing peer', () => {
    expect(DelegateRequest.safeParse({ prompt: 'hi' }).success).toBe(false)
  })
  it('accepts cwd absolute path', () => {
    expect(DelegateRequest.safeParse({ peer: 'codex', prompt: 'hi', cwd: '/tmp' }).success).toBe(true)
  })
})

describe('ConversationSetModeRequest', () => {
  it('accepts solo mode', () => {
    expect(ConversationSetModeRequest.safeParse({
      chatId: 'abc',  // camelCase per the route
      mode: { kind: 'solo', provider: 'claude' },
    }).success).toBe(true)
  })
  it('accepts parallel mode', () => {
    expect(ConversationSetModeRequest.safeParse({
      chatId: 'abc',
      mode: { kind: 'parallel' },
    }).success).toBe(true)
  })
  it('rejects unknown mode kind', () => {
    expect(ConversationSetModeRequest.safeParse({
      chatId: 'abc',
      mode: { kind: 'bogus' },
    }).success).toBe(false)
  })
})

// ... add similar tests for WechatSendFile, WechatEditMessage,
// WechatBroadcast, all the corresponding responses. Each test group has
// at least one valid + one invalid case.
```

- [ ] **Step 3: Run tests, expect failure**

- [ ] **Step 4: Implement the schemas**

```ts
// POST /v1/wechat/reply
export const WechatReplyRequest = z.object({
  chat_id: z.string(),
  text: z.string(),
  participant_tag: z.string().optional(),
})
export const WechatReplyResponse = z.union([
  z.object({ ok: z.literal(true), msg_id: z.string() }),
  z.object({ ok: z.literal(false), error: z.string() }),
])

// POST /v1/wechat/reply_voice  (text capped at 500 chars)
export const WechatReplyVoiceRequest = z.object({
  chat_id: z.string(),
  text: z.string().max(500),
})
export const WechatReplyVoiceResponse = z.union([
  z.object({ ok: z.literal(true) }),  // or whatever deps.voice.replyVoice returns on success
  z.object({ ok: z.literal(false), reason: z.literal('too_long'), limit: z.literal(500) }),
  z.object({ ok: z.literal(false), reason: z.literal('unexpected_error'), detail: z.string() }),
])

// POST /v1/wechat/send_file
export const WechatSendFileRequest = z.object({
  chat_id: z.string(),
  path: z.string(),
})
export const WechatSendFileResponse = z.union([
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), error: z.string() }),
])

// POST /v1/wechat/edit_message
export const WechatEditMessageRequest = z.object({
  chat_id: z.string(),
  msg_id: z.string(),
  text: z.string(),
})
export const WechatEditMessageResponse = z.union([
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), error: z.string() }),
])

// POST /v1/wechat/broadcast
export const WechatBroadcastRequest = z.object({
  text: z.string(),
  account_id: z.string().optional(),
})
export const WechatBroadcastResponse = z.union([
  z.object({ ok: z.number(), failed: z.number() }),  // deps.ilink.broadcast return
  z.object({ ok: z.literal(false), error: z.string() }),
])

// POST /v1/delegate
const KnownPeer = z.string()  // refined per d.knownPeers() result
export const DelegateRequest = z.object({
  peer: KnownPeer,
  prompt: z.string(),
  context_summary: z.string().optional(),
  cwd: z.string().refine(s => s === undefined || s.startsWith('/'), 'cwd_must_be_absolute').optional(),
  depth: z.number().optional(),
})
export const DelegateResponse = z.union([
  z.object({ ok: z.literal(true), response: z.string(), num_turns: z.number().optional(), duration_ms: z.number().optional() }),
  z.object({ ok: z.literal(false), reason: z.string() }),
])

// POST /v1/conversation/set-mode  (chatId is camelCase, intentional)
const Mode = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('solo'), provider: z.string() }),
  z.object({ kind: z.literal('parallel') }),
  z.object({ kind: z.literal('primary_tool'), primary: z.string() }),
  z.object({ kind: z.literal('chatroom') }),
])
export const ConversationSetModeRequest = z.object({
  chatId: z.string(),
  mode: Mode,
})
export const ConversationSetModeResponse = z.union([
  z.object({ ok: z.literal(true) }),
  z.object({ error: z.string() }),
])
```

- [ ] **Step 5: Run tests, expect pass**

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(internal-api): wechat + delegate + conversation route schemas"
```

---

### Task 6: Add lookup tables + inferred type aliases

**Files:**
- Modify: `src/daemon/internal-api/schema.ts`
- Modify: `src/daemon/internal-api/schema.test.ts`

- [ ] **Step 1: Append type aliases for every schema (24 routes' worth)**

At the bottom of `schema.ts` (after all the schema declarations from Tasks 1-5):

```ts
// ── Inferred TS type aliases ────────────────────────────────────────────
// Convention: <Schema>T is z.infer<typeof <Schema>>. JSDoc consumers and
// handler signatures import these aliases.

export type HealthResponseT = z.infer<typeof HealthResponse>

export type MemoryReadRequestT = z.infer<typeof MemoryReadRequest>
export type MemoryReadResponseT = z.infer<typeof MemoryReadResponse>
export type MemoryWriteRequestT = z.infer<typeof MemoryWriteRequest>
export type MemoryWriteResponseT = z.infer<typeof MemoryWriteResponse>
export type MemoryListQueryT = z.infer<typeof MemoryListQuery>
export type MemoryListResponseT = z.infer<typeof MemoryListResponse>

export type ProjectsListResponseT = z.infer<typeof ProjectsListResponse>
export type ProjectsSwitchRequestT = z.infer<typeof ProjectsSwitchRequest>
export type ProjectsSwitchResponseT = z.infer<typeof ProjectsSwitchResponse>
export type ProjectsAddRequestT = z.infer<typeof ProjectsAddRequest>
export type ProjectsAddResponseT = z.infer<typeof ProjectsAddResponse>
export type ProjectsRemoveRequestT = z.infer<typeof ProjectsRemoveRequest>
export type ProjectsRemoveResponseT = z.infer<typeof ProjectsRemoveResponse>

export type UserSetNameRequestT = z.infer<typeof UserSetNameRequest>
export type UserSetNameResponseT = z.infer<typeof UserSetNameResponse>

export type SharePageRequestT = z.infer<typeof SharePageRequest>
export type SharePageResponseT = z.infer<typeof SharePageResponse>
export type ShareResurfaceRequestT = z.infer<typeof ShareResurfaceRequest>
export type ShareResurfaceResponseT = z.infer<typeof ShareResurfaceResponse>

export type VoiceStatusResponseT = z.infer<typeof VoiceStatusResponse>
export type VoiceSaveConfigRequestT = z.infer<typeof VoiceSaveConfigRequest>
export type VoiceSaveConfigResponseT = z.infer<typeof VoiceSaveConfigResponse>

export type CompanionStatusResponseT = z.infer<typeof CompanionStatusResponse>
export type CompanionEnableResponseT = z.infer<typeof CompanionEnableResponse>
export type CompanionDisableResponseT = z.infer<typeof CompanionDisableResponse>
export type CompanionSnoozeRequestT = z.infer<typeof CompanionSnoozeRequest>
export type CompanionSnoozeResponseT = z.infer<typeof CompanionSnoozeResponse>

export type WechatReplyRequestT = z.infer<typeof WechatReplyRequest>
export type WechatReplyResponseT = z.infer<typeof WechatReplyResponse>
export type WechatReplyVoiceRequestT = z.infer<typeof WechatReplyVoiceRequest>
export type WechatReplyVoiceResponseT = z.infer<typeof WechatReplyVoiceResponse>
export type WechatSendFileRequestT = z.infer<typeof WechatSendFileRequest>
export type WechatSendFileResponseT = z.infer<typeof WechatSendFileResponse>
export type WechatEditMessageRequestT = z.infer<typeof WechatEditMessageRequest>
export type WechatEditMessageResponseT = z.infer<typeof WechatEditMessageResponse>
export type WechatBroadcastRequestT = z.infer<typeof WechatBroadcastRequest>
export type WechatBroadcastResponseT = z.infer<typeof WechatBroadcastResponse>

export type DelegateRequestT = z.infer<typeof DelegateRequest>
export type DelegateResponseT = z.infer<typeof DelegateResponse>

export type ConversationSetModeRequestT = z.infer<typeof ConversationSetModeRequest>
export type ConversationSetModeResponseT = z.infer<typeof ConversationSetModeResponse>
```

- [ ] **Step 2: Add the lookup tables**

Append to `schema.ts`:

```ts
// ── Lookup tables ───────────────────────────────────────────────────────
// REQUEST_SCHEMAS includes both POST body schemas (most routes) and GET
// query schemas (e.g. /v1/memory/list?dir=...). The validation step in
// index.ts uses these to parse the appropriate input before dispatch.
//
// RESPONSE_SCHEMAS is type-only documentation — runtime validation of
// handler return values is intentionally NOT performed. Future dev-mode
// assertion is a possible follow-up.

export const REQUEST_SCHEMAS: Record<string, z.ZodTypeAny | undefined> = {
  // memory
  'POST /v1/memory/read': MemoryReadRequest,
  'POST /v1/memory/write': MemoryWriteRequest,
  'GET /v1/memory/list': MemoryListQuery,

  // projects
  'POST /v1/projects/switch': ProjectsSwitchRequest,
  'POST /v1/projects/add': ProjectsAddRequest,
  'POST /v1/projects/remove': ProjectsRemoveRequest,

  // user
  'POST /v1/user/set_name': UserSetNameRequest,

  // share
  'POST /v1/share/page': SharePageRequest,
  'POST /v1/share/resurface': ShareResurfaceRequest,

  // voice
  'POST /v1/voice/save_config': VoiceSaveConfigRequest,

  // companion
  'POST /v1/companion/snooze': CompanionSnoozeRequest,

  // wechat
  'POST /v1/wechat/reply': WechatReplyRequest,
  'POST /v1/wechat/reply_voice': WechatReplyVoiceRequest,
  'POST /v1/wechat/send_file': WechatSendFileRequest,
  'POST /v1/wechat/edit_message': WechatEditMessageRequest,
  'POST /v1/wechat/broadcast': WechatBroadcastRequest,

  // delegate
  'POST /v1/delegate': DelegateRequest,

  // conversation
  'POST /v1/conversation/set-mode': ConversationSetModeRequest,
}

export const RESPONSE_SCHEMAS: Record<string, z.ZodTypeAny | undefined> = {
  'GET /v1/health': HealthResponse,
  'POST /v1/memory/read': MemoryReadResponse,
  'POST /v1/memory/write': MemoryWriteResponse,
  'GET /v1/memory/list': MemoryListResponse,
  'GET /v1/projects/list': ProjectsListResponse,
  'POST /v1/projects/switch': ProjectsSwitchResponse,
  'POST /v1/projects/add': ProjectsAddResponse,
  'POST /v1/projects/remove': ProjectsRemoveResponse,
  'POST /v1/user/set_name': UserSetNameResponse,
  'POST /v1/share/page': SharePageResponse,
  'POST /v1/share/resurface': ShareResurfaceResponse,
  'GET /v1/voice/status': VoiceStatusResponse,
  'POST /v1/voice/save_config': VoiceSaveConfigResponse,
  'GET /v1/companion/status': CompanionStatusResponse,
  'POST /v1/companion/enable': CompanionEnableResponse,
  'POST /v1/companion/disable': CompanionDisableResponse,
  'POST /v1/companion/snooze': CompanionSnoozeResponse,
  'POST /v1/wechat/reply': WechatReplyResponse,
  'POST /v1/wechat/reply_voice': WechatReplyVoiceResponse,
  'POST /v1/wechat/send_file': WechatSendFileResponse,
  'POST /v1/wechat/edit_message': WechatEditMessageResponse,
  'POST /v1/wechat/broadcast': WechatBroadcastResponse,
  'POST /v1/delegate': DelegateResponse,
  'POST /v1/conversation/set-mode': ConversationSetModeResponse,
}
```

- [ ] **Step 3: Add a coverage test**

Append to `schema.test.ts`:

```ts
import { REQUEST_SCHEMAS, RESPONSE_SCHEMAS } from './schema'

describe('schema lookup tables', () => {
  it('REQUEST_SCHEMAS has 18 entries (POST body + 1 GET query)', () => {
    expect(Object.keys(REQUEST_SCHEMAS).length).toBe(18)
  })
  it('RESPONSE_SCHEMAS has 24 entries (one per route)', () => {
    expect(Object.keys(RESPONSE_SCHEMAS).length).toBe(24)
  })
})
```

- [ ] **Step 4: Run tests, expect pass**

```bash
bun --bun vitest run src/daemon/internal-api/schema.test.ts
bun run typecheck
```

Both should pass.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(internal-api): inferred type aliases + REQUEST/RESPONSE lookup tables"
```

---

### Task 7: Inject validation into `index.ts` (with tests)

**Files:**
- Modify: `src/daemon/internal-api/index.ts`
- Modify (or create): `src/daemon/internal-api/index.test.ts` (or whatever the existing test file is — check)

- [ ] **Step 1: Locate the existing test file**

```bash
ls src/daemon/internal-api/*.test.ts
```

If there's no existing `index.test.ts`, you'll create one. Otherwise extend whatever is there (`internal-api.test.ts` or similar).

- [ ] **Step 2: Write failing tests for the new validation behavior**

```ts
// New tests in the existing internal-api test file (or new index.test.ts)
import { describe, it, expect } from 'vitest'
import { createInternalApi } from './index'
// ... import or rebuild the deps stub the existing tests use

describe('internal-api request validation', () => {
  it('returns 400 on POST with malformed body', async () => {
    const api = createInternalApi(/* deps */)
    await api.start()
    try {
      const tokenHex = readToken(api.tokenFilePath())
      const res = await fetch(`http://127.0.0.1:${api.port()}/v1/memory/read`, {
        method: 'POST',
        headers: { authorization: `Bearer ${tokenHex}`, 'content-type': 'application/json' },
        body: JSON.stringify({}),  // missing required `path`
      })
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toBe('invalid_request')
      expect(body.detail).toBeDefined()
    } finally {
      await api.stop({ unlinkToken: true })
    }
  })

  it('forwards parsed data to handler on valid body', async () => {
    let received: unknown = null
    const api = createInternalApi({
      // ... deps with a memory stub that captures the path arg
      memory: {
        read: (p) => { received = p; return null },
        // ... other MemoryFS members
      } as any,
      // ... other required deps
    })
    await api.start()
    try {
      const tokenHex = readToken(api.tokenFilePath())
      const res = await fetch(`http://127.0.0.1:${api.port()}/v1/memory/read`, {
        method: 'POST',
        headers: { authorization: `Bearer ${tokenHex}`, 'content-type': 'application/json' },
        body: JSON.stringify({ path: 'foo.md' }),
      })
      expect(res.status).toBe(200)
      expect(received).toBe('foo.md')
    } finally {
      await api.stop({ unlinkToken: true })
    }
  })

  it('returns 400 on GET with malformed query', async () => {
    const api = createInternalApi(/* deps */)
    await api.start()
    try {
      const tokenHex = readToken(api.tokenFilePath())
      // /v1/memory/list expects { dir?: string } — we'll send a numeric dir
      // by exploiting URLSearchParams (everything is string anyway, so this
      // particular schema can't actually be malformed via query). Skip this
      // case if the schema accepts everything; otherwise assert 400.
      const res = await fetch(`http://127.0.0.1:${api.port()}/v1/memory/list?dir=ok`, {
        method: 'GET',
        headers: { authorization: `Bearer ${tokenHex}` },
      })
      expect(res.status).toBe(200)
    } finally {
      await api.stop({ unlinkToken: true })
    }
  })
})
```

(`readToken` is a helper that reads the token file and returns the hex string. The existing test file likely already has a similar helper — reuse it.)

- [ ] **Step 3: Run tests, expect failure**

```bash
bun --bun vitest run src/daemon/internal-api/
```

Expected: the new tests fail because validation isn't wired yet.

- [ ] **Step 4: Modify `index.ts` to inject validation**

In `handleRequest`, after the body is parsed (line ~123 in current code) and before `route()` is called:

```diff
+import { REQUEST_SCHEMAS } from './schema'
 
 // ... existing imports
 
 async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
   if (!authOk(req)) { /* ... */ }
 
   const method = req.method ?? 'GET'
   const rawUrl = req.url ?? '/'
   const url = new URL(rawUrl, 'http://internal')
   const route = ROUTES[`${method} ${url.pathname}`]
 
   if (!route) {
     return send(res, 404, { error: 'not_found', method, url: rawUrl })
   }
 
   let body: unknown = null
   if (method === 'POST') {
     try {
       body = await readJsonBody(req)
     } catch (err) {
       return send(res, 400, { error: 'malformed_json', detail: errMsg(err) })
     }
   }
 
+  const key = `${method} ${url.pathname}`
+  const reqSchema = REQUEST_SCHEMAS[key]
+  if (reqSchema) {
+    const input = method === 'POST'
+      ? body
+      : Object.fromEntries(url.searchParams.entries())
+    const parsed = reqSchema.safeParse(input)
+    if (!parsed.success) {
+      deps.log?.('INTERNAL_API', `400 ${key} schema mismatch`, {
+        path: key,
+        issues: parsed.error.issues,
+      })
+      return send(res, 400, { error: 'invalid_request', detail: parsed.error.flatten() })
+    }
+    if (method === 'POST') body = parsed.data
+    // GET: handler still reads from url.searchParams (legacy contract);
+    // schema validation just gatekeeps. If you'd rather pass `parsed.data`
+    // to the handler, that's a follow-up handler-signature refactor.
+  }
+
   try {
     const out = await route(url.searchParams, body)
     send(res, out.status, out.body)
   } catch (err) { /* ... */ }
 }
```

- [ ] **Step 5: Run tests, expect pass**

```bash
bun --bun vitest run src/daemon/internal-api/
```

- [ ] **Step 6: Commit**

```bash
git add src/daemon/internal-api/index.ts src/daemon/internal-api/*.test.ts
git commit -m "feat(internal-api): inject zod validation before route dispatch"
```

---

### Task 8: Tighten handler signatures in `routes.ts`

**Files:**
- Modify: `src/daemon/internal-api/routes.ts`

This is mechanical: every POST handler currently does `(_q, body) => { const b = body as { ... } | null; ... }`. After P1.B's index-side parse, `body` is already typed. Update each handler signature to take the typed body directly, and delete the `as` cast / null check.

- [ ] **Step 1: Read the current routes.ts handler signatures**

```bash
sed -n '21,30p' src/daemon/internal-api/routes.ts
```

The current `RouteHandler` type (in `types.ts`) is:

```ts
export type RouteHandler = (
  query: URLSearchParams,
  body: unknown,
) => Promise<{ status: number; body: unknown }> | { status: number; body: unknown }
```

Body is `unknown`. We're going to keep that signature in the type but specify the actual body shape inline at each handler.

- [ ] **Step 2: Update each POST handler**

For every `POST` route in `routes.ts`, change the handler to use `z.infer`:

```diff
-    'POST /v1/memory/read': (_q, body) => {
-      if (!deps.memory) return { status: 503, body: { error: 'memory_fs_not_wired' } }
-      const path = (body as { path?: unknown } | null)?.path
-      if (typeof path !== 'string') return { status: 400, body: { error: 'path_required' } }
-      try {
-        const content = deps.memory.read(path)
-        return { status: 200, body: content === null ? { exists: false } : { exists: true, content } }
-      } catch (err) {
-        return { status: 200, body: { error: errMsg(err) } }
-      }
-    },
+    'POST /v1/memory/read': (_q, body) => {
+      if (!deps.memory) return { status: 503, body: { error: 'memory_fs_not_wired' } }
+      // Body is pre-validated by index.ts via MemoryReadRequest schema.
+      const { path } = body as MemoryReadRequestT
+      try {
+        const content = deps.memory.read(path)
+        return { status: 200, body: content === null ? { exists: false } : { exists: true, content } }
+      } catch (err) {
+        return { status: 200, body: { error: errMsg(err) } }
+      }
+    },
```

Add the schema import at the top of `routes.ts`:

```ts
import type {
  MemoryReadRequestT, MemoryWriteRequestT,
  ProjectsSwitchRequestT, ProjectsAddRequestT, ProjectsRemoveRequestT,
  UserSetNameRequestT,
  SharePageRequestT, ShareResurfaceRequestT,
  VoiceSaveConfigRequestT,
  CompanionSnoozeRequestT,
  WechatReplyRequestT, WechatReplyVoiceRequestT, WechatSendFileRequestT,
  WechatEditMessageRequestT, WechatBroadcastRequestT,
  DelegateRequestT,
  ConversationSetModeRequestT,
} from './schema'
```

Apply the same `body as <Schema>T` pattern to every POST handler. The cast is safe because index.ts has already done `safeParse + assign parsed.data`.

You can also delete the now-redundant runtime checks (the `if (typeof b?.field !== 'string') return 400`) — they're handled by the schema validation upstream.

- [ ] **Step 3: Update GET handlers reading from query**

For `GET /v1/memory/list`, the handler reads `q.get('dir')`. Schema validation ran on `Object.fromEntries(url.searchParams)` upstream. If you want the handler to use the parsed data instead, you'd need a slight signature refactor — for now, keep `q.get('dir')` as-is.

- [ ] **Step 4: Run tests**

```bash
bun --bun vitest run src/daemon/internal-api/
bun run typecheck
```

Expected: PASS. Removing the runtime field-type checks shouldn't break anything because the schema rejects them upstream.

If a test fails because it sent malformed data and expected 400 from the handler, the new validation step now returns the 400 from `index.ts` instead — adjust the test's error path expectation.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/internal-api/routes.ts
git commit -m "feat(internal-api): tighten handler body types via z.infer"
```

---

### Task 9: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Run `bun run typecheck`**

```bash
bun run typecheck
```

Expected: PASS.

- [ ] **Step 2: Run the full test suite**

```bash
bun --bun vitest run
```

Expected: PASS. Test count baseline + ~70 new tests (24 schema test groups × ~3 tests each + ~3 index-validation tests).

- [ ] **Step 3: Run e2e**

```bash
bun --bun vitest run -c vitest.e2e.config.ts
```

Expected: PASS — the wechat-mcp child + delegate-mcp paths exercise the validated routes end-to-end.

- [ ] **Step 4: Verify dependency-cruiser still passes**

```bash
bun run depcheck
```

Expected: PASS. `schema.ts` is in `src/daemon/internal-api/` — same layer as the rest of the dir, no boundary violations.

- [ ] **Step 5: No commit needed.**

If you reached this step with all green, the P1.B PR is ready. Push and open `feat(p1b): zod schemas for internal-api routes`.

---

## Final notes for the implementer

- **Schema reflects reality, not aspiration**: if a route's existing test passes a body that the new schema rejects, the schema is wrong. Find the union case the schema missed and add it.
- **`safeParse` not `parse`**: index.ts uses `safeParse` so a 400 response is returned cleanly. Compare to P1.A which uses `parse` — that's because the CLI is producing the JSON, so a mismatch is a daemon bug worth crashing over.
- **GET routes with no query params**: `/v1/health`, `/v1/projects/list`, `/v1/voice/status`, `/v1/companion/status`, `/v1/companion/enable`, `/v1/companion/disable` — these have no entry in `REQUEST_SCHEMAS`. The validation step skips them automatically because the lookup returns `undefined`.
- **No desktop work in this PR**: desktop calls the CLI, not internal-api. Anything desktop-related goes in P1.A's plan.
- **Frequent commits**: every task above ends with a commit. Don't batch.
