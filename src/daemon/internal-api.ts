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

export interface InternalApiDeps {
  /** State directory; the token file is written under here. */
  stateDir: string
  /** Daemon process pid — exposed by /v1/health for smoke tests. */
  daemonPid: number
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

  function handleRequest(req: IncomingMessage, res: ServerResponse): void {
    if (!authOk(req)) {
      deps.log?.('INTERNAL_API', `401 ${req.method} ${req.url}`)
      return send(res, 401, { error: 'unauthorized' })
    }

    const method = req.method ?? 'GET'
    const url = req.url ?? '/'

    if (method === 'GET' && url === '/v1/health') {
      return send(res, 200, { ok: true, daemon_pid: deps.daemonPid })
    }

    return send(res, 404, { error: 'not_found', method, url })
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
