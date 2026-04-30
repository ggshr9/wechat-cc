/**
 * Network probes for the guard feature.
 *
 *   fetchPublicIp() — ipify (no auth, returns plain IPv4 string). Cheap
 *     enough to poll every 30s; doesn't touch any rate-limited service.
 *   probeReachable() — HEAD against the canary URL. Returns true iff a
 *     response came back inside the timeout. Probe target is google's
 *     /generate_204 endpoint by default — purpose-built for connectivity
 *     checks, no payload, no logging risk.
 *
 * Both calls swallow errors and return a falsy result instead of
 * throwing — the caller's state machine is "down ↔ up", not "OK ↔
 * exception". Errors are surfaced via `error` field on the result.
 */

export interface PublicIpResult {
  ip: string | null
  error?: string
}

export interface ReachableResult {
  reachable: boolean
  ms: number | null
  error?: string
}

const DEFAULT_TIMEOUT_MS = 3000

export async function fetchPublicIp(opts: { timeoutMs?: number; url?: string } = {}): Promise<PublicIpResult> {
  const url = opts.url ?? 'https://api.ipify.org'
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  try {
    const r = await fetch(url, { signal: ctrl.signal })
    if (!r.ok) return { ip: null, error: `http ${r.status}` }
    const text = (await r.text()).trim()
    if (!/^[\d.:a-f]+$/i.test(text)) return { ip: null, error: `bad shape: ${text.slice(0, 40)}` }
    return { ip: text }
  } catch (err) {
    return { ip: null, error: err instanceof Error ? err.message : String(err) }
  } finally {
    clearTimeout(timer)
  }
}

export async function probeReachable(url: string, opts: { timeoutMs?: number } = {}): Promise<ReachableResult> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const start = Date.now()
  try {
    // HEAD against /generate_204 returns 204 fast with zero body. Some
    // CDNs reject HEAD; tolerate any 2xx/3xx as "reachable" — we only
    // care whether the connection completed at all.
    const r = await fetch(url, { method: 'HEAD', signal: ctrl.signal, redirect: 'manual' })
    return { reachable: r.status < 500, ms: Date.now() - start }
  } catch (err) {
    return { reachable: false, ms: null, error: err instanceof Error ? err.message : String(err) }
  } finally {
    clearTimeout(timer)
  }
}
