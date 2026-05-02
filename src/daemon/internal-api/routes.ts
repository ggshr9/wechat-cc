/**
 * Route table for internal-api. Returns the full Record<"METHOD /path", handler>
 * given a deps closure + a `getDelegate` accessor (for late-binding via
 * setDelegate) + a `maybePrefix` helper (kept in index.ts because it
 * captures the same deps closure that auth/dispatch do).
 *
 * Adding a new endpoint = add a row in the appropriate section. The
 * sections are kept in stable order to match the original file's layout
 * so blame survives the split.
 */
import { errMsg, type InternalApiDeps, type InternalApiDelegateDep, type RouteTable } from './types'
import { modeRequiresParticipantPrefix } from '../../core/conversation'

export interface MakeRoutesContext {
  deps: InternalApiDeps
  getDelegate: () => InternalApiDelegateDep | null
  maybePrefix: (chatId: string, text: string, tag: string | undefined) => string
}

export function makeRoutes({ deps, getDelegate, maybePrefix }: MakeRoutesContext): RouteTable {
  return {
    'GET /v1/health': () => ({ status: 200, body: { ok: true, daemon_pid: deps.daemonPid } }),

    // ── memory (RFC 03 P1.B B2) ─────────────────────────────────────────
    'POST /v1/memory/read': (_q, body) => {
      if (!deps.memory) return { status: 503, body: { error: 'memory_fs_not_wired' } }
      const path = (body as { path?: unknown } | null)?.path
      if (typeof path !== 'string') return { status: 400, body: { error: 'path_required' } }
      try {
        const content = deps.memory.read(path)
        return { status: 200, body: content === null ? { exists: false } : { exists: true, content } }
      } catch (err) {
        return { status: 200, body: { error: errMsg(err) } }
      }
    },
    'POST /v1/memory/write': (_q, body) => {
      if (!deps.memory) return { status: 503, body: { error: 'memory_fs_not_wired' } }
      const b = body as { path?: unknown; content?: unknown } | null
      if (typeof b?.path !== 'string') return { status: 400, body: { error: 'path_required' } }
      if (typeof b?.content !== 'string') return { status: 400, body: { error: 'content_required' } }
      try {
        deps.memory.write(b.path, b.content)
        return { status: 200, body: { ok: true } }
      } catch (err) {
        return { status: 200, body: { ok: false, error: errMsg(err) } }
      }
    },
    'GET /v1/memory/list': (q) => {
      if (!deps.memory) return { status: 503, body: { error: 'memory_fs_not_wired' } }
      const dir = q.get('dir')
      try {
        return { status: 200, body: { files: deps.memory.list(dir ?? undefined) } }
      } catch (err) {
        return { status: 200, body: { error: errMsg(err) } }
      }
    },

    // ── projects (RFC 03 P1.B B3) ───────────────────────────────────────
    'GET /v1/projects/list': () => {
      if (!deps.projects) return { status: 503, body: { error: 'projects_not_wired' } }
      // Legacy wire shape returned the array directly (not wrapped). Preserve.
      return { status: 200, body: deps.projects.list() }
    },
    'POST /v1/projects/switch': async (_q, body) => {
      if (!deps.projects) return { status: 503, body: { error: 'projects_not_wired' } }
      const alias = (body as { alias?: unknown } | null)?.alias
      if (typeof alias !== 'string') return { status: 400, body: { error: 'alias_required' } }
      const r = await deps.projects.switchTo(alias)
      return { status: 200, body: r }
    },
    'POST /v1/projects/add': async (_q, body) => {
      if (!deps.projects) return { status: 503, body: { error: 'projects_not_wired' } }
      const b = body as { alias?: unknown; path?: unknown } | null
      if (typeof b?.alias !== 'string') return { status: 400, body: { error: 'alias_required' } }
      if (typeof b?.path !== 'string') return { status: 400, body: { error: 'path_required' } }
      try {
        await deps.projects.add(b.alias, b.path)
        return { status: 200, body: { ok: true } }
      } catch (err) {
        // Match legacy behaviour: in-process tool handler did not catch
        // here; the SDK surfaced the error. Mirror that by returning 200
        // with {ok:false,error} so the agent sees a structured result
        // rather than a transport exception. Stricter callers can read
        // the body and decide.
        return { status: 200, body: { ok: false, error: errMsg(err) } }
      }
    },
    'POST /v1/projects/remove': async (_q, body) => {
      if (!deps.projects) return { status: 503, body: { error: 'projects_not_wired' } }
      const alias = (body as { alias?: unknown } | null)?.alias
      if (typeof alias !== 'string') return { status: 400, body: { error: 'alias_required' } }
      try {
        await deps.projects.remove(alias)
        return { status: 200, body: { ok: true } }
      } catch (err) {
        return { status: 200, body: { ok: false, error: errMsg(err) } }
      }
    },

    // ── user name (RFC 03 P1.B B3) ──────────────────────────────────────
    'POST /v1/user/set_name': async (_q, body) => {
      if (!deps.setUserName) return { status: 503, body: { error: 'set_user_name_not_wired' } }
      const b = body as { chat_id?: unknown; name?: unknown } | null
      if (typeof b?.chat_id !== 'string') return { status: 400, body: { error: 'chat_id_required' } }
      if (typeof b?.name !== 'string') return { status: 400, body: { error: 'name_required' } }
      try {
        await deps.setUserName(b.chat_id, b.name)
        return { status: 200, body: { ok: true } }
      } catch (err) {
        return { status: 200, body: { ok: false, error: errMsg(err) } }
      }
    },

    // ── share_page / resurface_page (RFC 03 P1.B B5) ────────────────────
    'POST /v1/share/page': async (_q, body) => {
      if (!deps.sharePage) return { status: 503, body: { error: 'share_page_not_wired' } }
      const b = body as {
        title?: unknown; content?: unknown
        needs_approval?: unknown; chat_id?: unknown; account_id?: unknown
      } | null
      if (typeof b?.title !== 'string') return { status: 400, body: { error: 'title_required' } }
      if (typeof b?.content !== 'string') return { status: 400, body: { error: 'content_required' } }
      // Mirror legacy behaviour: only forward opts the agent supplied;
      // omit the entire arg if all opts are absent (deps.sharePage relies
      // on `undefined` to mean "use defaults" — passing {} would override).
      const opts: { needs_approval?: boolean; chat_id?: string; account_id?: string } = {}
      if (b.needs_approval === true) opts.needs_approval = true
      if (typeof b.chat_id === 'string') opts.chat_id = b.chat_id
      if (typeof b.account_id === 'string') opts.account_id = b.account_id
      try {
        const r = await deps.sharePage(b.title, b.content, Object.keys(opts).length ? opts : undefined)
        return { status: 200, body: r }
      } catch (err) {
        return { status: 200, body: { ok: false, error: errMsg(err) } }
      }
    },
    'POST /v1/share/resurface': async (_q, body) => {
      if (!deps.resurfacePage) return { status: 503, body: { error: 'resurface_page_not_wired' } }
      const b = body as { slug?: unknown; title_fragment?: unknown } | null
      if (b?.slug !== undefined && typeof b.slug !== 'string') {
        return { status: 400, body: { error: 'slug_must_be_string' } }
      }
      if (b?.title_fragment !== undefined && typeof b.title_fragment !== 'string') {
        return { status: 400, body: { error: 'title_fragment_must_be_string' } }
      }
      try {
        const r = await deps.resurfacePage({
          ...(typeof b?.slug === 'string' ? { slug: b.slug } : {}),
          ...(typeof b?.title_fragment === 'string' ? { title_fragment: b.title_fragment } : {}),
        })
        // Legacy wire shape: returns the page record OR `{ok:false, reason:'not found'}`.
        return { status: 200, body: r ?? { ok: false, reason: 'not found' } }
      } catch (err) {
        return { status: 200, body: { ok: false, error: errMsg(err) } }
      }
    },

    // ── voice config (RFC 03 P1.B B4) ───────────────────────────────────
    'GET /v1/voice/status': () => {
      if (!deps.voice) return { status: 503, body: { error: 'voice_not_wired' } }
      // configStatus is sync, never throws — direct return.
      return { status: 200, body: deps.voice.configStatus() }
    },
    // ── companion proactive tick (RFC 03 P1.B B6) ───────────────────────
    'GET /v1/companion/status': () => {
      if (!deps.companion) return { status: 503, body: { error: 'companion_not_wired' } }
      return { status: 200, body: deps.companion.status() }
    },
    'POST /v1/companion/enable': async () => {
      if (!deps.companion) return { status: 503, body: { error: 'companion_not_wired' } }
      try {
        const r = await deps.companion.enable()
        return { status: 200, body: r }
      } catch (err) {
        return { status: 200, body: { ok: false, error: errMsg(err) } }
      }
    },
    'POST /v1/companion/disable': async () => {
      if (!deps.companion) return { status: 503, body: { error: 'companion_not_wired' } }
      try {
        const r = await deps.companion.disable()
        return { status: 200, body: r }
      } catch (err) {
        return { status: 200, body: { ok: false, error: errMsg(err) } }
      }
    },
    'POST /v1/companion/snooze': async (_q, body) => {
      if (!deps.companion) return { status: 503, body: { error: 'companion_not_wired' } }
      const minutes = (body as { minutes?: unknown } | null)?.minutes
      if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < 1 || minutes > 24 * 60) {
        return { status: 400, body: { error: 'minutes_must_be_int_1_to_1440' } }
      }
      try {
        const r = await deps.companion.snooze(minutes)
        return { status: 200, body: r }
      } catch (err) {
        return { status: 200, body: { ok: false, error: errMsg(err) } }
      }
    },

    // ── ilink-bound message family (RFC 03 P1.B B1) ─────────────────────
    // The reply / reply_voice / send_file / edit_message / broadcast tools
    // detected by both providers' replyToolCalled flag. After B1 these are
    // exposed by the stdio `wechat` server (renamed from `wechat_ipc`),
    // which is what claude-agent-provider's REPLY_TOOL_NAMES set and
    // codex-agent-provider's WECHAT_MCP_SERVER='wechat' check match against.
    'POST /v1/wechat/reply': async (_q, body) => {
      if (!deps.ilink) return { status: 503, body: { error: 'ilink_not_wired' } }
      const b = body as { chat_id?: unknown; text?: unknown; participant_tag?: unknown } | null
      if (typeof b?.chat_id !== 'string') return { status: 400, body: { error: 'chat_id_required' } }
      if (typeof b?.text !== 'string') return { status: 400, body: { error: 'text_required' } }
      // RFC 03 P3 — mode-aware prefixing. Only applies when the chat is
      // in a multi-participant mode AND the caller supplied its tag.
      // Solo mode (and absent prefix deps) → text passes through unchanged.
      const tag = typeof b.participant_tag === 'string' ? b.participant_tag : undefined
      const prefixed = maybePrefix(b.chat_id, b.text, tag)
      try {
        const r = await deps.ilink.sendReply(b.chat_id, prefixed)
        // Legacy in-process wrapper reshaped {msgId,error?} → {ok,msg_id} or
        // {ok:false,error}. Preserve verbatim so the agent's mental model
        // doesn't shift across this migration.
        if (r.error) return { status: 200, body: { ok: false, error: r.error } }
        return { status: 200, body: { ok: true, msg_id: r.msgId } }
      } catch (err) {
        return { status: 200, body: { ok: false, error: errMsg(err) } }
      }
    },
    'POST /v1/wechat/reply_voice': async (_q, body) => {
      if (!deps.voice) return { status: 503, body: { error: 'voice_not_wired' } }
      const b = body as { chat_id?: unknown; text?: unknown } | null
      if (typeof b?.chat_id !== 'string') return { status: 400, body: { error: 'chat_id_required' } }
      if (typeof b?.text !== 'string') return { status: 400, body: { error: 'text_required' } }
      // Legacy 500-char cap on the text — short enough for a voice
      // message, also rejects code blocks and long URLs as spec'd.
      if (b.text.length > 500) {
        return { status: 200, body: { ok: false, reason: 'too_long', limit: 500 } }
      }
      try {
        const r = await deps.voice.replyVoice(b.chat_id, b.text)
        return { status: 200, body: r }
      } catch (err) {
        return { status: 200, body: { ok: false, reason: 'unexpected_error', detail: errMsg(err) } }
      }
    },
    'POST /v1/wechat/send_file': async (_q, body) => {
      if (!deps.ilink) return { status: 503, body: { error: 'ilink_not_wired' } }
      const b = body as { chat_id?: unknown; path?: unknown } | null
      if (typeof b?.chat_id !== 'string') return { status: 400, body: { error: 'chat_id_required' } }
      if (typeof b?.path !== 'string') return { status: 400, body: { error: 'path_required' } }
      try {
        await deps.ilink.sendFile(b.chat_id, b.path)
        return { status: 200, body: { ok: true } }
      } catch (err) {
        return { status: 200, body: { ok: false, error: errMsg(err) } }
      }
    },
    'POST /v1/wechat/edit_message': async (_q, body) => {
      if (!deps.ilink) return { status: 503, body: { error: 'ilink_not_wired' } }
      const b = body as { chat_id?: unknown; msg_id?: unknown; text?: unknown } | null
      if (typeof b?.chat_id !== 'string') return { status: 400, body: { error: 'chat_id_required' } }
      if (typeof b?.msg_id !== 'string') return { status: 400, body: { error: 'msg_id_required' } }
      if (typeof b?.text !== 'string') return { status: 400, body: { error: 'text_required' } }
      try {
        await deps.ilink.editMessage(b.chat_id, b.msg_id, b.text)
        return { status: 200, body: { ok: true } }
      } catch (err) {
        return { status: 200, body: { ok: false, error: errMsg(err) } }
      }
    },
    // ── delegate consultation (RFC 03 P4) ───────────────────────────────
    'POST /v1/delegate': async (_q, body) => {
      const d = getDelegate()
      if (!d) return { status: 503, body: { error: 'delegate_not_wired' } }
      const b = body as { peer?: unknown; prompt?: unknown; context_summary?: unknown; cwd?: unknown; depth?: unknown } | null
      if (typeof b?.peer !== 'string') return { status: 400, body: { error: 'peer_required' } }
      if (typeof b?.prompt !== 'string') return { status: 400, body: { error: 'prompt_required' } }
      if (b.cwd !== undefined && typeof b.cwd !== 'string') return { status: 400, body: { error: 'cwd_must_be_string' } }
      // Light absolute-path check — block path traversal-ish inputs from a
      // misbehaving agent. dispatchOneShot's spawn won't enforce this, so
      // we do at the boundary.
      if (typeof b.cwd === 'string' && !b.cwd.startsWith('/')) {
        return { status: 400, body: { error: 'cwd_must_be_absolute' } }
      }
      const known = d.knownPeers()
      if (!known.includes(b.peer)) {
        return { status: 400, body: { error: 'unknown_peer', allowed: known } }
      }
      // RFC 03 P5 review #7 — defense in depth against recursion. The
      // bare delegate provider has no delegate-mcp loaded, so the peer
      // CAN'T call this route through normal paths — recursion is
      // structurally prevented. But a curious peer that read the token
      // file + posted directly could still attempt nesting; reject any
      // depth > 0 server-side as a backstop. (delegate-mcp client always
      // sends depth=0 from a regular session env; peers don't have the
      // env so they'd have to fabricate.)
      const depth = typeof b.depth === 'number' ? b.depth : 0
      if (depth > 0) {
        deps.log?.('DELEGATE', `nested-call rejected: peer=${b.peer} depth=${depth}`, {
          event: 'delegate_nested_rejected',
          peer: b.peer,
          depth,
        })
        return { status: 403, body: { ok: false, reason: 'nested_delegate_rejected', depth } }
      }
      // Compose the actual prompt that the peer sees. The peer is
      // bare-bones (no conversation history, no wechat tools), so the
      // prompt is self-contained.
      const fullPrompt = typeof b.context_summary === 'string' && b.context_summary.length > 0
        ? `${b.prompt}\n\nContext from the calling agent:\n${b.context_summary}`
        : b.prompt
      const started = Date.now()
      const cwdArg = typeof b.cwd === 'string' ? b.cwd : undefined
      try {
        const r = await d.dispatchOneShot(b.peer, fullPrompt, cwdArg)
        const elapsed = Date.now() - started
        if (r.ok) {
          deps.log?.('DELEGATE', `peer=${b.peer} ok response_chars=${r.response.length} ms=${elapsed}`, {
            event: 'delegate_ok',
            peer: b.peer,
            response_chars: r.response.length,
            duration_ms: elapsed,
          })
        } else {
          deps.log?.('DELEGATE', `peer=${b.peer} fail reason=${r.reason}`, {
            event: 'delegate_fail',
            peer: b.peer,
            reason: r.reason,
            duration_ms: elapsed,
          })
        }
        return { status: 200, body: r }
      } catch (err) {
        deps.log?.('DELEGATE', `peer=${b.peer} threw: ${errMsg(err)}`, {
          event: 'delegate_threw',
          peer: b.peer,
          error: errMsg(err),
          duration_ms: Date.now() - started,
        })
        return { status: 200, body: { ok: false, reason: errMsg(err) } }
      }
    },

    'POST /v1/wechat/broadcast': async (_q, body) => {
      if (!deps.ilink) return { status: 503, body: { error: 'ilink_not_wired' } }
      const b = body as { text?: unknown; account_id?: unknown } | null
      if (typeof b?.text !== 'string') return { status: 400, body: { error: 'text_required' } }
      const accountId = typeof b?.account_id === 'string' ? b.account_id : undefined
      try {
        const r = await deps.ilink.broadcast(b.text, accountId)
        return { status: 200, body: r }
      } catch (err) {
        return { status: 200, body: { ok: false, error: errMsg(err) } }
      }
    },

    'POST /v1/voice/save_config': async (_q, body) => {
      if (!deps.voice) return { status: 503, body: { error: 'voice_not_wired' } }
      const b = body as {
        provider?: unknown
        base_url?: unknown
        model?: unknown
        api_key?: unknown
        default_voice?: unknown
      } | null
      if (b?.provider !== 'http_tts' && b?.provider !== 'qwen') {
        return { status: 400, body: { error: 'provider_required', allowed: ['http_tts', 'qwen'] } }
      }
      // saveConfig handles its own validation + test-synth; surface its
      // ok-true / ok-false-reason verbatim. Catch transport-level
      // unexpected errors and shape them into the same {ok:false,reason}
      // contract so the agent sees a structured failure.
      try {
        const r = await deps.voice.saveConfig({
          provider: b.provider,
          ...(typeof b.base_url === 'string' ? { base_url: b.base_url } : {}),
          ...(typeof b.model === 'string' ? { model: b.model } : {}),
          ...(typeof b.api_key === 'string' ? { api_key: b.api_key } : {}),
          ...(typeof b.default_voice === 'string' ? { default_voice: b.default_voice } : {}),
        })
        return { status: 200, body: r }
      } catch (err) {
        return { status: 200, body: { ok: false, reason: 'unexpected_error', detail: errMsg(err) } }
      }
    },
  }
}

/**
 * RFC 03 review #5 fix: defers the "is this a multi-participant mode?"
 * decision to `modeRequiresParticipantPrefix` in src/core/conversation.ts
 * so internal-api stops switching on mode.kind directly. Adding a new
 * multi-participant mode requires updating exactly that one helper.
 */
export function makeMaybePrefix(deps: InternalApiDeps): (chatId: string, text: string, tag: string | undefined) => string {
  return function maybePrefix(chatId, text, tag) {
    if (!tag || !deps.prefix) return text
    const mode = deps.prefix.conversationStore.get(chatId)?.mode
    if (!mode) return text
    if (!modeRequiresParticipantPrefix(mode)) return text
    const dn = deps.prefix.providerDisplayName(tag)
    return `[${dn}] ${text}`
  }
}
