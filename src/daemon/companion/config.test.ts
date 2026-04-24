import { describe, it, expect } from 'vitest'
import { loadCompanionConfig, saveCompanionConfig, defaultCompanionConfig } from './config'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'wcc-cc-'))
  mkdirSync(join(d, 'companion'), { recursive: true })
  return d
}

describe('companion/config (v2 — memory-first, no triggers/personas)', () => {
  it('defaultCompanionConfig returns disabled + sensible defaults', () => {
    const cfg = defaultCompanionConfig()
    expect(cfg.enabled).toBe(false)
    expect(cfg.snooze_until).toBeNull()
    expect(cfg.default_chat_id).toBeNull()
    expect(typeof cfg.timezone).toBe('string')
    expect(cfg.timezone.length).toBeGreaterThan(0)
  })

  it('loadCompanionConfig returns default when file missing', () => {
    const d = mkdtempSync(join(tmpdir(), 'wcc-cc-miss-'))
    const cfg = loadCompanionConfig(d)
    expect(cfg.enabled).toBe(false)
  })

  it('saveCompanionConfig + loadCompanionConfig round-trip', async () => {
    const d = freshDir()
    const cfg = {
      ...defaultCompanionConfig(),
      enabled: true,
      default_chat_id: 'chat-1',
      snooze_until: '2026-04-25T00:00:00Z',
    }
    await saveCompanionConfig(d, cfg)
    const loaded = loadCompanionConfig(d)
    expect(loaded.enabled).toBe(true)
    expect(loaded.default_chat_id).toBe('chat-1')
    expect(loaded.snooze_until).toBe('2026-04-25T00:00:00Z')
  })

  it('silently drops legacy triggers/per_project_persona fields (v1 → v2 migration)', () => {
    const d = freshDir()
    writeFileSync(join(d, 'companion', 'config.json'), JSON.stringify({
      enabled: true,
      triggers: [{ id: 't1', project: 'p', schedule: '* * * * *' }],
      per_project_persona: { _default: 'assistant' },
      default_chat_id: 'c1',
    }))
    const cfg = loadCompanionConfig(d)
    expect(cfg.enabled).toBe(true)
    expect(cfg.default_chat_id).toBe('c1')
    // Legacy fields are not surfaced on the v2 interface; first save drops them.
    expect('triggers' in cfg).toBe(false)
    expect('per_project_persona' in cfg).toBe(false)
  })

  it('tolerates malformed JSON', () => {
    const d = freshDir()
    writeFileSync(join(d, 'companion', 'config.json'), '{ not json')
    expect(loadCompanionConfig(d).enabled).toBe(false)
  })

  it('saveCompanionConfig creates companion dir if missing', async () => {
    const d = mkdtempSync(join(tmpdir(), 'wcc-cc-nodir-'))
    await saveCompanionConfig(d, { ...defaultCompanionConfig(), enabled: true })
    expect(loadCompanionConfig(d).enabled).toBe(true)
  })
})
