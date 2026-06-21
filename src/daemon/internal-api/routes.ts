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
import { randomBytes } from 'node:crypto'
import { errMsg, type InternalApiDeps, type InternalApiDelegateDep, type RouteTable } from './types'
import { lookup } from '../../core/capability-matrix'
import { loadAgentConfig, saveAgentConfig } from '../../lib/agent-config'
import type { Mode } from '../../core/conversation'
import { makeEventsStore } from '../events/store'
import type {
  MemoryReadRequestT, MemoryWriteRequestT, MemoryDeleteRequestT,
  ProjectsSwitchRequestT, ProjectsAddRequestT, ProjectsRemoveRequestT,
  UserSetNameRequestT,
  SharePageRequestT, ShareResurfaceRequestT,
  VoiceSaveConfigRequestT,
  CompanionSnoozeRequestT,
  WechatReplyRequestT, WechatReplyVoiceRequestT, WechatSendFileRequestT,
  WechatEditMessageRequestT, WechatBroadcastRequestT,
  DelegateRequestT,
  ConversationSetModeRequestT,
  A2ASendRequestT,
  A2APreviewRequestT,
  A2AInstallRequestT,
  A2ARemoveRequestT,
  A2APauseRequestT,
} from './schema'

export interface MakeRoutesContext {
  deps: InternalApiDeps
  getDelegate: () => InternalApiDelegateDep | null
  maybePrefix: (chatId: string, text: string, tag: string | undefined) => string
}

