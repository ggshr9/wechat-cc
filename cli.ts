#!/usr/bin/env bun
/**
 * wechat-cc — WeChat channel for Claude Code
 *
 * Usage:
 *   wechat-cc setup     — 微信扫码绑定（可多次运行添加多人）
 *   wechat-cc start     — 启动 MCP channel server（.mcp.json 调用）
 *   wechat-cc run       — 启动 Claude Code + WeChat channel（一键启动）
 *   wechat-cc list      — 列出已绑定账号
 *   wechat-cc install   — 在当前目录生成 .mcp.json
 */

import { execSync, spawnSync } from 'child_process'
import { existsSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'fs'
import { resolve, dirname, join } from 'path'
import { homedir } from 'os'

const PLUGIN_DIR = dirname(new URL(import.meta.url).pathname)
const STATE_DIR = join(homedir(), '.claude', 'channels', 'wechat')
const ACCOUNTS_DIR = join(STATE_DIR, 'accounts')
const RESTART_FLAG_PATH = join(STATE_DIR, '.restart-flag')

function getBunPath(): string {
  try {
    return execSync('which bun', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
  } catch {
    return join(homedir(), '.bun', 'bin', 'bun')
  }
}

function listAccounts() {
  if (!existsSync(ACCOUNTS_DIR)) {
    console.log('没有已绑定的账号。运行 wechat-cc setup 来扫码绑定。')
    return
  }
  const dirs = readdirSync(ACCOUNTS_DIR)
  if (dirs.length === 0) {
    console.log('没有已绑定的账号。运行 wechat-cc setup 来扫码绑定。')
    return
  }
  console.log(`已绑定 ${dirs.length} 个账号：\n`)
  for (const id of dirs) {
    try {
      const account = JSON.parse(readFileSync(join(ACCOUNTS_DIR, id, 'account.json'), 'utf8'))
      console.log(`  ${id}`)
      console.log(`    botId:  ${account.botId}`)
      console.log(`    userId: ${account.userId}`)
      console.log(`    base:   ${account.baseUrl}`)
      console.log()
    } catch {
      console.log(`  ${id} (无法读取)`)
    }
  }
}

function install() {
  const bun = getBunPath()
  const mcpConfig = {
    mcpServers: {
      wechat: {
        command: bun,
        args: ['run', '--cwd', PLUGIN_DIR, '--silent', 'start'],
      },
    },
  }

  const mcpPath = resolve(process.cwd(), '.mcp.json')
  if (existsSync(mcpPath)) {
    try {
      const existing = JSON.parse(readFileSync(mcpPath, 'utf-8'))
      existing.mcpServers = existing.mcpServers || {}
      existing.mcpServers.wechat = mcpConfig.mcpServers.wechat
      writeFileSync(mcpPath, JSON.stringify(existing, null, 2) + '\n', 'utf-8')
      console.log(`已更新: ${mcpPath}`)
    } catch {
      writeFileSync(mcpPath, JSON.stringify(mcpConfig, null, 2) + '\n', 'utf-8')
      console.log(`已创建: ${mcpPath}`)
    }
  } else {
    writeFileSync(mcpPath, JSON.stringify(mcpConfig, null, 2) + '\n', 'utf-8')
    console.log(`已创建: ${mcpPath}`)
  }
  console.log('\n下一步: wechat-cc run')
}

// ── Argument parsing / building ────────────────────────────────────────────
// Extracted so the supervisor loop can reuse them when /restart arrives with
// a different set of flags.

interface RunFlags {
  skipPermissions: boolean
  freshSession: boolean
  extraArgs: string[]  // pass-through tokens for claude
}

function parseRunArgs(raw: string[]): RunFlags {
  const extra = [...raw]
  const take = (flag: string): boolean => {
    const idx = extra.indexOf(flag)
    if (idx === -1) return false
    extra.splice(idx, 1)
    return true
  }
  const skipPermissions = take('--dangerously')
  const freshSession = take('--fresh')
  take('--continue')  // --continue is default; consume to avoid duplication
  return { skipPermissions, freshSession, extraArgs: extra }
}

function buildClaudeArgs(flags: RunFlags, bun: string): string[] {
  const mcpConfig = JSON.stringify({
    mcpServers: {
      wechat: {
        command: bun,
        args: ['run', '--cwd', PLUGIN_DIR, '--silent', 'start'],
      },
    },
  })
  return [
    '--mcp-config', mcpConfig,
    '--dangerously-load-development-channels', 'server:wechat',
    ...(flags.skipPermissions ? ['--dangerously-skip-permissions'] : []),
    ...(flags.freshSession ? [] : ['--continue']),
    ...flags.extraArgs,
  ]
}

interface RestartFlag {
  args: string[]  // empty = inherit current flags
}

// Atomically read + delete the flag file. Returns null if no restart requested.
function readRestartFlag(): RestartFlag | null {
  if (!existsSync(RESTART_FLAG_PATH)) return null
  let content = ''
  try { content = readFileSync(RESTART_FLAG_PATH, 'utf8').trim() } catch {}
  try { rmSync(RESTART_FLAG_PATH) } catch {}
  return { args: content ? content.split(/\s+/) : [] }
}

function run() {
  // Check accounts exist
  if (!existsSync(ACCOUNTS_DIR) || readdirSync(ACCOUNTS_DIR).length === 0) {
    // Check old format too
    if (!existsSync(join(STATE_DIR, '.env'))) {
      console.log('没有已绑定的账号。先运行: wechat-cc setup')
      process.exit(1)
    }
  }

  const bun = getBunPath()

  // Clear any stale flag from a previous crashed run
  if (existsSync(RESTART_FLAG_PATH)) {
    try { rmSync(RESTART_FLAG_PATH) } catch {}
  }

  let currentFlags = parseRunArgs(process.argv.slice(3))
  let fastExits = 0

  while (true) {
    const claudeArgs = buildClaudeArgs(currentFlags, bun)
    const startedAt = Date.now()
    const result = spawnSync('claude', claudeArgs, { stdio: 'inherit' })

    const flag = readRestartFlag()
    if (!flag) {
      // No restart requested — normal exit path (Ctrl+C, claude exited on its own, etc.)
      process.exit(result.status ?? 1)
    }

    // Crash-loop guard: two consecutive <5s exits → bail out
    const elapsed = Date.now() - startedAt
    if (elapsed < 5_000) {
      fastExits++
      if (fastExits >= 2) {
        console.error('[wechat-cc] claude exited twice in <5s; aborting restart loop')
        process.exit(1)
      }
    } else {
      fastExits = 0
    }

    // Empty flag content = inherit current flags; non-empty = replace
    if (flag.args.length > 0) {
      currentFlags = parseRunArgs(flag.args)
    }
    const human = [
      currentFlags.skipPermissions ? '--dangerously' : '',
      currentFlags.freshSession ? '--fresh' : '--continue',
      ...currentFlags.extraArgs,
    ].filter(Boolean).join(' ')
    console.error(`[wechat-cc] restart requested, relaunching with: ${human}`)
  }
}

function help() {
  console.log(`
  wechat-cc — WeChat channel for Claude Code

  命令:
    setup                微信扫码绑定（可多次运行添加多人）
    run                  启动 Claude Code + WeChat（默认恢复上次会话）
    run --fresh          开始全新会话
    run --dangerously    跳过所有权限确认
    list                 列出已绑定账号
    logs                 打开日志监控页面 (默认端口 3456)
    logs <port>          指定端口
    install              在当前目录生成 .mcp.json
    start                启动 MCP channel server（由 .mcp.json 调用）
    help                 显示帮助
`)
}

const command = process.argv[2]

switch (command) {
  case 'setup': {
    const bun = getBunPath()
    const result = spawnSync(bun, [resolve(PLUGIN_DIR, 'setup.ts')], { stdio: 'inherit' })
    process.exit(result.status ?? 1)
  }
  case 'start': {
    const bun = getBunPath()
    const result = spawnSync(bun, [resolve(PLUGIN_DIR, 'server.ts')], { stdio: 'inherit' })
    process.exit(result.status ?? 1)
  }
  case 'run':
    run()
    break
  case 'list':
    listAccounts()
    break
  case 'logs': {
    const bun = getBunPath()
    const port = process.argv[3] ?? '3456'
    const result = spawnSync(bun, [resolve(PLUGIN_DIR, 'log-viewer.ts'), port], { stdio: 'inherit' })
    process.exit(result.status ?? 1)
  }
  case 'install':
    install()
    break
  case 'help':
  case '--help':
  case '-h':
    help()
    break
  default:
    if (command) console.error(`未知命令: ${command}`)
    help()
    process.exit(command ? 1 : 0)
}
