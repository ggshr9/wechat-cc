import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadAgentConfig, saveAgentConfig, parseAgentConfig } from './agent-config'

describe('agent-config', () => {
  it('defaults to claude with unattended=true when no config exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-config-'))
    try {
      expect(loadAgentConfig(dir)).toEqual({ provider: 'claude', dangerouslySkipPermissions: true, autoStart: true, closeStopsDaemon: false })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('defaults autoStart to true when no config file exists (v0.6)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-config-'))
    try {
      const cfg = loadAgentConfig(dir)
      expect(cfg.autoStart).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('defaults closeStopsDaemon to false', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-config-'))
    try {
      const cfg = loadAgentConfig(dir)
      expect(cfg.closeStopsDaemon).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('preserves explicit autoStart=false from saved config (upgrade safety)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-config-'))
    try {
      saveAgentConfig(dir, { provider: 'claude', dangerouslySkipPermissions: true, autoStart: false, closeStopsDaemon: false })
      const cfg = loadAgentConfig(dir)
      expect(cfg.autoStart).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('preserves explicit closeStopsDaemon=true from saved config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-config-'))
    try {
      saveAgentConfig(dir, { provider: 'claude', dangerouslySkipPermissions: true, autoStart: true, closeStopsDaemon: true })
      const cfg = loadAgentConfig(dir)
      expect(cfg.closeStopsDaemon).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('persists codex provider and model', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-config-'))
    try {
      saveAgentConfig(dir, { provider: 'codex', model: 'gpt-5.3-codex', dangerouslySkipPermissions: true, autoStart: false, closeStopsDaemon: false })
      expect(loadAgentConfig(dir)).toEqual({ provider: 'codex', model: 'gpt-5.3-codex', dangerouslySkipPermissions: true, autoStart: false, closeStopsDaemon: false })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // Regression for 2026-05-08: daemon was inheriting `~/.claude/.claude.json`
  // model alias (e.g. `opus[1m]` for fast mode) into spawned Claude Code
  // subprocesses. The 2.1.133 CLI mis-resolved that alias under SDK mode and
  // sent literal `"opus"` to Anthropic's API → 404. The framework fix is to
  // let `agent-config.json` pin a Claude model independently of `.claude.json`,
  // mirroring what Codex already does (loadAgentConfig + bootstrap).
  it('persists claude provider with explicit model', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-config-'))
    try {
      saveAgentConfig(dir, { provider: 'claude', model: 'claude-opus-4-7', dangerouslySkipPermissions: true, autoStart: false, closeStopsDaemon: false })
      expect(loadAgentConfig(dir)).toEqual({ provider: 'claude', model: 'claude-opus-4-7', dangerouslySkipPermissions: true, autoStart: false, closeStopsDaemon: false })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('persists dangerouslySkipPermissions=false when explicitly opted out', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-config-'))
    try {
      saveAgentConfig(dir, { provider: 'claude', dangerouslySkipPermissions: false, autoStart: false, closeStopsDaemon: false })
      expect(loadAgentConfig(dir)).toEqual({ provider: 'claude', dangerouslySkipPermissions: false, autoStart: false, closeStopsDaemon: false })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('migrates legacy config (no dangerouslySkipPermissions field) to unattended=true', () => {
    // Simulates an agent-config.json written by an older wizard that
    // didn't know about the dangerouslySkipPermissions field.
    const dir = mkdtempSync(join(tmpdir(), 'agent-config-'))
    try {
      const fs = require('node:fs') as typeof import('node:fs')
      fs.writeFileSync(join(dir, 'agent-config.json'), JSON.stringify({ provider: 'codex', model: 'foo' }))
      expect(loadAgentConfig(dir)).toEqual({ provider: 'codex', model: 'foo', dangerouslySkipPermissions: true, autoStart: true, closeStopsDaemon: false })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('persists autoStart=true when set', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-config-'))
    try {
      saveAgentConfig(dir, { provider: 'claude', dangerouslySkipPermissions: true, autoStart: true, closeStopsDaemon: false })
      expect(loadAgentConfig(dir).autoStart).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reads pre-2026-04-29 configs that still have a keepAlive field on disk by silently dropping it', () => {
    // KeepAlive used to be a user-facing toggle. Now crash-respawn is
    // unconditional, so configs persisted by the old wizard still parse
    // — the field is just ignored on read and not re-written on save.
    const dir = mkdtempSync(join(tmpdir(), 'agent-config-'))
    try {
      const fs = require('node:fs') as typeof import('node:fs')
      fs.writeFileSync(join(dir, 'agent-config.json'), JSON.stringify({
        provider: 'claude', dangerouslySkipPermissions: true, autoStart: true, keepAlive: false,
      }))
      const loaded = loadAgentConfig(dir)
      expect(loaded).toEqual({ provider: 'claude', dangerouslySkipPermissions: true, autoStart: true, closeStopsDaemon: false })
      expect((loaded as { keepAlive?: boolean }).keepAlive).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('round-trips bot_name string through save → load', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-cfg-botname-'))
    try {
      const cfg = {
        provider: 'claude' as const,
        dangerouslySkipPermissions: true,
        autoStart: true,
        closeStopsDaemon: false,
        bot_name: '小希',
      }
      saveAgentConfig(dir, cfg)
      const loaded = loadAgentConfig(dir)
      expect(loaded.bot_name).toBe('小希')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('round-trips bot_name=null through save → load', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-cfg-botname-null-'))
    try {
      const cfg = {
        provider: 'claude' as const,
        dangerouslySkipPermissions: true,
        autoStart: true,
        closeStopsDaemon: false,
        bot_name: null,
      }
      saveAgentConfig(dir, cfg)
      const loaded = loadAgentConfig(dir)
      expect(loaded.bot_name).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('absent bot_name field loads as undefined (back-compat)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-cfg-botname-abs-'))
    try {
      writeFileSync(join(dir, 'agent-config.json'), JSON.stringify({
        provider: 'claude',
        dangerouslySkipPermissions: true,
        autoStart: true,
        closeStopsDaemon: false,
      }))
      const loaded = loadAgentConfig(dir)
      expect(loaded.bot_name).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('agent-config — A2A fields', () => {
  it('accepts a config with a2a_listen and a2a_agents', () => {
    const cfg = parseAgentConfig({
      provider: 'claude',
      a2a_listen: { host: '127.0.0.1', port: 8717 },
      a2a_agents: [
        { id: 'deploy-bot', name: 'Deploy Bot', url: 'https://deploy.example.com/a2a',
          inbound_api_key: 'wc_abc1234567890123', outbound_api_key: 'dpb_xyz',
          capabilities: ['notify'], paused: false },
      ],
    })
    expect(cfg.a2a_listen?.port).toBe(8717)
    expect(cfg.a2a_agents).toHaveLength(1)
    expect(cfg.a2a_agents?.[0]?.id).toBe('deploy-bot')
  })

  it('accepts config without A2A fields (backward compat)', () => {
    const cfg = parseAgentConfig({ provider: 'claude' })
    expect(cfg.a2a_listen).toBeUndefined()
    expect(cfg.a2a_agents).toBeUndefined()
  })

  it('rejects duplicate agent ids', () => {
    expect(() => parseAgentConfig({
      provider: 'claude',
      a2a_agents: [
        { id: 'x', name: 'X', url: 'https://a/a2a', inbound_api_key: 'wc_1234567890123456', outbound_api_key: 'k2', capabilities: ['notify'], paused: false },
        { id: 'x', name: 'X2', url: 'https://b/a2a', inbound_api_key: 'wc_2234567890123456', outbound_api_key: 'k4', capabilities: ['notify'], paused: false },
      ],
    })).toThrow(/duplicate a2a agent id/)
  })

  it('rejects invalid agent id (must be slug: lowercase alphanumeric + dash)', () => {
    expect(() => parseAgentConfig({
      provider: 'claude',
      a2a_agents: [{ id: 'Bad ID!', name: 'X', url: 'https://a/a2a',
        inbound_api_key: 'wc_1234567890123456', outbound_api_key: 'k', capabilities: ['notify'], paused: false }],
    })).toThrow(/agent id must match/)
  })
})

describe('loadAgentConfig — gemini provider', () => {
  it('resolves provider=gemini + geminiModel', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentcfg-'))
    writeFileSync(join(dir, 'agent-config.json'), JSON.stringify({ provider: 'gemini', geminiModel: 'gemini-flash-latest' }))
    const cfg = loadAgentConfig(dir)
    expect(cfg.provider).toBe('gemini')
    expect(cfg.geminiModel).toBe('gemini-flash-latest')
  })

  // Regression for Fix 1: provider set gemini --model X must write geminiModel,
  // not the generic model field, so bootstrap can register the gemini provider.
  it('round-trips gemini + geminiModel via saveAgentConfig → loadAgentConfig (mirrors provider set routing)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentcfg-gemini-set-'))
    try {
      saveAgentConfig(dir, {
        provider: 'gemini',
        geminiModel: 'gemini-flash-latest',
        dangerouslySkipPermissions: false,
        autoStart: false,
        closeStopsDaemon: false,
      })
      const cfg = loadAgentConfig(dir)
      expect(cfg.provider).toBe('gemini')
      expect(cfg.geminiModel).toBe('gemini-flash-latest')
      // Must NOT bleed into the generic model field
      expect(cfg.model).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('loadAgentConfig — cursor provider', () => {
  it('accepts provider="cursor" with cursorModel', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-cfg-'))
    const fs = require('node:fs') as typeof import('node:fs')
    fs.writeFileSync(join(dir, 'agent-config.json'), JSON.stringify({
      provider: 'cursor',
      cursorModel: 'composer-2',
      dangerouslySkipPermissions: false,
      autoStart: false,
      closeStopsDaemon: false,
    }))
    try {
      const cfg = loadAgentConfig(dir)
      expect(cfg.provider).toBe('cursor')
      expect(cfg.cursorModel).toBe('composer-2')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('cursorModel optional — defaults to undefined', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-cfg-'))
    const fs = require('node:fs') as typeof import('node:fs')
    fs.writeFileSync(join(dir, 'agent-config.json'), JSON.stringify({
      provider: 'cursor',
      dangerouslySkipPermissions: false,
      autoStart: false,
      closeStopsDaemon: false,
    }))
    try {
      const cfg = loadAgentConfig(dir)
      expect(cfg.provider).toBe('cursor')
      expect(cfg.cursorModel).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