export function makeRoutes({ deps, getDelegate, maybePrefix }: MakeRoutesContext): RouteTable {
  return {
    'GET /v1/health': () => ({
      status: 200,
      body: {
        ok: true,
        daemon_pid: deps.daemonPid,
        // Ops fields for the admin self-diagnosis tool: is the turn store
        // wired, how many sessions are live, is the poll-cycle heartbeat
        // fresh (false ⇒ the daemon may be wedged / not serving).
        turns_store_wired: !!deps.turns,
        sessions_live: deps.listSessions?.()?.length ?? 0,
        heartbeat_fresh: deps.heartbeatFresh?.() ?? null,
      },
    }),

    // ── memory (RFC 03 P1.B B2) ─────────────────────────────────────────
    'POST /v1/memory/read': (_q, body) => {
      if (!deps.memory) return { status: 503, body: { error: 'memory_fs_not_wired' } }
      // Body is pre-validated by index.ts via MemoryReadRequest schema.
      const { path } = body as MemoryReadRequestT
      try {
        const content = deps.memory.read(path)
        return { status: 200, body: content === null ? { exists: false } : { exists: true, content } }
      } catch (err) {
        return { status: 200, body: { error: errMsg(err) } }
      }
    },
    'POST /v1/memory/write': (_q, body) => {
      if (!deps.memory) return { status: 503, body: { error: 'memory_fs_not_wired' } }
      // Body is pre-validated by index.ts via MemoryWriteRequest schema.
      const { path, content } = body as MemoryWriteRequestT
      try {
        deps.memory.write(path, content)
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
    'POST /v1/memory/delete': async (_q, body) => {
      if (!deps.memory) return { status: 503, body: { error: 'memory_fs_not_wired' } }
      if (!deps.db) return { status: 503, body: { error: 'db_not_wired' } }
      // Body is pre-validated by index.ts via MemoryDeleteRequest schema.
      const { chat_id, path, reason } = body as MemoryDeleteRequestT
      try {
        const tombstone = deps.memory.softDelete(path)
        if (tombstone === null) {
          return { status: 200, body: { ok: true, existed: false } }
        }
        // Per-chat audit log. Constructed per-call — prepared-statement
        // cache lives on db, not store, so this is cheap.
        await makeEventsStore(deps.db, chat_id).append({
          kind: 'memory_deleted',
          trigger: 'mcp_tool_call',
          reasoning: reason,
          memory_path: tombstone,
        })
        return { status: 200, body: { ok: true, existed: true, tombstone } }
      } catch (err) {
        return { status: 200, body: { ok: false, error: errMsg(err) } }
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
      // Body is pre-validated by index.ts via ProjectsSwitchRequest schema.
      const { alias } = body as ProjectsSwitchRequestT
      const r = await deps.projects.switchTo(alias)
      return { status: 200, body: r }
    },
    'POST /v1/projects/add': async (_q, body) => {
      if (!deps.projects) return { status: 503, body: { error: 'projects_not_wired' } }
      // Body is pre-validated by index.ts via ProjectsAddRequest schema.
      const { alias, path } = body as ProjectsAddRequestT
      try {
        await deps.projects.add(alias, path)
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
      // Body is pre-validated by index.ts via ProjectsRemoveRequest schema.
      const { alias } = body as ProjectsRemoveRequestT
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
      // Body is pre-validated by index.ts via UserSetNameRequest schema.
      const { chat_id, name } = body as UserSetNameRequestT
      try {
        await deps.setUserName(chat_id, name)
        return { status: 200, body: { ok: true } }
      } catch (err) {
        return { status: 200, body: { ok: false, error: errMsg(err) } }
      }
    },

    // ── share_page / resurface_page (RFC 03 P1.B B5) ────────────────────
    'POST /v1/share/page': async (_q, body) => {
      if (!deps.sharePage) return { status: 503, body: { error: 'share_page_not_wired' } }
      // Body is pre-validated by index.ts via SharePageRequest schema.
      const { title, content, needs_approval, chat_id, account_id } = body as SharePageRequestT
      // Mirror legacy behaviour: only forward opts the agent supplied;
      // omit the entire arg if all opts are absent (deps.sharePage relies
      // on `undefined` to mean "use defaults" — passing {} would override).
      const opts: { needs_approval?: boolean; chat_id?: string; account_id?: string } = {}
      if (needs_approval === true) opts.needs_approval = true
      if (chat_id !== undefined) opts.chat_id = chat_id
      if (account_id !== undefined) opts.account_id = account_id
      try {
        const r = await deps.sharePage(title, content, Object.keys(opts).length ? opts : undefined)
        return { status: 200, body: r }
      } catch (err) {
        return { status: 200, body: { ok: false, error: errMsg(err) } }
      }
    },
    'POST /v1/share/resurface': async (_q, body) => {
      if (!deps.resurfacePage) return { status: 503, body: { error: 'resurface_page_not_wired' } }
      // Body is pre-validated by index.ts via ShareResurfaceRequest schema.
      const { slug, title_fragment } = body as ShareResurfaceRequestT
      try {
        const r = await deps.resurfacePage({
          ...(slug !== undefined ? { slug } : {}),
          ...(title_fragment !== undefined ? { title_fragment } : {}),
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
      // Body is pre-validated by index.ts via CompanionSnoozeRequest schema.
      const { minutes } = body as CompanionSnoozeRequestT
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
      // Body is pre-validated by index.ts via WechatReplyRequest schema.
      const { chat_id, text, participant_tag } = body as WechatReplyRequestT
      // RFC 03 P3 — mode-aware prefixing. Only applies when the chat is
      // in a multi-participant mode AND the caller supplied its tag.
      // Solo mode (and absent prefix deps) → text passes through unchanged.
      const prefixed = maybePrefix(chat_id, text, participant_tag)
      try {
        const r = await deps.ilink.sendReply(chat_id, prefixed)
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
      // Body is pre-validated by index.ts via WechatReplyVoiceRequest schema.
      const { chat_id, text } = body as WechatReplyVoiceRequestT
      // Business rule: enforce 500-char cap with structured reason, not schema validation.
      // Schema is structural (shape), not business (value range).
      if (text.length > 500) {
        return { status: 200, body: { ok: false, reason: 'too_long', limit: 500 } }
      }
      try {
        const r = await deps.voice.replyVoice(chat_id, text)
        return { status: 200, body: r }
      } catch (err) {
        return { status: 200, body: { ok: false, reason: 'unexpected_error', detail: errMsg(err) } }
      }
    },
    'POST /v1/wechat/send_file': async (_q, body) => {
      if (!deps.ilink) return { status: 503, body: { error: 'ilink_not_wired' } }
      // Body is pre-validated by index.ts via WechatSendFileRequest schema.
      const { chat_id, path } = body as WechatSendFileRequestT
      try {
        await deps.ilink.sendFile(chat_id, path)
        return { status: 200, body: { ok: true } }
      } catch (err) {
        return { status: 200, body: { ok: false, error: errMsg(err) } }
      }
    },
    'POST /v1/wechat/edit_message': async (_q, body) => {
      if (!deps.ilink) return { status: 503, body: { error: 'ilink_not_wired' } }
      // Body is pre-validated by index.ts via WechatEditMessageRequest schema.
      const { chat_id, msg_id, text } = body as WechatEditMessageRequestT
      try {
        await deps.ilink.editMessage(chat_id, msg_id, text)
        return { status: 200, body: { ok: true } }
      } catch (err) {
        return { status: 200, body: { ok: false, error: errMsg(err) } }
      }
    },
    // ── delegate consultation (RFC 03 P4) ───────────────────────────────
    'POST /v1/delegate': async (_q, body) => {
      const d = getDelegate()
      if (!d) return { status: 503, body: { error: 'delegate_not_wired' } }
      // Body is pre-validated by index.ts via DelegateRequest schema.
      // Schema enforces: peer (string), prompt (string), optional cwd (absolute path),
      // optional context_summary (string), optional depth (number).
      const { peer, prompt, context_summary, cwd, depth: depthVal } = body as DelegateRequestT
      const known = d.knownPeers()
      if (!known.includes(peer)) {
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
      const depth = depthVal ?? 0
      if (depth > 0) {
        deps.log?.('DELEGATE', `nested-call rejected: peer=${peer} depth=${depth}`, {
          event: 'delegate_nested_rejected',
          peer,
          depth,
        })
        return { status: 403, body: { ok: false, reason: 'nested_delegate_rejected', depth } }
      }
      // Compose the actual prompt that the peer sees. The peer is
      // bare-bones (no conversation history, no wechat tools), so the
      // prompt is self-contained.
      const fullPrompt = context_summary && context_summary.length > 0
        ? `${prompt}\n\nContext from the calling agent:\n${context_summary}`
        : prompt
      const started = Date.now()
      try {
        const r = await d.dispatchOneShot(peer, fullPrompt, cwd)
        const elapsed = Date.now() - started
        if (r.ok) {
          deps.log?.('DELEGATE', `peer=${peer} ok response_chars=${r.response.length} ms=${elapsed}`, {
            event: 'delegate_ok',
            peer,
            response_chars: r.response.length,
            duration_ms: elapsed,
          })
        } else {
          deps.log?.('DELEGATE', `peer=${peer} fail reason=${r.reason}`, {
            event: 'delegate_fail',
            peer,
            reason: r.reason,
            duration_ms: elapsed,
          })
        }
        return { status: 200, body: r }
      } catch (err) {
        deps.log?.('DELEGATE', `peer=${peer} threw: ${errMsg(err)}`, {
          event: 'delegate_threw',
          peer,
          error: errMsg(err),
          duration_ms: Date.now() - started,
        })
        return { status: 200, body: { ok: false, reason: errMsg(err) } }
      }
    },

    'POST /v1/wechat/broadcast': async (_q, body) => {
      if (!deps.ilink) return { status: 503, body: { error: 'ilink_not_wired' } }
      // Body is pre-validated by index.ts via WechatBroadcastRequest schema.
      const { text, account_id } = body as WechatBroadcastRequestT
      try {
        const r = await deps.ilink.broadcast(text, account_id)
        return { status: 200, body: r }
      } catch (err) {
        return { status: 200, body: { ok: false, error: errMsg(err) } }
      }
    },

    // ── conversation mode switch (console-triggered) ─────────────────────
    'POST /v1/conversation/set-mode': async (_q, body) => {
      if (!deps.conversation) return { status: 503, body: { error: 'conversation_not_wired' } }
      // Body is pre-validated by index.ts via ConversationSetModeRequest schema.
      // Schema enforces chatId (string) and mode (discriminated union of known kinds).
      const { chatId, mode } = body as ConversationSetModeRequestT
      try {
        deps.conversation.setMode(chatId, mode as unknown as Mode)
      } catch (err) {
        return { status: 400, body: { error: errMsg(err) } }
      }
      // Human-readable name for the confirmation message.
      const kindNames: Record<string, string> = {
        solo: `solo · ${'provider' in mode ? mode.provider : '?'}`,
        parallel: 'parallel',
        primary_tool: `primary_tool · ${'primary' in mode ? mode.primary : '?'}`,
        chatroom: 'chatroom',
      }
      const humanName = kindNames[mode.kind] ?? String(mode.kind)
      // Best-effort wechat reply — never fail the route if send fails.
      if (deps.ilink) {
        deps.ilink.sendReply(chatId, `🎛 已切换到 ${humanName}（来自控制台）`).catch(err => {
          deps.log?.('SET_MODE', `wechat reply failed: ${errMsg(err)}`)
        })
      }
      deps.log?.('SET_MODE', `chat=${chatId} mode=${JSON.stringify(mode)}`, {
        event: 'set_mode_ok',
        chatId,
        mode,
      })
      return { status: 200, body: { ok: true } }
    },

    'POST /v1/voice/save_config': async (_q, body) => {
      if (!deps.voice) return { status: 503, body: { error: 'voice_not_wired' } }
      // Body is pre-validated by index.ts via VoiceSaveConfigRequest schema.
      const { provider, base_url, model, api_key, default_voice } = body as VoiceSaveConfigRequestT
      // saveConfig handles its own validation + test-synth; surface its
      // ok-true / ok-false-reason verbatim. Catch transport-level
      // unexpected errors and shape them into the same {ok:false,reason}
      // contract so the agent sees a structured failure.
      try {
        const r = await deps.voice.saveConfig({
          provider,
          ...(base_url !== undefined ? { base_url } : {}),
          ...(model !== undefined ? { model } : {}),
          ...(api_key !== undefined ? { api_key } : {}),
          ...(default_voice !== undefined ? { default_voice } : {}),
        })
        return { status: 200, body: r }
      } catch (err) {
        return { status: 200, body: { ok: false, reason: 'unexpected_error', detail: errMsg(err) } }
      }
    },

    // ── a2a outbound send ────────────────────────────────────────────────────
    'POST /v1/a2a/send': async (_q, body) => {
      if (!deps.a2a) return { status: 503, body: { error: 'a2a_not_wired' } }
      // Body is pre-validated by index.ts via A2ASendRequest schema.
      const { agent_id, text } = body as A2ASendRequestT
      const agent = deps.a2a.registry.get(agent_id)
      if (!agent) {
        return { status: 200, body: {
          ok: false, error: 'unknown_agent',
          registered: deps.a2a.registry.list().map(a => a.id),
        } }
      }
      if (agent.paused) {
        deps.a2a.recordEvent({ direction: 'out', agent_id, text, status: 'agent_paused' })
        return { status: 200, body: { ok: false, error: 'agent_paused' } }
      }
      const r = await deps.a2a.client.send({
        url: agent.url,
        bearer: agent.outbound_api_key,
        body: { text, source: { agent_id: 'wechat-cc' } },
      })
      const status: 'ok' | 'http_error' | 'timeout' =
        r.ok ? 'ok'
          : (r.error?.match(/timeout|aborted/i) ? 'timeout' : 'http_error')
      deps.a2a.recordEvent({
        direction: 'out', agent_id, text, status,
        ...(r.http_status !== undefined ? { http_status: r.http_status } : {}),
      })
      return { status: 200, body: r.ok
        ? { ok: true, ...(r.http_status !== undefined ? { http_status: r.http_status } : {}), ...(r.response !== undefined ? { response: r.response } : {}) }
        : { ok: false, error: r.error ?? 'unknown_error', ...(r.http_status !== undefined ? { http_status: r.http_status } : {}) }
      }
    },

    // ── a2a server-side smoke test (dashboard Test button) ──────────────────
    // Outbound mode: same behavior as /v1/a2a/send (we already have the
    // logic; could refactor to share but the path is short enough to inline).
    // Inbound mode: daemon POSTs to its OWN /a2a/notify with the agent's
    // inbound_api_key — the key never crosses the internal-api boundary, so
    // dashboard clients can't extract it.
    'POST /v1/a2a/test': async (_q, body) => {
      if (!deps.a2a) return { status: 503, body: { error: 'a2a_not_wired' } }
      // Body is pre-validated via A2ATestRequest schema.
      const { agent_id, text, outbound } = body as { agent_id: string; text: string; outbound: boolean }
      const agent = deps.a2a.registry.get(agent_id)
      if (!agent) {
        return { status: 200, body: {
          ok: false, direction: outbound ? 'out' : 'in', error: 'unknown_agent',
        } }
      }
      if (outbound) {
        // Re-use the outbound path semantics from /v1/a2a/send.
        if (agent.paused) {
          deps.a2a.recordEvent({ direction: 'out', agent_id, text, status: 'agent_paused' })
          return { status: 200, body: { ok: false, direction: 'out', error: 'agent_paused' } }
        }
        const r = await deps.a2a.client.send({
          url: agent.url, bearer: agent.outbound_api_key,
          body: { text, source: { agent_id: 'wechat-cc' } },
        })
        const eventStatus: 'ok' | 'http_error' | 'timeout' =
          r.ok ? 'ok' : (r.error?.match(/timeout|aborted/i) ? 'timeout' : 'http_error')
        deps.a2a.recordEvent({
          direction: 'out', agent_id, text, status: eventStatus,
          ...(r.http_status !== undefined ? { http_status: r.http_status } : {}),
        })
        return { status: 200, body: r.ok
          ? { ok: true, direction: 'out',
              ...(r.http_status !== undefined ? { http_status: r.http_status } : {}),
              ...(r.response !== undefined ? { response: r.response } : {}) }
          : { ok: false, direction: 'out', error: r.error ?? 'unknown_error',
              ...(r.http_status !== undefined ? { http_status: r.http_status } : {}) }
        }
      }
      // Inbound: POST to our own server. Requires A2A server to be running.
      if (!deps.a2a.serverEnabled || !deps.a2a.baseUrl) {
        return { status: 200, body: {
          ok: false, direction: 'in', error: 'a2a_server_disabled',
        } }
      }
      try {
        const res = await fetch(`${deps.a2a.baseUrl}/a2a/notify`, {
          method: 'POST',
          headers: {
            'authorization': `Bearer ${agent.inbound_api_key}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ agent_id, text }),
        })
        const responseText = await res.text()
        let response: unknown = responseText
        try { response = JSON.parse(responseText) } catch { /* keep raw */ }
        return { status: 200, body: res.ok
          ? { ok: true, direction: 'in', http_status: res.status, response }
          : { ok: false, direction: 'in', error: `http_${res.status}`, http_status: res.status }
        }
      } catch (err) {
        return { status: 200, body: {
          ok: false, direction: 'in', error: errMsg(err),
        } }
      }
    },

    // ── a2a dashboard routes ─────────────────────────────────────────────────
    'GET /v1/a2a/list': () => {
      if (!deps.a2a) return { status: 503, body: { error: 'a2a_not_wired' } }
      const agents = deps.a2a.registry.list().map(a => ({
        id: a.id,
        name: a.name,
        url: a.url,
        paused: a.paused,
        counts: deps.a2a!.eventsStore.counts(a.id),
      }))
      return { status: 200, body: { agents } }
    },

    'POST /v1/a2a/preview': async (_q, body) => {
      if (!deps.a2a) return { status: 503, body: { error: 'a2a_not_wired' } }
      // Body is pre-validated via A2APreviewRequest schema.
      const { url } = body as A2APreviewRequestT
      try {
        const card = await deps.a2a.client.fetchAgentCard(url)
        return { status: 200, body: card }
      } catch (err) {
        return { status: 200, body: { error: errMsg(err) } }
      }
    },

    'POST /v1/a2a/install': (_q, body) => {
      if (!deps.a2a) return { status: 503, body: { error: 'a2a_not_wired' } }
      // Body is pre-validated via A2AInstallRequest schema.
      const { id, name, url, outbound_api_key } = body as A2AInstallRequestT
      // Require a non-empty outbound key. Pre-fix the route fell back to
      // the literal string '(none)' which then went out over the wire as
      // `Authorization: Bearer (none)` — the remote agent returned 401 and
      // the operator only saw `http_error` in the activity drawer with no
      // hint that the cause was a missing key at install time.
      if (!outbound_api_key) {
        return { status: 200, body: { ok: false, error: 'outbound_api_key is required' } }
      }
      try {
        const inboundKey = `wc_${randomBytes(16).toString('hex')}`
        deps.a2a.registry.add({
          id, name, url,
          inbound_api_key: inboundKey,
          outbound_api_key,
          capabilities: [],
          paused: false,
          transport: 'push',
        })
        return { status: 200, body: { ok: true, inbound_api_key: inboundKey } }
      } catch (err) {
        return { status: 200, body: { ok: false, error: errMsg(err) } }
      }
    },

    'POST /v1/a2a/remove': (_q, body) => {
      if (!deps.a2a) return { status: 503, body: { error: 'a2a_not_wired' } }
      // Body is pre-validated via A2ARemoveRequest schema.
      const { id } = body as A2ARemoveRequestT
      try {
        deps.a2a.registry.remove(id)
        return { status: 200, body: { ok: true } }
      } catch (err) {
        return { status: 200, body: { ok: false, error: errMsg(err) } }
      }
    },

    'POST /v1/a2a/pause': (_q, body) => {
      if (!deps.a2a) return { status: 503, body: { error: 'a2a_not_wired' } }
      // Body is pre-validated via A2APauseRequest schema.
      const { id, paused } = body as A2APauseRequestT
      try {
        deps.a2a.registry.setPaused(id, paused)
        return { status: 200, body: { ok: true } }
      } catch (err) {
        return { status: 200, body: { ok: false, error: errMsg(err) } }
      }
    },

    'GET /v1/a2a/activity': (q) => {
      if (!deps.a2a) return { status: 503, body: { error: 'a2a_not_wired' } }
      const agentId = q.get('agent_id')
      if (!agentId) return { status: 400, body: { error: 'agent_id required' } }
      const limit = Number(q.get('limit') ?? '50')
      return { status: 200, body: { events: deps.a2a.eventsStore.recentForAgent(agentId, limit) } }
    },

    'GET /v1/a2a/info': () => {
      if (!deps.a2a) return { status: 503, body: { error: 'a2a_not_wired' } }
      return {
        status: 200,
        body: {
          enabled: deps.a2a.serverEnabled,
          base_url: deps.a2a.baseUrl ?? null,
        },
      }
    },

    // Live sessions for diagnosis — which (alias, provider, chat) sessions are
    // cached and when each was last used (idle/wedged inference). 503 until
    // bootstrap wires the lister.
    'GET /v1/sessions': () => {
      const sessions = deps.listSessions?.()
      if (sessions == null) return { status: 503, body: { error: 'sessions_not_wired' } }
      return { status: 200, body: { sessions } }
    },

    // Admin remediation — force-release a (possibly wedged) session so the
    // next message in that chat spawns a fresh subprocess. Returns the live
    // session list AFTER the release as a built-in verification read-back.
    'POST /v1/sessions/release': async (_q, body) => {
      if (!deps.releaseSession) return { status: 503, body: { error: 'release_not_wired' } }
      const b = (body ?? {}) as { alias?: unknown; providerId?: unknown; chatId?: unknown }
      if (typeof b.alias !== 'string' || typeof b.providerId !== 'string' || typeof b.chatId !== 'string') {
        return { status: 400, body: { error: 'alias, providerId, chatId required (strings)' } }
      }
      await deps.releaseSession({ alias: b.alias, providerId: b.providerId, chatId: b.chatId })
      return { status: 200, body: { ok: true, sessions: deps.listSessions?.() ?? null } }
    },

    // Current pinned agent model (read-back companion to POST /v1/model).
    'GET /v1/model': () => {
      const cfg = loadAgentConfig(deps.stateDir)
      return { status: 200, body: { provider: cfg.provider, model: cfg.model ?? null } }
    },

    // Admin remediation — switch the pinned model. Takes effect on the next
    // claude session spawn per chat (no restart; see the mtime-cached reader).
    // Returns the persisted model as a verification read-back.
    'POST /v1/model': (_q, body) => {
      const b = (body ?? {}) as { model?: unknown }
      if (typeof b.model !== 'string' || b.model.trim() === '') {
        return { status: 400, body: { error: 'model required (non-empty string)' } }
      }
      const model = b.model.trim()
      // Validate the shape of a real, fully-qualified model id before pinning
      // it — a bare alias or fast-mode tag (e.g. 'opus', 'opus[1m]', 'sonnet')
      // gets mis-resolved by the CLI and 404s EVERY turn (the 2026-05-08
      // incident this model-pinning exists to prevent). Require only the
      // id-charset and a version digit; that rejects aliases without
      // hard-coding a model allowlist that would rot as new models ship.
      if (!/^[A-Za-z0-9._-]+$/.test(model) || !/[0-9]/.test(model)) {
        return {
          status: 400,
          body: { error: `invalid model id '${model}' — use a full versioned id like 'claude-opus-4-8' or 'gpt-5.3-codex', not an alias` },
        }
      }
      const cfg = loadAgentConfig(deps.stateDir)
      saveAgentConfig(deps.stateDir, { ...cfg, model })
      const after = loadAgentConfig(deps.stateDir)
      return { status: 200, body: { ok: true, provider: after.provider, model: after.model ?? null } }
    },

    // Admin remediation — graceful daemon restart. The trigger schedules the
    // shutdown+exit AFTER this response flushes; launchd/systemd respawns.
    'POST /v1/daemon/restart': () => {
      if (!deps.requestRestart) return { status: 503, body: { error: 'restart_not_wired' } }
      deps.requestRestart()
      return { status: 200, body: { ok: true, restarting: true } }
    },

    // Per-turn outcome feed for diagnosis. With chatId → that chat's turns
    // newest-first ("why did chat X stop replying"); without → the daemon's
    // recent turns across all chats. limit defaults to 50, clamped to 500.
    'GET /v1/turns': (q) => {
      if (!deps.turns) return { status: 503, body: { error: 'turns_not_wired' } }
      const chatId = q.get('chatId') ?? undefined
      const rawLimit = Number(q.get('limit') ?? '50')
      const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(1, Math.trunc(rawLimit)), 500) : 50
      const turns = chatId
        ? deps.turns.recentForChat(chatId, limit)
        : deps.turns.recent(limit)
      return { status: 200, body: { turns } }
    },
  }
}

/**
 * RFC 03 review #5 fix: defers the "should this reply be prefixed?"
 * decision to the capability matrix via `lookup().replyPrefix` so
 * internal-api stops switching on mode.kind directly. The matrix is now
 * the single source of truth — adding a new mode or permissionMode
 * requires only a new matrix row, not a code change here.
 *
 * replyPrefix semantics:
 *   'always'           — prefix [DisplayName] (parallel / chatroom)
 *   'never'            — no prefix (solo)
 *   'on-fallback-only' — no prefix at this call site (primary_tool; the
 *                        fallback path in coordinator.ts handles its own label)
 *
 * Unknown provider fallback: if the participant_tag references a provider
 * not yet in the capability matrix (e.g. a future 'gemini' provider before
 * a matrix row is added), the lookup throws. In that case we fall back to
 * the mode's structural semantics: parallel and chatroom always prefix,
 * other modes never do. This preserves correctness while allowing future
 * providers to work before their matrix rows are defined.
 */
export function makeMaybePrefix(deps: InternalApiDeps): (chatId: string, text: string, tag: string | undefined) => string {
  return function maybePrefix(chatId, text, tag) {
    if (!tag || !deps.prefix) return text
    const mode = deps.prefix.conversationStore.get(chatId)?.mode
    if (!mode) return text
    const permissionMode = deps.prefix.permissionMode
    // Look up the capability row for this (mode × provider-tag × permissionMode).
    let replyPrefix: 'always' | 'never' | 'on-fallback-only'
    try {
      replyPrefix = lookup(mode.kind, tag, permissionMode).replyPrefix
    } catch {
      // Unknown provider-tag (not yet in the matrix) — fall back to structural
      // mode semantics: multi-participant modes prefix, single-voice modes don't.
      replyPrefix = (mode.kind === 'parallel' || mode.kind === 'chatroom') ? 'always' : 'never'
    }
    if (replyPrefix !== 'always') return text
    const dn = deps.prefix.providerDisplayName(tag)
    return `[${dn}] ${text}`
  }
}
