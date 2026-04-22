import { describe, it, expect } from 'vitest'
import { loadCompanionConfig, saveCompanionConfig, defaultCompanionConfig } from './config'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'wcc-cc-'))
  mkdirSync(join(d, 'companion'), { recursive: true })
  return d
}

describe('companion/config', () => {
  it('defaultCompanionConfig returns disabled + sensible defaults', () => {
    const cfg = defaultCompanionConfig()
    expect(cfg.enabled).toBe(false)
    expect(cfg.triggers).toEqual([])
    expect(cfg.per_project_persona).toEqual({})
    expect(cfg.snooze_until).toBeNull()
    expect(cfg.default_chat_id).toBeNull()
    expect(typeof cfg.timezone).toBe('string')
    expect(cfg.timezone.length).toBeGreaterThan(0)
  })

  it('loadCompanionConfig returns default when file missing', () => {
    const d = mkdtempSync(join(tmpdir(), 'wcc-cc-miss-'))
    const cfg = loadCompanionConfig(d)
    expect(cfg.enabled).toBe(false)
    expect(cfg.triggers).toEqual([])
  })

  it('saveCompanionConfig + loadCompanionConfig round-trip', async () => {
    const d = freshDir()
    const cfg = {
      ...defaultCompanionConfig(),
      enabled: true,
      per_project_persona: { wechat: 'assistant', _default: 'assistant' },
      default_chat_id: 'chat-1',
      triggers: [{
        id: 't1',
        project: 'wechat',
        schedule: '*/10 * * * *',
        task: 'do X',
        personas: ['assistant'],
        on_failure: 'silent' as const,
        created_at: '2026-04-22T00:00:00Z',
      }],
    }
    await saveCompanionConfig(d, cfg)
    const loaded = loadCompanionConfig(d)
    expect(loaded.enabled).toBe(true)
    expect(loaded.triggers).toHaveLength(1)
    expect(loaded.triggers[0]?.id).toBe('t1')
    expect(loaded.per_project_persona.wechat).toBe('assistant')
    expect(loaded.default_chat_id).toBe('chat-1')
  })

  it('tolerates partial / legacy config files (fills in defaults)', () => {
    const d = freshDir()
    writeFileSync(join(d, 'companion', 'config.json'), JSON.stringify({ enabled: true }))
    const cfg = loadCompanionConfig(d)
    expect(cfg.enabled).toBe(true)
    expect(cfg.triggers).toEqual([])
    expect(cfg.per_project_persona).toEqual({})
    expect(cfg.snooze_until).toBeNull()
    expect(cfg.default_chat_id).toBeNull()
  })

  it('tolerates malformed JSON (returns defaults)', () => {
    const d = freshDir()
    writeFileSync(join(d, 'companion', 'config.json'), '{ not json')
    const cfg = loadCompanionConfig(d)
    expect(cfg.enabled).toBe(false)
    expect(cfg.triggers).toEqual([])
  })

  it('saveCompanionConfig creates companion dir if missing', async () => {
    const d = mkdtempSync(join(tmpdir(), 'wcc-cc-nodir-'))
    // Note: no companion/ dir pre-created
    await saveCompanionConfig(d, { ...defaultCompanionConfig(), enabled: true })
    const cfg = loadCompanionConfig(d)
    expect(cfg.enabled).toBe(true)
  })

  it('snooze_until and paused_until fields preserved round-trip', async () => {
    const d = freshDir()
    const cfg = {
      ...defaultCompanionConfig(),
      snooze_until: '2026-04-22T12:00:00Z',
      triggers: [{
        id: 't', project: 'p', schedule: '* * * * *', task: 'x',
        personas: [], on_failure: 'silent' as const, created_at: 'c',
        paused_until: '2026-04-22T13:00:00Z',
      }],
    }
    await saveCompanionConfig(d, cfg)
    const loaded = loadCompanionConfig(d)
    expect(loaded.snooze_until).toBe('2026-04-22T12:00:00Z')
    expect(loaded.triggers[0]?.paused_until).toBe('2026-04-22T13:00:00Z')
  })
})
