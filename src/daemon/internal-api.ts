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
