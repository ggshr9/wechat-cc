import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadAgentConfig, saveAgentConfig, parseAgentConfig, A2AAgentRecord, makeMtimeCachedConfigReader, activeModel, withActiveModel, type AgentConfig } from './agent-config'

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

describe('loadAgentConfig preserves yi v2 fields', () => {
  it('round-trips yi_hub_listen and yi_brain through save+load', () => {
    const dir = mkdtempSync(join(tmpdir(), 'yi-cfg-'))
    try {
      saveAgentConfig(dir, {
        provider: 'claude', dangerouslySkipPermissions: true, autoStart: true, closeStopsDaemon: false,
        yi_hub_listen: { host: '100.1.2.3', port: 8718 },
        yi_brain: { url: 'ws://brain/yi', handId: 'home', authToken: 'k'.repeat(16) },
      })
      const loaded = loadAgentConfig(dir)
      expect(loaded.yi_hub_listen).toEqual({ host: '100.1.2.3', port: 8718 })
      expect(loaded.yi_brain).toEqual({ url: 'ws://brain/yi', handId: 'home', authToken: 'k'.repeat(16) })
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('makeMtimeCachedConfigReader', () => {
  const claudeCfg = (model: string): AgentConfig => ({
    provider: 'claude', model, dangerouslySkipPermissions: true, autoStart: true, closeStopsDaemon: false,
  })

  it('reads the live config from disk on first call', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfg-cache-'))
    try {
      saveAgentConfig(dir, claudeCfg('claude-sonnet-4-6'))
      const read = makeMtimeCachedConfigReader(dir)
      expect(read().model).toBe('claude-sonnet-4-6')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('re-reads after the file signature changes (picks up a /model switch without restart)', () => {
    let sig = '1:100'
    const configs = [claudeCfg('claude-opus-4-8'), claudeCfg('claude-sonnet-4-6')]
    let i = 0
    const load = (): AgentConfig => configs[Math.min(i++, configs.length - 1)]!
    const read = makeMtimeCachedConfigReader('/state', { statSig: () => sig, load })
    expect(read().model).toBe('claude-opus-4-8')
    sig = '2:110' // operator ran /model -> agent-config.json rewritten
    expect(read().model).toBe('claude-sonnet-4-6')
  })

  it('re-reads when only the SIZE changes at the same mtime (same-ms collision)', () => {
    let sig = '5:100'
    const configs = [claudeCfg('claude-opus-4-8'), claudeCfg('claude-sonnet-4-6')]
    let i = 0
    const load = (): AgentConfig => configs[Math.min(i++, configs.length - 1)]!
    const read = makeMtimeCachedConfigReader('/state', { statSig: () => sig, load })
    expect(read().model).toBe('claude-opus-4-8')
    sig = '5:118' // same mtime (5), different size → signature changes
    expect(read().model).toBe('claude-sonnet-4-6')
  })

  it('serves the cached config without re-loading while the signature is unchanged', () => {
    let loads = 0
    const load = (): AgentConfig => { loads++; return claudeCfg('claude-opus-4-8') }
    const read = makeMtimeCachedConfigReader('/state', { statSig: () => '7:100', load })
    read(); read(); read()
    expect(loads).toBe(1)
  })

  it('treats a missing file (stat throws -> "absent") as a stable cache key', () => {
    let loads = 0
    const load = (): AgentConfig => { loads++; return claudeCfg('claude-opus-4-8') }
    const read = makeMtimeCachedConfigReader('/state', { statSig: () => 'absent', load })
    expect(read().model).toBe('claude-opus-4-8')
    read()
    expect(loads).toBe(1) // 'absent' == 'absent', no churn while the file stays absent
  })
})

describe('activeModel / withActiveModel — provider-specific model field', () => {
  const base = (provider: AgentConfig['provider']): AgentConfig => ({
    provider, dangerouslySkipPermissions: false, autoStart: false, closeStopsDaemon: false,
  })

  it('reads `model` for claude/codex and `cursorModel` for cursor', () => {
    expect(activeModel({ ...base('claude'), model: 'claude-opus-4-8' })).toBe('claude-opus-4-8')
    expect(activeModel({ ...base('codex'), model: 'gpt-5.3-codex' })).toBe('gpt-5.3-codex')
    expect(activeModel({ ...base('cursor'), cursorModel: 'composer-2', model: 'ignored' })).toBe('composer-2')
  })

  it('returns undefined when the provider\'s field is unset', () => {
    expect(activeModel(base('claude'))).toBeUndefined()
    // cursor reads cursorModel, so a stray `model` does not count as set
    expect(activeModel({ ...base('cursor'), model: 'claude-opus-4-8' })).toBeUndefined()
  })

  it('writes the provider\'s field and round-trips through activeModel', () => {
    const claude = withActiveModel(base('claude'), 'claude-opus-4-8')
    expect(claude.model).toBe('claude-opus-4-8')
    expect(claude.cursorModel).toBeUndefined()
    expect(activeModel(claude)).toBe('claude-opus-4-8')

    const cursor = withActiveModel(base('cursor'), 'composer-2')
    expect(cursor.cursorModel).toBe('composer-2')
    expect(cursor.model).toBeUndefined()
    expect(activeModel(cursor)).toBe('composer-2')
  })

  it('does not mutate the input config', () => {
    const cfg = base('claude')
    withActiveModel(cfg, 'claude-opus-4-8')
    expect(cfg.model).toBeUndefined()
  })
})

describe('A2AAgentRecord.transport', () => {
  it('defaults transport to "push" when absent', () => {
    const rec = A2AAgentRecord.parse({
      id: 'home', name: 'home', url: 'http://h/a2a',
      inbound_api_key: 'k'.repeat(16), outbound_api_key: 'o', capabilities: ['exec'],
    })
    expect(rec.transport).toBe('push')
  })
  it('accepts transport "ws"', () => {
    const rec = A2AAgentRecord.parse({
      id: 'home', name: 'home', url: 'http://h/a2a',
      inbound_api_key: 'k'.repeat(16), outbound_api_key: 'o', capabilities: ['exec'], transport: 'ws',
    })
    expect(rec.transport).toBe('ws')
  })
})
