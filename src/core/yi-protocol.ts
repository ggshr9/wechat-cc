/**
 * 乙 v2 wire messages — JSON-RPC 2.0 over a WebSocket text frame (one message
 * per frame). Phase 1 methods:
 *   - request  `initialize`     params { handId, clientName, capabilities, authToken }
 *   - response (to initialize)  result { sessionId }
 *   - notification `initialized` (no params)
 *   - request  `task/dispatch`  params { taskId, peer, prompt, cwd? }
 *   - response (to task/dispatch) result { taskId, ok, response? , reason? }
 * Pure: build + parse only. No I/O.
 */
export type YiParsed =
  | { kind: 'request'; id: number; method: string; params: unknown }
  | { kind: 'response'; id: number; result: unknown }
  | { kind: 'error'; id: number | null; error: { code: number; message: string } }
  | { kind: 'notification'; method: string; params: unknown }
  | { kind: 'malformed' }

export function buildRequest(id: number, method: string, params: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method, params })
}
export function buildResponse(id: number, result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result })
}
export function buildError(id: number | null, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })
}
export function buildNotification(method: string, params?: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) })
}

export function parseMessage(raw: string | Buffer): YiParsed {
  let m: Record<string, unknown>
  try { m = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8')) as Record<string, unknown> }
  catch { return { kind: 'malformed' } }
  if (!m || m.jsonrpc !== '2.0') return { kind: 'malformed' }
  if ('error' in m && m.error && typeof m.error === 'object') {
    const e = m.error as { code?: unknown; message?: unknown }
    return { kind: 'error', id: typeof m.id === 'number' ? m.id : null, error: { code: Number(e.code ?? -1), message: String(e.message ?? '') } }
  }
  if ('result' in m && typeof m.id === 'number') return { kind: 'response', id: m.id, result: m.result }
  if (typeof m.method === 'string' && typeof m.id === 'number') return { kind: 'request', id: m.id, method: m.method, params: m.params }
  if (typeof m.method === 'string') return { kind: 'notification', method: m.method, params: m.params }
  return { kind: 'malformed' }
}
