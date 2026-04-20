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
 *   wechat-cc reply     — 从终端直接回复微信（MCP 通道不可用时的 fallback）
 */

import { spawn, spawnSync, type ChildProcess } from 'child_process'
import { existsSync, readFileSync, writeFileSync, readdirSync, rmSync, mkdirSync } from 'fs'
import { resolve, join } from 'path'
import { homedir, platform } from 'os'
import { findOnPath } from './util.ts'
import { sendReplyOnce, defaultTerminalChatId } from './send-reply.ts'

// Bun's import.meta.dir gives a proper filesystem path on ALL platforms.
// The old approach (dirname(new URL(import.meta.url).pathname)) produces
// /C:/Users/... on Windows (note leading slash) which breaks git -C and
// other shell commands. import.meta.dir handles this correctly.
const PLUGIN_DIR = import.meta.dir
const STATE_DIR = join(homedir(), '.claude', 'channels', 'wechat')
const ACCOUNTS_DIR = join(STATE_DIR, 'accounts')
const RESTART_FLAG_PATH = join(STATE_DIR, '.restart-flag')
const CURRENT_CWD_FILE = join(STATE_DIR, 'current-cwd')

/** Write the user's real cwd to disk so the MCP server (whose own
 *  process.cwd() is the plugin dir) can read it. Used by server.ts for
 *  currentSessionJsonl lookup, /project status display, and registry
 *  current-field auto-repair. Best-effort — silent on failure. */
function writeCurrentCwd(cwd: string): void {
  try {
    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
    writeFileSync(CURRENT_CWD_FILE, cwd + '\n', { mode: 0o600 })
  } catch { /* non-fatal */ }
}

/** Does the target cwd have an existing Claude Code session jsonl to
 *  --continue from? Claude stores sessions under ~/.claude/projects/<encoded-cwd>/.
 *  If no jsonl exists, forcing --continue fails with "No conversation found to
 *  continue". We use this to pre-flight switch to --fresh instead. */
