/**
 * Guard config — persisted toggle + probe URL. Runtime state (current
 * IP, last reachable result, last probe timestamp) is kept in-memory by
 * the scheduler — no point persisting it; daemon restart re-probes.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface GuardConfig {
  enabled: boolean
  probe_url: string
  ipify_url: string
}

export function defaultGuardConfig(): GuardConfig {
  return {
    enabled: false,
    // Google's /generate_204 — designed for captive-portal/connectivity
    // checks, returns 204 with empty body. No CDN dance, no auth, no logs.
    probe_url: 'https://www.google.com/generate_204',
    ipify_url: 'https://api.ipify.org',
  }
}

function configPath(stateDir: string): string {
  return join(stateDir, 'guard.json')
}

export function loadGuardConfig(stateDir: string): GuardConfig {
  const p = configPath(stateDir)
  if (!existsSync(p)) return defaultGuardConfig()
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8')) as Partial<GuardConfig>
    const d = defaultGuardConfig()
    return {
      enabled: typeof raw.enabled === 'boolean' ? raw.enabled : d.enabled,
      probe_url: typeof raw.probe_url === 'string' ? raw.probe_url : d.probe_url,
      ipify_url: typeof raw.ipify_url === 'string' ? raw.ipify_url : d.ipify_url,
    }
  } catch {
    return defaultGuardConfig()
  }
}

export function saveGuardConfig(stateDir: string, cfg: GuardConfig): void {
  const p = configPath(stateDir)
  mkdirSync(dirname(p), { recursive: true })
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 })
  renameSync(tmp, p)
}
