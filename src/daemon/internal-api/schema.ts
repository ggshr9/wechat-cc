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

// ── POST /v1/wechat/reply ────────────────────────────────────────────────────

export const WechatReplyRequest = z.object({
  chat_id: z.string(),
  text: z.string(),
  participant_tag: z.string().optional(),
})
export const WechatReplyResponse = z.union([
  z.object({ ok: z.literal(true), msg_id: z.string() }),
  z.object({ ok: z.literal(false), error: z.string() }),
])

// ── POST /v1/wechat/reply_voice ──────────────────────────────────────────────
// text is capped at 500 chars (enforced by the route handler).
// Response is from WechatVoiceDep.replyVoice() or the handler's own error shapes.

export const WechatReplyVoiceRequest = z.object({
  chat_id: z.string(),
  text: z.string(),
})
export const WechatReplyVoiceResponse = z.union([
  z.object({ ok: z.literal(true), msgId: z.string() }),
  z.object({ ok: z.literal(false), reason: z.literal('too_long'), limit: z.literal(500) }),
  z.object({ ok: z.literal(false), reason: z.string(), detail: z.string().optional() }),
])

// ── POST /v1/wechat/send_file ────────────────────────────────────────────────

export const WechatSendFileRequest = z.object({
  chat_id: z.string(),
  path: z.string(),
})
export const WechatSendFileResponse = z.union([
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), error: z.string() }),
])

// ── POST /v1/wechat/edit_message ─────────────────────────────────────────────

export const WechatEditMessageRequest = z.object({
  chat_id: z.string(),
  msg_id: z.string(),
  text: z.string(),
})
export const WechatEditMessageResponse = z.union([
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), error: z.string() }),
])

// ── POST /v1/wechat/broadcast ────────────────────────────────────────────────

export const WechatBroadcastRequest = z.object({
  text: z.string(),
  account_id: z.string().optional(),
})
// deps.ilink.broadcast() returns {ok: number, failed: number} (counts).
// Catch path returns {ok:false, error}.
export const WechatBroadcastResponse = z.union([
  z.object({ ok: z.number(), failed: z.number() }),
  z.object({ ok: z.literal(false), error: z.string() }),
])

// ── POST /v1/delegate ────────────────────────────────────────────────────────
// cwd must start with '/' if provided (enforced by route handler).

export const DelegateRequest = z.object({
  peer: z.string(),
  prompt: z.string(),
  context_summary: z.string().optional(),
  cwd: z.string().refine(s => s.startsWith('/'), { message: 'cwd_must_be_absolute' }).optional(),
  depth: z.number().optional(),
})
export const DelegateResponse = z.union([
  z.object({
    ok: z.literal(true),
    response: z.string(),
    num_turns: z.number().optional(),
    duration_ms: z.number().optional(),
  }),
  z.object({ ok: z.literal(false), reason: z.string() }),
])

// ── POST /v1/conversation/set-mode ──────────────────────────────────────────
// chatId is camelCase — intentional divergence from other wechat routes.
// Mode is a discriminated union matching the runtime Mode type in conversation.ts.

const ModeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('solo'), provider: z.string() }),
  z.object({ kind: z.literal('parallel') }),
  z.object({ kind: z.literal('primary_tool'), primary: z.string() }),
  z.object({ kind: z.literal('chatroom') }),
])

export const ConversationSetModeRequest = z.object({
  chatId: z.string(),
  mode: ModeSchema,
})
export const ConversationSetModeResponse = z.union([
  z.object({ ok: z.literal(true) }),
  z.object({ error: z.string() }),
])

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
