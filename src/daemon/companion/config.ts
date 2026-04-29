/**
 * Companion v2 config — radically simplified from v1.
 *
 * v1 had triggers[] + per_project_persona + personas[] — all deleted.
 * Those responsibilities moved to Claude's memory/ (self-organized).
 * This config keeps only the 3 knobs that MUST live in structured state
 * because Claude can't observe them without help:
 *
 *   - enabled: is proactive tick allowed? (daemon-level gate)
 *   - default_chat_id: where to push to by default
 *   - snooze_until: temporary hard stop (set via companion_snooze)
 *   - timezone: so the scheduler's jitter respects user locality
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs'
import { companionDir, configPath } from './paths'

export interface CompanionConfig {
  enabled: boolean
  timezone: string
  default_chat_id: string | null
  snooze_until: string | null
  /**
   * ISO timestamp of last successful introspect tick. Persisted across
   * daemon restarts so the 24h cadence isn't reset by every reboot. Null
   * when introspect has never run on this install. See main.ts
   * maybeStartupIntrospect for the catch-up logic.
   */
  last_introspect_at: string | null
}

export function defaultCompanionConfig(): CompanionConfig {
  return {
    enabled: false,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC',
    default_chat_id: null,
    snooze_until: null,
    last_introspect_at: null,
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

export function loadCompanionConfig(stateDir: string): CompanionConfig {
  const p = configPath(stateDir)
  if (!existsSync(p)) return defaultCompanionConfig()
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as unknown
    if (!isObject(parsed)) return defaultCompanionConfig()
    const d = defaultCompanionConfig()
    return {
      enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : d.enabled,
      timezone: typeof parsed.timezone === 'string' && parsed.timezone ? parsed.timezone : d.timezone,
      default_chat_id: typeof parsed.default_chat_id === 'string' ? parsed.default_chat_id : null,
      snooze_until: typeof parsed.snooze_until === 'string' ? parsed.snooze_until : null,
      last_introspect_at: typeof parsed.last_introspect_at === 'string' ? parsed.last_introspect_at : null,
    }
    // Legacy triggers/per_project_persona/triggers fields (if any) are
    // silently dropped on next save — migration path for v1.1 installs.
  } catch {
    return defaultCompanionConfig()
  }
}

export async function saveCompanionConfig(stateDir: string, cfg: CompanionConfig): Promise<void> {
  const p = configPath(stateDir)
  if (!existsSync(companionDir(stateDir))) {
    mkdirSync(companionDir(stateDir), { recursive: true })
  }
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8')
  renameSync(tmp, p)
}
