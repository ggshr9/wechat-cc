/**
 * internal-api — localhost HTTP entry that the standalone wechat-mcp
 * stdio MCP server (RFC 03 §5) calls back into for tool implementations
 * (reply, memory, voice, projects, ...). Without this, the stdio MCP
 * subprocess would have no way to reach the daemon's ilink connection,
 * memory directory, etc.
 *
 * Trust model:
 *   - Binds 127.0.0.1 only (never reachable off-host)
 *   - Random port (binds to :0, captures actual port post-listen)
 *   - 32-byte random bearer token written to <stateDir>/internal-token
 *     mode 0600. MCP children read it and present in Authorization header.
 *   - Constant-time compare via crypto.timingSafeEqual
 *
 * Token rotation: a fresh token is generated on every daemon start. If
 * a stale MCP child has an old token, it gets 401 — handled by the
 * client by re-reading the token file. (Daemon overwrites in place.)
 *
 * P1.A scope: just /v1/health for stdio integration smoke test.
 * P1.B scope: full tool surface (POST /v1/reply, /v1/memory/*, etc.)
 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import type { MemoryFS } from './memory/fs-api'
import type { WechatProjectsDep, WechatVoiceDep, WechatCompanionDep } from './wechat-tool-deps'
import type { ConversationStore } from '../core/conversation-store'
import type { ProviderId } from '../core/conversation'
import { modeRequiresParticipantPrefix } from '../core/conversation'

/**
 * RFC 03 P3: when conversation mode is parallel (or chatroom), the
 * `reply` route prefixes outgoing text with `[Display]` so the user
 * can tell which agent said what. The wechat-mcp child sends its own
 * provider id as `participant_tag` in the request body; the route looks
 * up the chat's persisted mode + the registered provider's display
 * name and decides whether to prefix.
 */
export interface InternalApiPrefixDeps {
  conversationStore: Pick<ConversationStore, 'get'>
  /** Resolves a provider id (the participant_tag) to the human-readable name. */
  providerDisplayName: (id: ProviderId) => string
}

/**
 * RFC 03 P4 — primary+tool mode. The `delegate-mcp` child posts here
 * when its `delegate_<peer>` tool fires. The handler runs the prompt
 * against a BARE-BONES peer SDK (no mcpServers) so the peer can't
 * recurse — recursion prevention is structural, not counter-based.
 *
 * The dispatch function may be set late via `setDelegate()` because
 * provider construction belongs to bootstrap which runs after
 * createInternalApi. Until set, the route returns 503.
 */
export interface InternalApiDelegateDep {
  /**
   * Run a one-shot consultation against `peer` and return the assistant
   * text. The implementation owns provider construction + thread
   * spawn + close. ok=false should surface a user-readable reason.
   *
   * `cwd` (RFC 03 review #10): when present, peer is spawned with this
   * working directory so it can Read/Bash project files. Otherwise the
   * peer runs in a daemon-default scratch dir with no project access.
   */
  dispatchOneShot(peer: ProviderId, prompt: string, cwd?: string): Promise<
    | { ok: true; response: string; num_turns?: number; duration_ms?: number }
    | { ok: false; reason: string }
  >
  /** List of accepted peer ids — for 400 validation. */
  knownPeers(): ProviderId[]
}

/**
 * Ilink-bound message-sending deps (RFC 03 P1.B B1). These call out to
 * the WeChat client over ilink — the riskiest slice with real side
 * effects. main.ts wires them as closures over `ilink.sendMessage` etc.
 */
export interface InternalApiIlinkDep {
  /** Reply text to a chat. Returns ilink's raw shape (msgId or error) — the route handler reshapes for the agent. */
  sendReply(chatId: string, text: string): Promise<{ msgId: string; error?: string }>
  /** Push a local file (absolute path) to a chat. */
  sendFile(chatId: string, path: string): Promise<void>
  /** Edit a previously-sent message. */
  editMessage(chatId: string, msgId: string, text: string): Promise<void>
  /** Broadcast text to all online users; returns success/failure counts. */
  broadcast(text: string, accountId?: string): Promise<{ ok: number; failed: number }>
}

