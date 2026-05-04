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
import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import {
  errMsg,
  type InternalApi,
  type InternalApiDeps,
  type InternalApiDelegateDep,
} from './types'
import { makeMaybePrefix, makeRoutes } from './routes'

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
  let server: Server | null = null
  let boundPort: number | null = null
  let token: Buffer | null = null
  // RFC 03 P4 late binding — main.ts wires this in after bootstrap returns.
  let lateDelegate: InternalApiDelegateDep | null = deps.delegate ?? null
  // Late binding for conversation controller — wired after buildBootstrap() returns.
  // Routes access deps.conversation at request time; we update the same deps object.
  // (deps is passed by reference to makeRoutes which closes over it, so mutations
  // are visible at request time without any additional indirection.)

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
    if (!authOk(req)) {
      deps.log?.('INTERNAL_API', `401 ${req.method} ${req.url}`, {
        event: 'auth_rejected',
        method: req.method,
        url: req.url,
      })
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
      deps.log?.('INTERNAL_API', `500 ${method} ${rawUrl}: ${errMsg(err)}`, {
        event: 'route_threw',
        method,
        url: rawUrl,
        error: errMsg(err),
      })
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

    setConversation(c) {
      deps.conversation = c
    },
  }
}
