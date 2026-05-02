/**
 * Internal-api client used by the standalone wechat-mcp stdio server
 * (RFC 03 §5). This module is loaded *inside* the MCP subprocess; it
 * speaks HTTP over loopback to the daemon's internal-api.
 *
 * Configuration is via env vars passed in the stdio MCP spec
 * (bootstrap.ts wires them when registering the server with each
 * provider):
 *   WECHAT_INTERNAL_API        e.g. http://127.0.0.1:54321
 *   WECHAT_INTERNAL_TOKEN_FILE e.g. /home/user/.../internal-token
 *
 * The token is read lazily on first request (and re-read if the daemon
 * rotated it across restarts — re-read on 401 to recover seamlessly).
 *
 * No external HTTP library — uses node 18+ global fetch.
 */
import { readFileSync } from 'node:fs'

export interface InternalApiClientOptions {
  /** Base URL, e.g. http://127.0.0.1:54321 — no trailing slash. */
  baseUrl: string
  /** Path to the token file (mode 0600, written by daemon). */
  tokenFilePath: string
  /** Test injection: replace global fetch. Production omits this. */
  fetchImpl?: typeof fetch
  /** Optional logging hook (writes to stderr — stdout is the MCP transport). */
  logger?: (line: string) => void
}

export interface InternalApiClient {
  request<T = unknown>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T>
}

export class InternalApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly path: string,
    public readonly body: unknown,
  ) {
    super(message)
    this.name = 'InternalApiError'
  }
}

export function createInternalApiClient(opts: InternalApiClientOptions): InternalApiClient {
  const baseUrl = opts.baseUrl.replace(/\/+$/, '')
  const fetchFn = opts.fetchImpl ?? fetch
  let cachedToken: string | null = null

  function readToken(): string {
    const t = readFileSync(opts.tokenFilePath, 'utf8').trim()
    cachedToken = t
    return t
  }

  async function tryRequest(method: 'GET' | 'POST', path: string, body: unknown, token: string): Promise<Response> {
    const init: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
      },
      ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
    }
    return fetchFn(`${baseUrl}${path}`, init)
  }

  return {
    async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
      let token = cachedToken ?? readToken()
      let resp = await tryRequest(method, path, body, token)
      // Rotation recovery: token file may have been rewritten between
      // cache and request. Re-read once and retry.
      if (resp.status === 401 && cachedToken !== null) {
        opts.logger?.(`[wechat-mcp client] 401 from ${path}; re-reading token`)
        token = readToken()
        resp = await tryRequest(method, path, body, token)
      }
      const respBody: unknown = resp.headers.get('content-type')?.includes('application/json')
        ? await resp.json()
        : await resp.text()
      if (!resp.ok) {
        throw new InternalApiError(
          `internal-api ${method} ${path} → ${resp.status}`,
          resp.status,
          path,
          respBody,
        )
      }
      return respBody as T
    },
  }
}
