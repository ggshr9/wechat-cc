import { writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { Lifecycle } from '../../lib/lifecycle'
import { createInternalApi, type InternalApiDeps, type InternalApiDelegateDep } from './index'

export interface InternalApiLifecycle extends Lifecycle {
  readonly baseUrl: string
  readonly tokenFilePath: string
  setDelegate(d: InternalApiDelegateDep): void
  setConversation(c: NonNullable<InternalApiDeps['conversation']>): void
}

/**
 * Async because HTTP server bind is async; bootstrap needs the actual port
 * before constructing the wechat-mcp stdio MCP spec.
 */
export async function registerInternalApi(deps: InternalApiDeps): Promise<InternalApiLifecycle> {
  const api = createInternalApi(deps)
  const { port, tokenFilePath } = await api.start()
  const infoPath = join(deps.stateDir, 'internal-api-info.json')
  // Write discovery file so CLI (`wechat-cc mode set`) can find the running
  // daemon's baseUrl + token without hardcoding a port. Mode 0o600: token
  // path is sensitive (any holder can POST set-mode / broadcast / etc.).
  try {
    writeFileSync(
      infoPath,
      JSON.stringify({ baseUrl: `http://127.0.0.1:${port}`, tokenFilePath, pid: process.pid, ts: Date.now() }, null, 2),
      { mode: 0o600 },
    )
  } catch { /* non-fatal: CLI will just error clearly if it can't find the file */ }
  return {
    name: 'internal-api',
    baseUrl: `http://127.0.0.1:${port}`,
    tokenFilePath,
    setDelegate: (d) => api.setDelegate(d),
    setConversation: (c) => api.setConversation(c),
    stop: async () => {
      // Remove the discovery file on clean stop so stale info doesn't
      // mislead a subsequent CLI invocation after the daemon exits.
      try { unlinkSync(infoPath) } catch { /* best-effort */ }
      return api.stop()
    },
  }
}
