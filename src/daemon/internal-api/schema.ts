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

// ── POST /v1/share/page ──────────────────────────────────────────────────────

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

// ── POST /v1/share/resurface ─────────────────────────────────────────────────

export const ShareResurfaceRequest = z.object({
  slug: z.string().optional(),
  title_fragment: z.string().optional(),
})
export const ShareResurfaceResponse = z.union([
  z.object({ url: z.string(), slug: z.string() }),
  z.object({ ok: z.literal(false), reason: z.literal('not found') }),
  z.object({ ok: z.literal(false), error: z.string() }),
])

// ── GET /v1/voice/status ─────────────────────────────────────────────────────
// Pinned to WechatVoiceDep.configStatus() return shape in wechat-tool-deps.ts.

export const VoiceStatusResponse = z.union([
  z.object({ configured: z.literal(false) }),
  z.object({
    configured: z.literal(true),
    provider: z.enum(['http_tts', 'qwen']),
    default_voice: z.string(),
    base_url: z.string().optional(),
    model: z.string().optional(),
    saved_at: z.string(),
  }),
])

// ── POST /v1/voice/save_config ───────────────────────────────────────────────

export const VoiceSaveConfigRequest = z.object({
  provider: z.enum(['http_tts', 'qwen']),
  base_url: z.string().optional(),
  model: z.string().optional(),
  api_key: z.string().optional(),
  default_voice: z.string().optional(),
})
// Pinned to WechatVoiceDep.saveConfig() return shape.
// ok=true branch also includes tested_ms, provider, default_voice.
// Catch path in routes.ts emits {ok:false, reason:'unexpected_error', detail}.
export const VoiceSaveConfigResponse = z.union([
  z.object({ ok: z.literal(true), tested_ms: z.number(), provider: z.string(), default_voice: z.string() }),
  z.object({ ok: z.literal(false), reason: z.string(), detail: z.string().optional() }),
])

// ── GET /v1/companion/status ─────────────────────────────────────────────────
// Pinned to WechatCompanionDep.status() return shape.

export const CompanionStatusResponse = z.object({
  enabled: z.boolean(),
  timezone: z.string(),
  default_chat_id: z.string().nullable(),
  snooze_until: z.string().nullable(),
})

// ── POST /v1/companion/enable ────────────────────────────────────────────────
// Pinned to WechatCompanionDep.enable() return shape (two ok=true variants).
// Union includes forward-compat ok=false branch.

export const CompanionEnableResponse = z.union([
  z.object({
    ok: z.literal(true),
    state_dir: z.string(),
    welcome_message: z.string(),
    cost_estimate_note: z.string(),
  }),
  z.object({ ok: z.literal(true), already_configured: z.literal(true) }),
  z.object({ ok: z.literal(false), error: z.string() }),
])

// ── POST /v1/companion/disable ───────────────────────────────────────────────
// Pinned to WechatCompanionDep.disable() return shape + forward-compat error.

export const CompanionDisableResponse = z.union([
  z.object({ ok: z.literal(true), enabled: z.literal(false) }),
  z.object({ ok: z.literal(false), error: z.string() }),
])

// ── POST /v1/companion/snooze ────────────────────────────────────────────────

export const CompanionSnoozeRequest = z.object({
  minutes: z.number().int().min(1).max(1440),
})
// Pinned to WechatCompanionDep.snooze() return shape + forward-compat error.
export const CompanionSnoozeResponse = z.union([
  z.object({ ok: z.literal(true), until: z.string() }),
  z.object({ ok: z.literal(false), error: z.string() }),
])
