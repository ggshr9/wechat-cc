/**
 * internal-api types — extracted from the monolithic internal-api.ts split
 * into index/routes/types so the route table is no longer interleaved with
 * server lifecycle and middleware.
 *
 * See ./index.ts for createInternalApi (lifecycle, auth, dispatch loop) and
 * ./routes.ts for the route handler implementations.
 */
import type { MemoryFS } from '../memory/fs-api'
import type { WechatProjectsDep, WechatVoiceDep, WechatCompanionDep } from '../wechat-tool-deps'
import type { ConversationStore } from '../../core/conversation-store'
import type { ProviderId } from '../../core/conversation'

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

/**
 * Each route handler receives the parsed query (always present) and the
 * parsed JSON body (POST only; null on GET). Returns { status, body } —
 * no streaming, no manual res manipulation.
 */
export type RouteHandler = (
  query: URLSearchParams,
  body: unknown,
) => Promise<{ status: number; body: unknown }> | { status: number; body: unknown }

export type RouteTable = Record<string, RouteHandler | undefined>

export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
