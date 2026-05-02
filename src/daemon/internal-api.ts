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

/**
 * Project registry deps (RFC 03 P1.B B3). Shape matches features/tools.ts
 * `ToolDeps['projects']`; ilink-glue.ts already exposes the same object so
 * main.ts wires the same closure into both internal-api and the legacy
 * in-process MCP. B7 removes the legacy path.
 */
export interface InternalApiProjectsDep {
  list(): { alias: string; path: string; current: boolean }[]
  switchTo(alias: string): Promise<{ ok: true; path: string } | { ok: false; reason: string }>
  add(alias: string, path: string): Promise<void>
  remove(alias: string): Promise<void>
}

/**
 * Companion proactive-tick deps (RFC 03 P1.B B6). Mirrors features/tools.ts
 * `ToolDeps['companion']`.
 */
export interface InternalApiCompanionDep {
  enable(): Promise<
    | { ok: true; state_dir: string; welcome_message: string; cost_estimate_note: string }
    | { ok: true; already_configured: true }
  >
  disable(): Promise<{ ok: true; enabled: false }>
  status(): {
    enabled: boolean
    timezone: string
    default_chat_id: string | null
    snooze_until: string | null
  }
  snooze(minutes: number): Promise<{ ok: true; until: string }>
}

/**
 * TTS config deps (RFC 03 P1.B B4). Subset of features/tools.ts
 * `ToolDeps['voice']` — only the two config-shaped methods used by
 * `voice_config_status` and `save_voice_config`. `replyVoice` (used by
 * the `reply_voice` tool) lives in B1 since it crosses the ilink boundary.
 */
export interface InternalApiVoiceDep {
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
  projects?: InternalApiProjectsDep
  /** Persist a wechat user's display name (RFC 03 P1.B B3). */
  setUserName?: (chatId: string, name: string) => Promise<void>
  /** TTS config + status (RFC 03 P1.B B4). */
  voice?: InternalApiVoiceDep
  /**
   * Publish a Markdown page to a one-time URL (RFC 03 P1.B B5).
   * Shape matches features/tools.ts ToolDeps.sharePage.
   */
  sharePage?: (
    title: string,
    content: string,
    opts?: { needs_approval?: boolean; chat_id?: string; account_id?: string },
  ) => Promise<{ url: string; slug: string }>
  /**
   * Re-issue a URL for an existing page (RFC 03 P1.B B5).
   * Shape matches features/tools.ts ToolDeps.resurfacePage.
   */
  resurfacePage?: (
    q: { slug?: string; title_fragment?: string },
  ) => Promise<{ url: string; slug: string } | null>
  /** Companion proactive-tick controls (RFC 03 P1.B B6). */
  companion?: InternalApiCompanionDep
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
}

const TOKEN_FILE = 'internal-token'

export function createInternalApi(deps: InternalApiDeps): InternalApi {
  const tokenPath = join(deps.stateDir, TOKEN_FILE)
  let server: Server | null = null
  let boundPort: number | null = null
  let token: Buffer | null = null

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
  }
}
