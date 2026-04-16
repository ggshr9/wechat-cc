import { describe, it, expect } from 'vitest'
import { parseRunArgs, buildClaudeArgs } from './cli'

describe('parseRunArgs', () => {
  it('parses --dangerously flag', () => {
    const flags = parseRunArgs(['--dangerously'])
    expect(flags.skipPermissions).toBe(true)
    expect(flags.freshSession).toBe(false)
    expect(flags.extraArgs).toEqual([])
  })

  it('parses --fresh flag', () => {
    const flags = parseRunArgs(['--fresh'])
    expect(flags.freshSession).toBe(true)
    expect(flags.skipPermissions).toBe(false)
  })

  it('parses both flags together', () => {
    const flags = parseRunArgs(['--dangerously', '--fresh'])
    expect(flags.skipPermissions).toBe(true)
    expect(flags.freshSession).toBe(true)
  })

  it('consumes --continue silently (default behavior)', () => {
    const flags = parseRunArgs(['--continue'])
    expect(flags.freshSession).toBe(false)
    expect(flags.extraArgs).toEqual([])
  })

  it('normalizes em-dash to double hyphen', () => {
    // WeChat/iOS autocorrects -- to — (U+2014)
    const flags = parseRunArgs(['—dangerously'])
    expect(flags.skipPermissions).toBe(true)
  })

  it('normalizes en-dash to double hyphen', () => {
    const flags = parseRunArgs(['–fresh'])
    expect(flags.freshSession).toBe(true)
  })

  it('passes through unknown args as extraArgs', () => {
    const flags = parseRunArgs(['--dangerously', '--some-other-flag', 'value'])
    expect(flags.skipPermissions).toBe(true)
    expect(flags.extraArgs).toEqual(['--some-other-flag', 'value'])
  })

  it('returns defaults for empty input', () => {
    const flags = parseRunArgs([])
    expect(flags.skipPermissions).toBe(false)
    expect(flags.freshSession).toBe(false)
    expect(flags.extraArgs).toEqual([])
  })
})

describe('buildClaudeArgs', () => {
  const FAKE_BUN = '/usr/bin/bun'

  it('includes --dangerously-load-development-channels', () => {
    const args = buildClaudeArgs(
      { skipPermissions: false, freshSession: false, extraArgs: [] },
      FAKE_BUN,
    )
    expect(args).toContain('--dangerously-load-development-channels')
    expect(args).toContain('server:wechat')
  })

  it('includes --continue when not fresh', () => {
    const args = buildClaudeArgs(
      { skipPermissions: false, freshSession: false, extraArgs: [] },
      FAKE_BUN,
    )
    expect(args).toContain('--continue')
  })

  it('omits --continue when fresh', () => {
    const args = buildClaudeArgs(
      { skipPermissions: false, freshSession: true, extraArgs: [] },
      FAKE_BUN,
    )
    expect(args).not.toContain('--continue')
  })

  it('includes --dangerously-skip-permissions when skipPermissions', () => {
    const args = buildClaudeArgs(
      { skipPermissions: true, freshSession: false, extraArgs: [] },
      FAKE_BUN,
    )
    expect(args).toContain('--dangerously-skip-permissions')
  })

  it('passes through extraArgs', () => {
    const args = buildClaudeArgs(
      { skipPermissions: false, freshSession: false, extraArgs: ['--model', 'opus'] },
      FAKE_BUN,
    )
    expect(args).toContain('--model')
    expect(args).toContain('opus')
  })

  it('includes --mcp-config with valid JSON', () => {
    const args = buildClaudeArgs(
      { skipPermissions: false, freshSession: false, extraArgs: [] },
      FAKE_BUN,
    )
    const configIdx = args.indexOf('--mcp-config')
    expect(configIdx).toBeGreaterThanOrEqual(0)
    const configJson = args[configIdx + 1]
    const parsed = JSON.parse(configJson)
    expect(parsed.mcpServers.wechat).toBeDefined()
    expect(parsed.mcpServers.wechat.command).toBe(FAKE_BUN)
  })
})
