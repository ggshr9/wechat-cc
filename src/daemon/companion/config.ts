import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs'
import { companionDir, configPath } from './paths'

export interface Trigger {
  id: string
  project: string
  schedule: string       // cron pattern (croner)
  task: string           // Claude prompt for isolated eval
  personas: string[]     // empty = fires for any persona
  on_failure: 'silent' | 'notify-user' | 'retry-once'
  created_at: string     // ISO
  paused_until?: string | null
}

export interface CompanionConfig {
  enabled: boolean
  timezone: string
  per_project_persona: Record<string, string>
  default_chat_id: string | null
  snooze_until: string | null
  triggers: Trigger[]
}

export function defaultCompanionConfig(): CompanionConfig {
  return {
    enabled: false,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC',
    per_project_persona: {},
    default_chat_id: null,
    snooze_until: null,
    triggers: [],
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
      per_project_persona: isObject(parsed.per_project_persona)
        ? Object.fromEntries(
            Object.entries(parsed.per_project_persona).filter(
              (kv): kv is [string, string] => typeof kv[1] === 'string',
            ),
          )
        : {},
      default_chat_id: typeof parsed.default_chat_id === 'string' ? parsed.default_chat_id : null,
      snooze_until: typeof parsed.snooze_until === 'string' ? parsed.snooze_until : null,
      triggers: Array.isArray(parsed.triggers) ? (parsed.triggers as Trigger[]) : [],
    }
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
