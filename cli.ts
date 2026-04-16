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

import { spawn, spawnSync, type ChildProcess } from 'child_process'
import { existsSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'fs'
import { resolve, dirname, join } from 'path'
import { homedir, platform } from 'os'

const PLUGIN_DIR = dirname(new URL(import.meta.url).pathname)
const STATE_DIR = join(homedir(), '.claude', 'channels', 'wechat')
const ACCOUNTS_DIR = join(STATE_DIR, 'accounts')
const RESTART_FLAG_PATH = join(STATE_DIR, '.restart-flag')

// Cross-platform PATH lookup: use `where` on Windows, `which` elsewhere.
// Returns the first matching absolute path, or null.
function findOnPath(cmd: string): string | null {
  const finder = platform() === 'win32' ? 'where' : 'which'
  try {
    const r = spawnSync(finder, [cmd], { stdio: 'pipe' })
    if (r.status === 0) {
      const out = r.stdout?.toString() ?? ''
      const first = out.split(/\r?\n/)[0]?.trim()
      if (first) return first
    }
  } catch {}
  return null
}

function getBunPath(): string {
  const found = findOnPath('bun')
  if (found) return found
  // Fallback: default Bun install location (handles users who installed
  // Bun but haven't added it to PATH yet). On Windows the binary is
  // bun.exe; on Linux/macOS it has no extension.
  const isWin = platform() === 'win32'
  return join(homedir(), '.bun', 'bin', isWin ? 'bun.exe' : 'bun')
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
  // Normalize em/en dashes back to `--` — WeChat/iOS keyboards autocorrect
  // `--` into `—` (U+2014), and we don't want that to silently break flag
  // parsing when the args come from a `.restart-flag` written by server.ts.
  const extra = raw.map(a => a.replace(/^[—–]/, '--'))
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

async function run() {
  // Check accounts exist
  if (!existsSync(ACCOUNTS_DIR) || readdirSync(ACCOUNTS_DIR).length === 0) {
    // Check old format too
    if (!existsSync(join(STATE_DIR, '.env'))) {
      console.log('没有已绑定的账号。先运行: wechat-cc setup')
      process.exit(1)
    }
  }

  // Soft-warn once per launch if expect(1) is missing — /restart will still
  // work, but the user will have to walk back to the terminal and press Enter
  // through claude's dev-channel dialog on every relaunch.
  if (platform() === 'win32') {
    console.error('[wechat-cc] 提示：Windows 平台没有 expect(1) 替代品，WeChat 触发的 /restart 需要你在终端手动按一次回车通过 Claude Code 的开发通道确认框。')
  } else if (findOnPath('expect') == null) {
    console.error('[wechat-cc] 提示：未检测到 expect，WeChat 触发的 /restart 将无法自动通过 Claude Code 的开发通道确认框。安装方法：apt install expect / brew install expect')
  }

  const bun = getBunPath()

  // Clear any stale flag from a previous crashed run
  if (existsSync(RESTART_FLAG_PATH)) {
    try { rmSync(RESTART_FLAG_PATH) } catch {}
  }

  let currentFlags = parseRunArgs(process.argv.slice(3))
  let fastExits = 0
  let isRestart = false

  while (true) {
    const claudeArgs = buildClaudeArgs(currentFlags, bun)
    const startedAt = Date.now()

    // Spawn claude (or expect-wrapped claude on restart with expect available).
    // Using async spawn() instead of spawnSync() so we can simultaneously poll
    // for .restart-flag. This is the key architectural choice that makes
    // /restart work on ALL platforms without process-tree walking: cli.ts
    // already holds the child handle, so it kills claude directly via
    // child.kill() when server.ts signals a restart via the flag file.
    const child = spawnClaude(claudeArgs, isRestart)

    // Poll for .restart-flag every 500ms while claude is running.
    // server.ts writes this file when it receives /restart from WeChat,
    // then we kill claude from here. No findClaudeAncestor, no /proc,
    // no wmic, no ps — works identically on Linux, macOS, and Windows.
    let flagDetected = false
    const flagPoll = setInterval(() => {
      if (existsSync(RESTART_FLAG_PATH)) {
        flagDetected = true
        clearInterval(flagPoll)
        try { child.kill() } catch {}
      }
    }, 500)

    // Wait for child to exit (normally, via Ctrl-C, or because we killed it)
    const exitCode = await new Promise<number>((resolve) => {
      child.on('exit', (code) => resolve(code ?? 1))
    })

    clearInterval(flagPoll)

    const flag = readRestartFlag()
    if (!flag) {
      // Normal exit — no restart requested
      process.exit(exitCode)
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

    if (flag.args.length > 0) {
      currentFlags = parseRunArgs(flag.args)
    }
    const human = [
      currentFlags.skipPermissions ? '--dangerously' : '',
      currentFlags.freshSession ? '--fresh' : '--continue',
      ...currentFlags.extraArgs,
    ].filter(Boolean).join(' ')
    console.error(`[wechat-cc] restart requested, relaunching with: ${human}`)
    isRestart = true
  }
}

/**
 * Spawn claude (or an expect wrapper around claude on /restart).
 *
 * On restart with expect available (Linux/macOS): wraps claude in expect(1)
 * to auto-confirm the --dangerously-load-development-channels dialog via
 * three timed \r sends (800ms / 2000ms / 4000ms). interact runs from the
 * first byte to avoid DA-query garbling.
 *
 * On first launch, or on Windows, or without expect: plain spawn with
 * stdio inherited — user presses Enter manually on the dialog.
 */
function spawnClaude(claudeArgs: string[], isRestart: boolean): ChildProcess {
  const useExpect = isRestart
    && platform() !== 'win32'
    && findOnPath('expect') != null

  if (useExpect) {
    const tclArgs = claudeArgs.map(a => `{${a}}`).join(' ')
    const expectScript = `
set timeout -1
spawn -noecho claude ${tclArgs}
after 800  { catch { send "\\r" } }
after 2000 { catch { send "\\r" } }
after 4000 { catch { send "\\r" } }
interact { eof { return } }
catch wait result
exit [lindex $result 3]
`
    return spawn('expect', ['-c', expectScript], { stdio: 'inherit' })
  }

  return spawn('claude', claudeArgs, { stdio: 'inherit' })
}

function update() {
  const bunLockPath = join(PLUGIN_DIR, 'bun.lock')
  const beforeLock = existsSync(bunLockPath) ? readFileSync(bunLockPath, 'utf8') : ''

  // Fast-forward only — we never want to auto-merge diverging histories.
  // If the user has local edits that conflict, fail loud and tell them to
  // resolve manually instead of silently stepping on their work.
  console.log('[wechat-cc] git pull --ff-only ...')
  const pull = spawnSync('git', ['-C', PLUGIN_DIR, 'pull', '--ff-only'], { stdio: 'inherit' })
  if (pull.status !== 0) {
    console.error('')
    console.error('[wechat-cc] git pull 失败。可能是：')
    console.error('  - 有本地未提交的改动')
    console.error('  - 非 fast-forward（你的本地 commit 和 origin 分叉了）')
    console.error('  - 没有网络 / 仓库无权限')
    console.error('请在 ' + PLUGIN_DIR + ' 手动处理后重跑。')
    process.exit(pull.status ?? 1)
  }

  // Only re-install if bun.lock actually changed; skipping install when
  // nothing depends on it saves 5-10 seconds on a typical pull.
  const afterLock = existsSync(bunLockPath) ? readFileSync(bunLockPath, 'utf8') : ''
  if (afterLock !== beforeLock) {
    console.log('[wechat-cc] bun.lock 变化，重装依赖 ...')
    const install = spawnSync('bun', ['install'], { cwd: PLUGIN_DIR, stdio: 'inherit' })
    if (install.status !== 0) {
      console.error('[wechat-cc] bun install 失败，请手动处理。')
      process.exit(install.status ?? 1)
    }
  } else {
    console.log('[wechat-cc] bun.lock 未变化，跳过 bun install')
  }

  console.log('')
  console.log('[wechat-cc] 升级完成。')
  console.log('  当前 server 仍在跑旧代码。要生效请：')
  console.log('    - 在微信发 /restart（推荐，无需手动按回车）')
  console.log('    - 或在终端 Ctrl+C 后重新 wechat-cc run')
  process.exit(0)
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
    update               git pull + bun install（需手动 /restart 生效）
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
    await run()
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
  case 'update':
    update()
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
