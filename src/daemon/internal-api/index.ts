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
 * This file owns the server lifecycle and the auth/body/dispatch
 * middleware. Route handler implementations live in ./routes.ts; deps
 * + interface types live in ./types.ts. The split is purely organisational
 * — no behaviour change vs the pre-split monolithic internal-api.ts.
 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { randomBytes } from 'node:crypto'
import { makeTokenRegistry, type TokenInfo } from './token-registry'
import { minTierFor, tierMeets } from './route-tiers'
import type { UserTier } from '../../core/user-tier'
import type { AddressInfo } from 'node:net'
import {
  errMsg,
  type InternalApi,
  type InternalApiDeps,
  type InternalApiDelegateDep,
} from './types'
import { makeMaybePrefix, makeRoutes } from './routes'
import { REQUEST_SCHEMAS } from './schema'

export type {
  InternalApi,
  InternalApiDeps,
  InternalApiDelegateDep,
  InternalApiIlinkDep,
  InternalApiPrefixDeps,
} from './types'

const TOKEN_FILE = 'internal-token'

export function createInternalApi(deps: InternalApiDeps): InternalApi {
  const tokenPath = join(deps.stateDir, TOKEN_FILE)
  const registry = makeTokenRegistry()
  let server: Server | null = null
  let boundPort: number | null = null
  let token: Buffer | null = null
  // RFC 03 P4 late binding — main.ts wires this in after bootstrap returns.
  let lateDelegate: InternalApiDelegateDep | null = deps.delegate ?? null
  // Late binding for conversation controller — wired after buildBootstrap() returns.
  // Routes access deps.conversation at request time; we update the same deps object.
  // (deps is passed by reference to makeRoutes which closes over it, so mutations
  // are visible at request time without any additional indirection.)

  // Resolve the presented bearer to its { tier, origin } via the registry, or
  // null when unknown. Replaces the old single-token authOk so the route layer
  // can enforce the caller's tier (see token-registry.ts / route-tiers.ts).
  function authResolve(req: IncomingMessage): TokenInfo | null {
    const m = /^Bearer\s+([0-9a-f]+)$/i.exec(req.headers.authorization ?? '')
    if (!m) return null
    return registry.resolve(m[1]!.toLowerCase())
  }

  function send(res: ServerResponse, status: number, body: unknown, origin?: string): void {
    const payload = JSON.stringify(body)
    res.statusCode = status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('content-length', Buffer.byteLength(payload).toString())
    // CORS: echo the request Origin so the dashboard webview (Tauri's
    // `tauri://localhost` / `http://tauri.localhost`, or the dev shim's
    // `http://127.0.0.1:4174`) can read the response. The server only
    // listens on 127.0.0.1, so any caller already passed the trust
    // boundary — echoing is safe and avoids hard-coding origins per
    // platform / dev mode.
    if (origin) res.setHeader('Access-Control-Allow-Origin', origin)
    res.end(payload)
  }

  const maybePrefix = makeMaybePrefix(deps)
  const ROUTES = makeRoutes({
    deps,
    getDelegate: () => lateDelegate,
    maybePrefix,
  })

  async function readJsonBody(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c as string))
    const text = Buffer.concat(chunks).toString('utf8')
    if (!text) return null
    return JSON.parse(text)
  }

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const origin = (req.headers.origin && typeof req.headers.origin === 'string') ? req.headers.origin : undefined

    // CORS preflight — browsers strip auth + custom headers off OPTIONS,
    // so it MUST NOT go through authOk. Replying 204 with the standard
    // Access-Control-* headers lets the actual GET/POST proceed with the
    // Authorization header attached. Without this, the dashboard's A2A
    // tab and any other webview fetch silently fails: preflight 401 →
    // browser blocks the real request, no error visible to the user
    // beyond a stale "loading…" or a "未启动?" banner.
    if (req.method === 'OPTIONS') {
      res.statusCode = 204
      if (origin) res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type')
      res.setHeader('Access-Control-Max-Age', '600')  // cache preflight 10 min
      res.end()
      return
    }

    const caller = authResolve(req)
    if (!caller) {
      deps.log?.('INTERNAL_API', `401 ${req.method} ${req.url}`, {
        event: 'auth_rejected',
        method: req.method,
        url: req.url,
      })
      return send(res, 401, { error: 'unauthorized' }, origin)
    }

    const method = req.method ?? 'GET'
    const rawUrl = req.url ?? '/'
    const url = new URL(rawUrl, 'http://internal')
    const routeKey = `${method} ${url.pathname}`
    const route = ROUTES[routeKey]

    if (!route) {
      return send(res, 404, { error: 'not_found', method, url: rawUrl }, origin)
    }

    // Tier gate: the caller's tier (from its token) must meet the route's
    // declared minimum. Unlisted routes default to admin (fail-closed).
    const need = minTierFor(routeKey)
    if (!tierMeets(caller.tier, need)) {
      deps.log?.('INTERNAL_API', `403 ${routeKey} caller=${caller.tier} need=${need}`, {
        event: 'tier_denied', path: routeKey, caller: caller.tier, required: need,
      })
      return send(res, 403, { error: 'forbidden', required: need }, origin)
    }

    let body: unknown = null
    if (method === 'POST') {
      try {
        body = await readJsonBody(req)
      } catch (err) {
        return send(res, 400, { error: 'malformed_json', detail: errMsg(err) }, origin)
      }
    }

    const key = routeKey
    const reqSchema = REQUEST_SCHEMAS[key]
    if (reqSchema) {
      const input = method === 'POST'
        ? body
        : Object.fromEntries(url.searchParams.entries())
      const parsed = reqSchema.safeParse(input)
      if (!parsed.success) {
        deps.log?.('INTERNAL_API', `400 ${key} schema mismatch`, {
          path: key,
          issues: parsed.error.issues,
        })
        return send(res, 400, { error: 'invalid_request', detail: parsed.error.flatten() }, origin)
      }
      if (method === 'POST') body = parsed.data
      // GET: handler still reads from url.searchParams (legacy contract);
      // schema validation just gatekeeps.
    }

    try {
      const out = await route(url.searchParams, body)
      send(res, out.status, out.body, origin)
    } catch (err) {
      deps.log?.('INTERNAL_API', `500 ${method} ${rawUrl}: ${errMsg(err)}`, {
        event: 'route_threw',
        method,
        url: rawUrl,
        error: errMsg(err),
      })
      send(res, 500, { error: 'internal', detail: errMsg(err) }, origin)
    }
  }

  return {
    async start() {
      if (server) throw new Error('internal-api already started')

      mkdirSync(dirname(tokenPath), { recursive: true, mode: 0o700 })
      const tokenHex = randomBytes(32).toString('hex')
      token = Buffer.from(tokenHex, 'hex')
      // Register the daemon-wide file token as `trusted` — it's shell-readable,
      // so it can't grant more than the least-trusted process that reads it.
      registry.registerFileToken(tokenHex)
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

    setConversation(c) {
      deps.conversation = c
    },

    setA2A(a2a) {
      deps.a2a = a2a
    },
    mintSessionToken(tier: UserTier, sessionKey: string) {
      return registry.mint(tier, sessionKey)
    },
    invalidateSession(sessionKey: string) {
      registry.invalidateSession(sessionKey)
    },
  }
}
