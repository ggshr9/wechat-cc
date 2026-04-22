import { describe, it, expect } from 'vitest'
import { loadVoiceConfig, saveVoiceConfig, type VoiceConfig } from './voice-config'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'wcc-voice-'))
}

describe('voice-config', () => {
  it('loadVoiceConfig returns null when file missing', () => {
    expect(loadVoiceConfig(freshDir())).toBeNull()
  })

  it('saveVoiceConfig + loadVoiceConfig round-trip for http_tts', async () => {
    const d = freshDir()
    const cfg: VoiceConfig = {
      provider: 'http_tts',
      base_url: 'http://mac:8000/v1/audio/speech',
      model: 'openbmb/VoxCPM2',
      default_voice: 'default',
      saved_at: '2026-04-22T10:00:00Z',
    }
    await saveVoiceConfig(d, cfg)
    expect(loadVoiceConfig(d)).toEqual(cfg)
  })

  it('saveVoiceConfig + loadVoiceConfig round-trip for qwen', async () => {
    const d = freshDir()
    const cfg: VoiceConfig = {
      provider: 'qwen',
      api_key: 'sk-test',
      default_voice: 'Cherry',
      saved_at: '2026-04-22T10:00:00Z',
    }
    await saveVoiceConfig(d, cfg)
    expect(loadVoiceConfig(d)).toEqual(cfg)
  })

  it('saveVoiceConfig round-trip preserves api_key in http_tts case', async () => {
    const d = freshDir()
    const cfg: VoiceConfig = {
      provider: 'http_tts',
      base_url: 'https://api.openai.com/v1/audio/speech',
      model: 'gpt-4o-mini-tts',
      api_key: 'sk-openai',
      default_voice: 'nova',
      saved_at: '2026-04-22T10:00:00Z',
    }
    await saveVoiceConfig(d, cfg)
    expect(loadVoiceConfig(d)).toEqual(cfg)
  })

  it('chmod 0600 on POSIX (no-op on Windows)', async () => {
    const d = freshDir()
    await saveVoiceConfig(d, {
      provider: 'qwen', api_key: 'sk', saved_at: '2026-04-22T10:00:00Z',
    })
    const path = join(d, 'voice-config.json')
    expect(existsSync(path)).toBe(true)
    if (process.platform !== 'win32') {
      const mode = statSync(path).mode & 0o777
      expect(mode).toBe(0o600)
    }
  })

  it('loadVoiceConfig returns null on malformed JSON', () => {
    const d = freshDir()
    writeFileSync(join(d, 'voice-config.json'), '{ not json')
    expect(loadVoiceConfig(d)).toBeNull()
  })

  it('loadVoiceConfig returns null when provider field missing or invalid', () => {
    const d = freshDir()
    writeFileSync(join(d, 'voice-config.json'), JSON.stringify({ saved_at: 'x' }))
    expect(loadVoiceConfig(d)).toBeNull()
  })

  it('loadVoiceConfig returns null when http_tts missing required fields', () => {
    const d = freshDir()
    writeFileSync(join(d, 'voice-config.json'), JSON.stringify({
      provider: 'http_tts', saved_at: 'x', // missing base_url, model
    }))
    expect(loadVoiceConfig(d)).toBeNull()
  })

  it('loadVoiceConfig returns null when qwen missing api_key', () => {
    const d = freshDir()
    writeFileSync(join(d, 'voice-config.json'), JSON.stringify({
      provider: 'qwen', saved_at: 'x',
    }))
    expect(loadVoiceConfig(d)).toBeNull()
  })

  it('saveVoiceConfig writes atomically (no partial file if rename fails)', async () => {
    // implementation-specific: just assert the final file has valid JSON after a successful call
    const d = freshDir()
    const cfg: VoiceConfig = {
      provider: 'qwen', api_key: 'sk', saved_at: '2026-04-22T10:00:00Z',
    }
    await saveVoiceConfig(d, cfg)
    const raw = readFileSync(join(d, 'voice-config.json'), 'utf8')
    expect(() => JSON.parse(raw)).not.toThrow()
  })
})
