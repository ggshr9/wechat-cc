import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadAgentConfig, saveAgentConfig } from './agent-config'

describe('agent-config', () => {
  it('defaults to claude with unattended=true when no config exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-config-'))
    try {
      expect(loadAgentConfig(dir)).toEqual({ provider: 'claude', dangerouslySkipPermissions: true })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('persists codex provider and model', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-config-'))
    try {
      saveAgentConfig(dir, { provider: 'codex', model: 'gpt-5.3-codex', dangerouslySkipPermissions: true })
      expect(loadAgentConfig(dir)).toEqual({ provider: 'codex', model: 'gpt-5.3-codex', dangerouslySkipPermissions: true })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('persists dangerouslySkipPermissions=false when explicitly opted out', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-config-'))
    try {
      saveAgentConfig(dir, { provider: 'claude', dangerouslySkipPermissions: false })
      expect(loadAgentConfig(dir)).toEqual({ provider: 'claude', dangerouslySkipPermissions: false })
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
      expect(loadAgentConfig(dir)).toEqual({ provider: 'codex', model: 'foo', dangerouslySkipPermissions: true })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
