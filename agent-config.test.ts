import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadAgentConfig, saveAgentConfig } from './agent-config'

describe('agent-config', () => {
  it('defaults to claude with unattended=true when no config exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-config-'))
    try {
      expect(loadAgentConfig(dir)).toEqual({ provider: 'claude', dangerouslySkipPermissions: true, autoStart: false, keepAlive: false })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('persists codex provider and model', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-config-'))
    try {
      saveAgentConfig(dir, { provider: 'codex', model: 'gpt-5.3-codex', dangerouslySkipPermissions: true, autoStart: false, keepAlive: false })
      expect(loadAgentConfig(dir)).toEqual({ provider: 'codex', model: 'gpt-5.3-codex', dangerouslySkipPermissions: true, autoStart: false, keepAlive: false })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('persists dangerouslySkipPermissions=false when explicitly opted out', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-config-'))
    try {
      saveAgentConfig(dir, { provider: 'claude', dangerouslySkipPermissions: false, autoStart: false, keepAlive: false })
      expect(loadAgentConfig(dir)).toEqual({ provider: 'claude', dangerouslySkipPermissions: false, autoStart: false, keepAlive: false })
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
      expect(loadAgentConfig(dir)).toEqual({ provider: 'codex', model: 'foo', dangerouslySkipPermissions: true, autoStart: false, keepAlive: false })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('persists autoStart=true when set, defaults to false otherwise', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-config-'))
    try {
      saveAgentConfig(dir, { provider: 'claude', dangerouslySkipPermissions: true, autoStart: true, keepAlive: true })
      expect(loadAgentConfig(dir).autoStart).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('migrates pre-2026-04-28 configs (autoStart only, no keepAlive) by mirroring autoStart into keepAlive', () => {
    // Pre-split configs only had `autoStart`. To preserve old behavior
    // (autoStart=true ⇒ both RunAtLoad and KeepAlive), keepAlive defaults
    // to autoStart when the field is missing from disk.
    const dir = mkdtempSync(join(tmpdir(), 'agent-config-'))
    try {
      const fs = require('node:fs') as typeof import('node:fs')
      fs.writeFileSync(join(dir, 'agent-config.json'), JSON.stringify({
        provider: 'claude', dangerouslySkipPermissions: true, autoStart: true,
      }))
      expect(loadAgentConfig(dir).keepAlive).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('persists explicit keepAlive=true alongside autoStart=false (decoupled toggles)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-config-'))
    try {
      saveAgentConfig(dir, { provider: 'claude', dangerouslySkipPermissions: true, autoStart: false, keepAlive: true })
      const loaded = loadAgentConfig(dir)
      expect(loaded.autoStart).toBe(false)
      expect(loaded.keepAlive).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