function hasClaudeSessionIn(cwd: string): boolean {
  const encoded = cwd.replace(/\//g, '-')
  const sessionDir = join(homedir(), '.claude', 'projects', encoded)
  if (!existsSync(sessionDir)) return false
  try {
    return readdirSync(sessionDir).some(f => f.endsWith('.jsonl'))
  } catch {
    return false
  }
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
  const wechatEntry = {
    command: bun,
    args: ['run', '--cwd', PLUGIN_DIR, '--silent', 'start'],
  }

  const scope = process.argv[3] === '--user' || process.argv[3] === '--scope=user'
    ? 'user'
    : 'project'

  if (scope === 'user') {
    // Lazy import so tests that don't need it don't drag fs in
    import('./install-user-mcp.ts').then(({ installUserMcp }) => {
      const configFile = join(homedir(), '.claude.json')
      installUserMcp(configFile, 'wechat', wechatEntry)
      console.log(`已更新用户级 MCP 配置: ${configFile}`)
      console.log('\n下一步: wechat-cc run 或在任意项目中启动 claude')
    }).catch(err => {
      console.error('install --user 失败:', err)
      process.exit(1)
    })
    return
  }

  // Default: project-scope .mcp.json (legacy behavior, unchanged)
  const mcpConfig = {
    mcpServers: {
      wechat: wechatEntry,
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
  console.log('\n提示: 想让 wechat 在所有项目中自动可用？试试 wechat-cc install --user')
}

// ── Argument parsing / building ────────────────────────────────────────────
// Extracted so the supervisor loop can reuse them when /restart arrives with
// a different set of flags.

export interface RunFlags {
  skipPermissions: boolean
  freshSession: boolean
  extraArgs: string[]  // pass-through tokens for claude
}

export function parseRunArgs(raw: string[]): RunFlags {
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

export function buildClaudeArgs(flags: RunFlags, bun: string): string[] {
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
  args: string[]   // empty = inherit current flags
  cwd: string | null  // non-null = chdir before respawn
}

// Atomically read + delete the flag file. Returns null if no restart requested.
// File format:
//   Line 1 may be "cwd=<absolute path>" (optional)
//   Rest is whitespace-separated claude flags (legacy format — single line also works)
function readRestartFlag(): RestartFlag | null {
  if (!existsSync(RESTART_FLAG_PATH)) return null
  let content = ''
  try { content = readFileSync(RESTART_FLAG_PATH, 'utf8').trim() } catch {}
  try { rmSync(RESTART_FLAG_PATH) } catch {}

  let cwd: string | null = null
  let argsText = content
  const lines = content.split('\n').map(l => l.trim())
  if (lines[0]?.startsWith('cwd=')) {
    const maybeCwd = lines[0].slice(4).trim()
    if (maybeCwd) cwd = maybeCwd
    argsText = lines.slice(1).join(' ').trim()
  }
  const args = argsText ? argsText.split(/\s+/) : []
  return { args, cwd }
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
    // Per-iteration state sync with server.ts:
    // 1. Record user's real cwd so server can use it (not process.cwd() which is plugin dir)
    // 2. If --continue but no existing session in this cwd, downgrade to --fresh
    //    just for this iteration (avoid "No conversation found to continue").
    //    Don't mutate currentFlags so next iteration (e.g. restart back to old cwd)
    //    still respects the user's original --continue intent.
    writeCurrentCwd(process.cwd())
    const noSession = !currentFlags.freshSession && !hasClaudeSessionIn(process.cwd())
    if (noSession) {
      console.error(`[wechat-cc] no Claude session history in ${process.cwd()} — using --fresh for this launch`)
    }
    const effectiveFlags: RunFlags = noSession
      ? { ...currentFlags, freshSession: true }
      : currentFlags
    const claudeArgs = buildClaudeArgs(effectiveFlags, bun)
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
      // Pre-flight now downgrades --continue to --fresh when no session
      // exists, so "No conversation found to continue" shouldn't be reached
      // via this code path anymore. Left as a safety net in case future
      // scenarios still trip on it.
      const elapsed = Date.now() - startedAt
      if (
        !isRestart
        && !effectiveFlags.freshSession
        && elapsed < 5_000
        && exitCode !== 0
      ) {
        console.error('')
        console.error('[wechat-cc] claude exited fast — check session state manually if this repeats.')
      }
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
    if (flag.cwd) {
      try {
        process.chdir(flag.cwd)
        console.error(`[wechat-cc] chdir → ${flag.cwd}`)
      } catch (err) {
        console.error(`[wechat-cc] chdir failed for ${flag.cwd}: ${err}. Staying in ${process.cwd()}`)
      }
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

async function replyFromCli(rawArgs: string[]): Promise<void> {
  // Parse `--to <chat_id>` flag; the rest (joined by space) is the text.
  // Example: wechat-cc reply --to abc123 "hello there"
  //          wechat-cc reply "hello" — uses default chat_id.
  let chatId: string | null = null
  const rest: string[] = []
  for (let i = 0; i < rawArgs.length; i++) {
    const a = rawArgs[i]!
    if (a === '--to' || a === '-t') {
      const val = rawArgs[++i]
      if (!val) {
        console.error('--to 需要一个 chat_id 参数')
        process.exit(1)
      }
      chatId = val
    } else {
      rest.push(a)
    }
  }

  if (!chatId) chatId = defaultTerminalChatId()
  if (!chatId) {
    console.error('没有可回复的对象。还没收到过任何微信消息，或者请用 --to <chat_id> 指定。')
    process.exit(1)
  }

  let text = rest.join(' ').trim()
  if (!text) {
    // Support stdin pipe: echo "foo" | wechat-cc reply
    if (!process.stdin.isTTY) {
      const chunks: Buffer[] = []
      for await (const c of process.stdin) chunks.push(c as Buffer)
      text = Buffer.concat(chunks).toString('utf8').trim()
    }
  }
  if (!text) {
    console.error('没有内容可发。用法: wechat-cc reply [--to <chat_id>] "文字"')
    process.exit(1)
  }

  const result = await sendReplyOnce(chatId, text)
  if (result.ok) {
    console.log(`已发送到 ${chatId} (${result.chunks} 段, via account ${result.account})`)
    process.exit(0)
  }
  console.error(`发送失败: ${result.error}`)
  process.exit(1)
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
    install              在当前目录生成 .mcp.json（项目级）
    install --user       注册到 ~/.claude.json（用户级，所有项目可用）
    update               git pull + bun install（需手动 /restart 生效）
    start                启动 MCP channel server（由 .mcp.json 调用）
    reply [--to <id>] <text>
                         从终端直接回复微信（MCP 通道不可用时的 fallback）
    help                 显示帮助
`)
}

// Only run the CLI dispatch when this file is the entry point (not when
// imported by tests or other modules that just want parseRunArgs etc.).
if (import.meta.main) {
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
    case 'reply':
      await replyFromCli(process.argv.slice(3))
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
}
