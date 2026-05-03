import type { Lifecycle } from '../../lib/lifecycle'
import { createInternalApi, type InternalApiDeps, type InternalApiDelegateDep } from './index'

export interface InternalApiLifecycle extends Lifecycle {
  readonly baseUrl: string
  readonly tokenFilePath: string
  setDelegate(d: InternalApiDelegateDep): void
}

/**
 * Async because HTTP server bind is async; bootstrap needs the actual port
 * before constructing the wechat-mcp stdio MCP spec.
 */
export async function registerInternalApi(deps: InternalApiDeps): Promise<InternalApiLifecycle> {
  const api = createInternalApi(deps)
  const { port, tokenFilePath } = await api.start()
  return {
    name: 'internal-api',
    baseUrl: `http://127.0.0.1:${port}`,
    tokenFilePath,
    setDelegate: (d) => api.setDelegate(d),
    stop: () => api.stop(),
  }
}