export interface InternalApiDeps {
  /** State directory; the token file is written under here. */
  stateDir: string
  /** Daemon process pid — exposed by /v1/health for smoke tests. */
  daemonPid: number
  /**
   * Sandbox FS for memory_read / memory_write / memory_list (RFC 03 P1.B
   * B2). The same MemoryFS instance is shared with the legacy in-process
   * MCP server until B7 deletes it; both paths see the same files.
   */
  memory?: MemoryFS
  /** Project registry (RFC 03 P1.B B3). */
  projects?: WechatProjectsDep
  /** Persist a wechat user's display name (RFC 03 P1.B B3). */
  setUserName?: (chatId: string, name: string) => Promise<void>
  /** TTS config + status + replyVoice (RFC 03 P1.B B4 + B1). */
  voice?: WechatVoiceDep
  /**
   * Publish a Markdown page to a one-time URL (RFC 03 P1.B B5).
   */
  sharePage?: (
    title: string,
    content: string,
    opts?: { needs_approval?: boolean; chat_id?: string; account_id?: string },
  ) => Promise<{ url: string; slug: string }>
  /**
   * Re-issue a URL for an existing page (RFC 03 P1.B B5).
   */
  resurfacePage?: (
    q: { slug?: string; title_fragment?: string },
  ) => Promise<{ url: string; slug: string } | null>
  /** Companion proactive-tick controls (RFC 03 P1.B B6). */
  companion?: WechatCompanionDep
  /**
   * Ilink message-sending family (RFC 03 P1.B B1). When wired, the
   * /v1/wechat/{reply,send_file,edit_message,broadcast} routes are
   * served. `voice.replyVoice` covers `reply_voice` separately.
   */
  ilink?: InternalApiIlinkDep
  /**
   * Optional mode-aware reply prefixing (RFC 03 P3). When wired, the
   * `reply` route consults `conversationStore` for the chat's mode and
   * prefixes `[Display]` in parallel + chatroom modes. Without this,
   * tags supplied by clients are silently ignored (legacy solo behaviour).
   */
  prefix?: InternalApiPrefixDeps
  /**
   * Optional delegate dispatch (RFC 03 P4). Late-binding via
   * `InternalApi.setDelegate()` because the bare delegate providers
   * are constructed inside bootstrap, which runs after createInternalApi.
   */
  delegate?: InternalApiDelegateDep
  /** Optional log hook so api activity surfaces in channel.log. */
  log?: (tag: string, line: string) => void
}

export interface InternalApi {
  /** Start listening on 127.0.0.1:0; resolves once bound. */
  start(): Promise<{ port: number; tokenFilePath: string }>
  /** Stop the HTTP server and (optionally) clean up the token file. */
  stop(opts?: { unlinkToken?: boolean }): Promise<void>
  /** Bound port. Throws if accessed before start() resolves. */
  port(): number
  /** Filesystem path of the token file. */
  tokenFilePath(): string
  /**
   * RFC 03 P4 — late-bind the delegate dispatcher after bootstrap has
   * constructed the bare delegate providers. /v1/delegate route returns
   * 503 until this is called.
   */
  setDelegate(d: InternalApiDelegateDep): void
}

const TOKEN_FILE = 'internal-token'

