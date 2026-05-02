/**
 * wechat-tool-deps.ts — shape definitions for the wechat tool dependencies
 * shared across the daemon. Until P1.B B1 these types lived in
 * src/features/tools.ts as parts of the in-process MCP server's `ToolDeps`
 * struct; that file is now gone (the tools are exclusively served by the
 * standalone wechat-mcp stdio server). Centralising the types here lets
 * ilink-glue and internal-api both speak the same shapes without
 * resurrecting the old tools.ts module.
 *
 * Intentional split between this file and InternalApiDeps in
 * src/daemon/internal-api.ts: the canonical (full) ilink shapes live here;
 * internal-api may carry narrower subsets when only certain methods are
 * used by routes (it doesn't, today — the routes just import these
 * directly — but the option exists).
 */

/** Project registry (alias → cwd path). */
export interface WechatProjectsDep {
  list(): { alias: string; path: string; current: boolean }[]
  switchTo(alias: string): Promise<{ ok: true; path: string } | { ok: false; reason: string }>
  add(alias: string, path: string): Promise<void>
  remove(alias: string): Promise<void>
}

/**
 * Voice / TTS — both config-shape methods AND the ilink-bound replyVoice
 * that uploads an audio message to wechat. internal-api needs all three
 * after RFC 03 P1.B B1 (replyVoice for the `reply_voice` tool, the others
 * for `voice_config_status` / `save_voice_config`).
 */
export interface WechatVoiceDep {
  /** Returns {ok, msgId} or {ok:false, reason}. Generates audio, uploads via ilink, returns result. */
  replyVoice(chatId: string, text: string): Promise<
    | { ok: true; msgId: string }
    | { ok: false; reason: string }
  >
  /** Validates input (test synth), then persists. Returns ok + tested_ms on success. */
  saveConfig(input: {
    provider: 'http_tts' | 'qwen'
    base_url?: string
    model?: string
    api_key?: string
    default_voice?: string
  }): Promise<
    | { ok: true; tested_ms: number; provider: string; default_voice: string }
    | { ok: false; reason: string; detail?: string }
  >
  /** Returns current config status (does NOT leak api_key). */
  configStatus():
    | { configured: false }
    | {
        configured: true
        provider: 'http_tts' | 'qwen'
        default_voice: string
        base_url?: string
        model?: string
        saved_at: string
      }
}

/** Companion proactive-tick controls. */
export interface WechatCompanionDep {
  /** Turn on proactive tick. Idempotent. Scaffolds minimal config on first call. */
  enable(): Promise<
    | {
        ok: true
        state_dir: string
        welcome_message: string
        cost_estimate_note: string
      }
    | { ok: true; already_configured: true }
  >
  disable(): Promise<{ ok: true; enabled: false }>
  /** Minimal status: are proactive ticks on? snoozed until when? */
  status(): {
    enabled: boolean
    timezone: string
    default_chat_id: string | null
    snooze_until: string | null
  }
  snooze(minutes: number): Promise<{ ok: true; until: string }>
}
