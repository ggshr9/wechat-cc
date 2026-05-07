/**
 * Zod schemas for every internal-api route. Single source of truth for
 * the HTTP contract between the daemon and its clients (wechat-mcp stdio
 * child + delegate-mcp dispatch).
 *
 * Convention: <SchemaName> is the zod value; <SchemaName>T is the
 * inferred TS type alias.
 *
 * Validation runs in index.ts before route handler dispatch.
 */
// zod v4: `import { z } from 'zod'` resolves to undefined under vitest's
// bundler; use the default export instead (both forms are equivalent at
// runtime — this is a build-tool interop quirk, not a zod API difference).
import z from 'zod'

// ── GET /v1/health ───────────────────────────────────────────────────────────

export const HealthResponse = z.object({
  ok: z.boolean(),
  daemon_pid: z.number(),
})

// ── POST /v1/memory/read ─────────────────────────────────────────────────────

export const MemoryReadRequest = z.object({
  path: z.string(),
})
export const MemoryReadResponse = z.union([
  z.object({ exists: z.literal(false) }),
  z.object({ exists: z.literal(true), content: z.string() }),
  z.object({ error: z.string() }),
])

// ── POST /v1/memory/write ────────────────────────────────────────────────────

export const MemoryWriteRequest = z.object({
  path: z.string(),
  content: z.string(),
})
export const MemoryWriteResponse = z.union([
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), error: z.string() }),
])

// ── GET /v1/memory/list ──────────────────────────────────────────────────────

export const MemoryListQuery = z.object({
  dir: z.string().optional(),
})
export const MemoryListResponse = z.union([
  z.object({ files: z.array(z.string()) }),
  z.object({ error: z.string() }),
])

// ── GET /v1/projects/list ────────────────────────────────────────────────────
// Legacy wire shape: array returned directly (not wrapped).
// Element shape from WechatProjectsDep.list() in wechat-tool-deps.ts.

const ProjectListItem = z.object({
  alias: z.string(),
  path: z.string(),
  current: z.boolean(),
})
export const ProjectsListResponse = z.array(ProjectListItem)

// ── POST /v1/projects/switch ─────────────────────────────────────────────────

export const ProjectsSwitchRequest = z.object({
  alias: z.string(),
})
// Shape from WechatProjectsDep.switchTo: {ok:true,path} | {ok:false,reason}
export const ProjectsSwitchResponse = z.union([
  z.object({ ok: z.literal(true), path: z.string() }),
  z.object({ ok: z.literal(false), reason: z.string() }),
])

// ── POST /v1/projects/add ────────────────────────────────────────────────────

export const ProjectsAddRequest = z.object({
  alias: z.string(),
  path: z.string(),
})
export const ProjectsAddResponse = z.union([
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), error: z.string() }),
])

// ── POST /v1/projects/remove ─────────────────────────────────────────────────

export const ProjectsRemoveRequest = z.object({
  alias: z.string(),
})
export const ProjectsRemoveResponse = z.union([
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), error: z.string() }),
])

// ── POST /v1/user/set_name ───────────────────────────────────────────────────
// chat_id is snake_case — intentional; preserved from legacy wire shape.

export const UserSetNameRequest = z.object({
  chat_id: z.string(),
  name: z.string(),
})
export const UserSetNameResponse = z.union([
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), error: z.string() }),
])
