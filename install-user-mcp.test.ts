import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { installUserMcp, type McpServerConfig } from './install-user-mcp'

let tmpDir: string
let configFile: string

const tmpDirs: string[] = []

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'wechat-cc-install-'))
  tmpDirs.push(tmpDir)
  configFile = join(tmpDir, '.claude.json')
})

afterAll(() => {
  for (const d of tmpDirs) {
    try { rmSync(d, { recursive: true, force: true }) } catch {}
  }
})

const wechatCfg: McpServerConfig = {
  command: '/home/u/.bun/bin/bun',
  args: ['run', '--cwd', '/home/u/.claude/plugins/local/wechat', '--silent', 'start'],
}

describe('installUserMcp', () => {
  it('creates ~/.claude.json when missing', () => {
    installUserMcp(configFile, 'wechat', wechatCfg)
    const raw = JSON.parse(readFileSync(configFile, 'utf8'))
    expect(raw.mcpServers.wechat).toEqual(wechatCfg)
  })

  it('adds wechat without touching other mcpServers', () => {
    writeFileSync(configFile, JSON.stringify({
      mcpServers: {
        other: { command: 'other-bin', args: [] },
      },
    }, null, 2))
    installUserMcp(configFile, 'wechat', wechatCfg)
    const raw = JSON.parse(readFileSync(configFile, 'utf8'))
    expect(raw.mcpServers.other).toEqual({ command: 'other-bin', args: [] })
    expect(raw.mcpServers.wechat).toEqual(wechatCfg)
  })

  it('replaces existing wechat entry', () => {
    writeFileSync(configFile, JSON.stringify({
      mcpServers: {
        wechat: { command: 'old-bin', args: ['old'] },
      },
    }))
    installUserMcp(configFile, 'wechat', wechatCfg)
    const raw = JSON.parse(readFileSync(configFile, 'utf8'))
    expect(raw.mcpServers.wechat).toEqual(wechatCfg)
  })

  it('preserves unrelated top-level keys', () => {
    writeFileSync(configFile, JSON.stringify({
      someOtherSetting: 'keep-me',
      mcpServers: {},
    }))
    installUserMcp(configFile, 'wechat', wechatCfg)
    const raw = JSON.parse(readFileSync(configFile, 'utf8'))
    expect(raw.someOtherSetting).toBe('keep-me')
    expect(raw.mcpServers.wechat).toEqual(wechatCfg)
  })

  it('is idempotent (running twice yields same file content)', () => {
    installUserMcp(configFile, 'wechat', wechatCfg)
    const first = readFileSync(configFile, 'utf8')
    installUserMcp(configFile, 'wechat', wechatCfg)
    const second = readFileSync(configFile, 'utf8')
    expect(first).toBe(second)
  })

  it('creates mcpServers object when top-level JSON has none', () => {
    writeFileSync(configFile, JSON.stringify({ other: 1 }))
    installUserMcp(configFile, 'wechat', wechatCfg)
    const raw = JSON.parse(readFileSync(configFile, 'utf8'))
    expect(raw.mcpServers.wechat).toEqual(wechatCfg)
    expect(raw.other).toBe(1)
  })
})
