import { readFileSync, writeFileSync, existsSync, chmodSync, renameSync } from 'node:fs'
import { join } from 'node:path'

export type VoiceConfig =
  | {
      provider: 'http_tts'
      base_url: string
      model: string
      api_key?: string
      default_voice?: string
      saved_at: string
    }
  | {
      provider: 'qwen'
      api_key: string
      default_voice?: string
      saved_at: string
    }

function configPath(stateDir: string): string {
  return join(stateDir, 'voice-config.json')
}

function validate(raw: unknown): VoiceConfig | null {
  if (!raw || typeof raw !== 'object') return null
  const c = raw as Record<string, unknown>
  if (c.provider === 'http_tts') {
    if (typeof c.base_url !== 'string' || c.base_url.length < 5) return null
    if (typeof c.model !== 'string' || c.model.length === 0) return null
    if (typeof c.saved_at !== 'string') return null
    return {
      provider: 'http_tts',
      base_url: c.base_url,
      model: c.model,
      api_key: typeof c.api_key === 'string' ? c.api_key : undefined,
      default_voice: typeof c.default_voice === 'string' ? c.default_voice : undefined,
      saved_at: c.saved_at,
    }
  }
  if (c.provider === 'qwen') {
    if (typeof c.api_key !== 'string' || c.api_key.length < 3) return null
    if (typeof c.saved_at !== 'string') return null
    return {
      provider: 'qwen',
      api_key: c.api_key,
      default_voice: typeof c.default_voice === 'string' ? c.default_voice : undefined,
      saved_at: c.saved_at,
    }
  }
  return null
}

export function loadVoiceConfig(stateDir: string): VoiceConfig | null {
  const p = configPath(stateDir)
  if (!existsSync(p)) return null
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as unknown
    return validate(parsed)
  } catch {
    return null
  }
}

export async function saveVoiceConfig(stateDir: string, cfg: VoiceConfig): Promise<void> {
  const p = configPath(stateDir)
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8')
  try {
    chmodSync(tmp, 0o600)
  } catch {
    // Windows best-effort; swallow
  }
  renameSync(tmp, p)
}