export function createInternalApi(deps: InternalApiDeps): InternalApi {
  const tokenPath = join(deps.stateDir, TOKEN_FILE)
  let server: Server | null = null
  let boundPort: number | null = null
  let token: Buffer | null = null
  // RFC 03 P4 late binding — main.ts wires this in after bootstrap returns.
  let lateDelegate: InternalApiDelegateDep | null = deps.delegate ?? null

  function authOk(req: IncomingMessage): boolean {
    if (!token) return false
    const header = req.headers.authorization ?? ''
    const m = /^Bearer\s+([0-9a-f]+)$/i.exec(header)
    if (!m) return false
    let provided: Buffer
    try {
      provided = Buffer.from(m[1]!, 'hex')
    } catch {
      return false
    }
    if (provided.length !== token.length) return false
    return timingSafeEqual(provided, token)
  }

  function send(res: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body)
    res.statusCode = status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('content-length', Buffer.byteLength(payload).toString())
    res.end(payload)
  }

  /**
   * Each route handler receives the parsed query (always present) and the
   * parsed JSON body (POST only; null on GET). Returns { status, body } —
   * no streaming, no manual res manipulation. New endpoints in P1.B add a
   * row to ROUTES below.
   */
  type RouteHandler = (
    query: URLSearchParams,
    body: unknown,
  ) => Promise<{ status: number; body: unknown }> | { status: number; body: unknown }

  const ROUTES: Record<string, RouteHandler | undefined> = {
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
      const d = lateDelegate
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
        deps.log?.('DELEGATE', `nested-call rejected: peer=${b.peer} depth=${depth}`)
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
        if (r.ok) {
          deps.log?.('DELEGATE', `peer=${b.peer} ok response_chars=${r.response.length} ms=${Date.now() - started}`)
        } else {
          deps.log?.('DELEGATE', `peer=${b.peer} fail reason=${r.reason}`)
        }
        return { status: 200, body: r }
      } catch (err) {
        deps.log?.('DELEGATE', `peer=${b.peer} threw: ${errMsg(err)}`)
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

  async function readJsonBody(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c as string))
    const text = Buffer.concat(chunks).toString('utf8')
    if (!text) return null
    return JSON.parse(text)
  }

  function errMsg(err: unknown): string {
    return err instanceof Error ? err.message : String(err)
  }

  /**
   * Prefix `[Display]` to outgoing reply text when the chat's mode
   * requires participant disambiguation. Returns the text unchanged
   * otherwise (solo / primary_tool / unknown chat / no prefix deps wired).
   *
   * RFC 03 review #5 fix: defers the "is this a multi-participant mode?"
   * decision to `modeRequiresParticipantPrefix` in src/core/conversation.ts
   * so internal-api stops switching on mode.kind directly. Adding a new
   * multi-participant mode requires updating exactly that one helper.
   */
  function maybePrefix(chatId: string, text: string, tag: string | undefined): string {
    if (!tag || !deps.prefix) return text
    const mode = deps.prefix.conversationStore.get(chatId)?.mode
    if (!mode) return text
    if (!modeRequiresParticipantPrefix(mode)) return text
    const dn = deps.prefix.providerDisplayName(tag)
    return `[${dn}] ${text}`
  }

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!authOk(req)) {
      deps.log?.('INTERNAL_API', `401 ${req.method} ${req.url}`)
      return send(res, 401, { error: 'unauthorized' })
    }

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

    try {
      const out = await route(url.searchParams, body)
      send(res, out.status, out.body)
    } catch (err) {
      deps.log?.('INTERNAL_API', `500 ${method} ${rawUrl}: ${errMsg(err)}`)
      send(res, 500, { error: 'internal', detail: errMsg(err) })
    }
  }

  return {
    async start() {
      if (server) throw new Error('internal-api already started')

      mkdirSync(dirname(tokenPath), { recursive: true, mode: 0o700 })
      const tokenHex = randomBytes(32).toString('hex')
      token = Buffer.from(tokenHex, 'hex')
      // Write atomically — token consumers may already be reading on rotate.
      const tmp = `${tokenPath}.tmp-${process.pid}-${Date.now()}`
      writeFileSync(tmp, tokenHex + '\n', { mode: 0o600 })
      // Use rename for atomic swap. node:fs renameSync is fine on linux/mac.
      const { renameSync } = await import('node:fs')
      renameSync(tmp, tokenPath)

      server = createServer(handleRequest)
      // Catch listener errors so we surface bind failures to start()'s caller.
      const listenError = new Promise<never>((_, reject) => {
        server!.once('error', reject)
      })
      const listen = new Promise<void>(resolve => {
        server!.listen({ host: '127.0.0.1', port: 0 }, () => resolve())
      })
      await Promise.race([listen, listenError])

      const addr = server.address() as AddressInfo | null
      if (!addr || typeof addr === 'string') {
        throw new Error('internal-api failed to bind: no address info')
      }
      boundPort = addr.port
      deps.log?.('INTERNAL_API', `listening on 127.0.0.1:${boundPort}`)

      return { port: boundPort, tokenFilePath: tokenPath }
    },

    async stop(opts) {
      if (!server) return
      await new Promise<void>((resolve, reject) => {
        server!.close((err) => err ? reject(err) : resolve())
      })
      server = null
      boundPort = null
      token = null
      if (opts?.unlinkToken) {
        const { unlinkSync, existsSync } = await import('node:fs')
        if (existsSync(tokenPath)) unlinkSync(tokenPath)
      }
      deps.log?.('INTERNAL_API', 'stopped')
    },

    port() {
      if (boundPort === null) throw new Error('internal-api not started yet')
      return boundPort
    },

    tokenFilePath() {
      return tokenPath
    },

    setDelegate(d) {
      lateDelegate = d
    },
  }
}
