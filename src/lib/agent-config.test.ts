import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadAgentConfig, saveAgentConfig } from './agent-config'

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
})
