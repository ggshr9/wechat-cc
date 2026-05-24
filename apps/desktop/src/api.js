// @ts-check
/// <reference lib="dom" />
/**
 * Thin helper for the dashboard modules that need to call the running
 * daemon's internal HTTP API (/v1/...).
 *
 * Bootstrap: calls `wechat-cc daemon api-info --json` (via Tauri IPC /
 * shim) once to get the bound port + bearer token, then reuses those for
 * all subsequent fetch() calls.  The cache is intentionally session-scoped
 * (page lifetime): a daemon restart rotates the token, but the operator
 * will typically reload the dashboard by then anyway.
 *
 * The single exported function is:
 *   invokeApi(method, path, body?) → Promise<unknown>
 *
 * Throws on HTTP ≥400 or network error; callers can catch and alert.
 */

import { invoke as ipcInvoke } from './ipc.js'

/** @type {{ baseUrl: string; token: string } | null} */
let _cache = null

/** @type {Promise<{ baseUrl: string; token: string }> | null} */
let _inflight = null

async function getApiCredentials() {
  if (_cache) return _cache
  if (_inflight) return _inflight
  _inflight = (async () => {
    const r = /** @type {{ ok?: boolean; baseUrl?: string; token?: string; error?: string }} */ (
      await ipcInvoke('wechat_cli_json', { args: ['daemon', 'api-info', '--json'] }, undefined)
    )
    if (!r || !r.ok || !r.baseUrl || !r.token) {
      throw new Error(r?.error ?? 'daemon api-info returned no credentials')
    }
    _cache = { baseUrl: r.baseUrl, token: r.token }
    return _cache
  })()
  try {
    return await _inflight
  } finally {
    _inflight = null
  }
}

/**
 * Call a daemon internal-api endpoint.
 * @param {'GET' | 'POST'} method
 * @param {string} path  e.g. '/v1/a2a/list' or '/v1/a2a/activity?agent_id=x&limit=50'
 * @param {Record<string, unknown>} [body]
 * @returns {Promise<unknown>}
 */
export async function invokeApi(method, path, body) {
  const { baseUrl, token } = await getApiCredentials()
  const url = baseUrl + path
  /** @type {RequestInit} */
  const init = {
    method,
    headers: {
      'authorization': `Bearer ${token}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }
  const resp = await fetch(url, init)
  if (!resp.ok) {
    let errText = `HTTP ${resp.status}`
    try { const j = await resp.json(); errText = j?.error ?? errText } catch { /* ignore */ }
    throw new Error(errText)
  }
  return resp.json()
}

/** Invalidate the cached credentials (e.g. after a daemon restart). */
export function resetApiCredentials() {
  _cache = null
}
