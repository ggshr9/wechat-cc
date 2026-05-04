import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, platform, userInfo } from 'node:os'
import { dirname, join, posix } from 'node:path'
import { spawnSync } from 'node:child_process'
import { findOnPath } from '../lib/util'

export type ServicePlatform = 'darwin' | 'win32' | 'linux'
export type ServiceKind = 'launchagent' | 'scheduled-task' | 'systemd-user'

export interface ServicePlanInput {
  platform?: NodeJS.Platform
  homeDir?: string
  cwd: string
  bunPath?: string
  // Path to a self-contained wechat-cc binary (produced by `bun build
  // --compile`). When set, the plist/unit/task uses ExecStart=<binaryPath>
  // run [--dangerously] directly — no bun on PATH required. When omitted,
  // falls back to legacy `bunPath cli.ts run [--dangerously]` for
  // source-checkout users.
  binaryPath?: string
  // Pass through to plist/unit `ProgramArguments` so the daemon starts with
  // `cli.ts run --dangerously`. Defaults true: wizard-installed daemons must
  // bypass permission prompts since no human will be there to answer them.
  dangerouslySkipPermissions?: boolean
  // When true (default), the unit registers for auto-start at login/boot:
  // macOS plist sets RunAtLoad=true, systemd is `enable --now`, schtasks
  // uses an active ONLOGON trigger. When false, the daemon is installed +
  // started ONCE this session but won't come back after reboot.
  autoStart?: boolean
  // macOS-only: override the uid used in the launchctl `gui/<uid>` domain.
  // Tests on non-macOS platforms inject a fixed uid so assertions are
  // deterministic; production reads `process.getuid()`.
  uid?: number
  // Windows-only: SAM account name (e.g. "natewanzi") used for the
  // scheduled-task <UserId> element + /RU flag. Tests on non-Windows
  // platforms inject a fixed value; production reads
  // os.userInfo().username.
  windowsUser?: string
}

export interface ServicePlan {
  kind: ServiceKind
  serviceName: string
  serviceFile: string | null
  fileContent: string | null
  installCommands: string[][]
  startCommands: string[][]
  stopCommands: string[][]
  uninstallCommands: string[][]
}

export function buildServicePlan(input: ServicePlanInput): ServicePlan {
  const pf = input.platform ?? platform()
  const homeDir = input.homeDir ?? homedir()
  const bunPath = input.bunPath ?? findOnPath('bun') ?? 'bun'
  const binaryPath = input.binaryPath
  const serviceName = 'wechat-cc'
  const dangerously = input.dangerouslySkipPermissions ?? true
  const autoStart = input.autoStart ?? true
  const runArgs = dangerously ? ['run', '--dangerously'] : ['run']

  if (pf === 'darwin') {
    // posix.join so plan builds the correct path even when invoked from a
    // Windows test harness (CI cross-platform sweep). The darwin plist path
    // is consumed by launchctl on macOS and must be POSIX regardless of where
    // buildServicePlan() runs.
    const serviceFile = posix.join(homeDir, 'Library', 'LaunchAgents', 'com.wechat-cc.daemon.plist')
    const gui = `gui/${input.uid ?? (typeof process.getuid === 'function' ? process.getuid() : 501)}`
    // autoStart=false: bootstrap+enable+kickstart still runs the daemon now
    // (user clicked "install AND start"), but plist omits RunAtLoad+KeepAlive
    // so it won't auto-start at next login or auto-restart on crash.
    return {
      kind: 'launchagent',
      serviceName,
      serviceFile,
      fileContent: launchAgentPlist({ bunPath, binaryPath, cwd: input.cwd, runArgs, runAtLoad: autoStart }),
      installCommands: [['launchctl', 'bootstrap', gui, serviceFile], ['launchctl', 'enable', `${gui}/com.wechat-cc.daemon`], ['launchctl', 'kickstart', '-k', `${gui}/com.wechat-cc.daemon`]],
      startCommands: [['launchctl', 'kickstart', '-k', `${gui}/com.wechat-cc.daemon`]],
      stopCommands: [['launchctl', 'bootout', gui, serviceFile]],
      uninstallCommands: [['launchctl', 'bootout', gui, serviceFile]],
    }
  }

  if (pf === 'win32') {
    // PowerShell `*-ScheduledTask` cmdlets via -EncodedCommand. Why not
    // schtasks.exe /Create /XML?
    //
    // schtasks /Create /XML went through a 3-attempt saga in v0.5.0 — all
    // hit user-blocking failures on Win11 24H2+ (build 26100+):
    //   1. /RU user /F                       → password prompt → hang
    //   2. /RU user /IT /F                   → "file not found / access denied"
    //   3. /RU user /F + LogonType=S4U       → password prompt again (S4U
    //      command-line behavior is independent of XML; also S4U requires
    //      SeBatchLogonRight which most users lack on Win11)
    //
    // Root cause: schtasks.exe uses the legacy LogonUser API which doesn't
    // play well with Microsoft Account / Azure AD logins (the default on
    // Win11 24H2+). PowerShell's *-ScheduledTask cmdlets use the modern
    // Task Scheduler COM API which does.
    //
    // Trade-off: requires PowerShell 5.1+ to be available (it is, on every
    // Windows 7+ install). Each cmdlet invocation spawns a PS interpreter
    // (~1s overhead vs schtasks's ~50ms), so installing takes ~3-4s instead
    // of ~1s. Worth the 2s for "actually works on every Win11 build".
    const winUser = input.windowsUser ?? userInfo().username
    const command = binaryPath ?? bunPath
    const cmdArgs = binaryPath
      ? runArgs.join(' ')
      : `"${join(input.cwd, 'cli.ts')}" ${runArgs.join(' ')}`
    return {
      kind: 'scheduled-task',
      serviceName,
      // No XML file — PowerShell builds the task definition in-memory.
      serviceFile: null,
      fileContent: null,
      installCommands: powershellInstallCommands({ taskName: serviceName, execPath: command, execArgs: cmdArgs, userName: winUser, autoStart }),
      startCommands: [psCmd(`Start-ScheduledTask -TaskName '${psQuote(serviceName)}'`)],
      stopCommands: [psCmd(`Stop-ScheduledTask -TaskName '${psQuote(serviceName)}'`)],
      uninstallCommands: [psCmd(`Unregister-ScheduledTask -TaskName '${psQuote(serviceName)}' -Confirm:$false`)],
    }
  }

  // posix.join — same rationale as darwin branch above. systemd consumes
  // a POSIX path on Linux regardless of the host where the plan was built.
  const serviceFile = posix.join(homeDir, '.config', 'systemd', 'user', 'wechat-cc.service')
  // autoStart=true → enable --now (boot-time + start now). autoStart=false
  // → just start (no `enable`, won't come back after reboot). Restart=always
  // is in the unit either way, so crash recovery within a session works
  // regardless of the toggle.
  const installCommands: string[][] = [['systemctl', '--user', 'daemon-reload']]
  if (autoStart) installCommands.push(['systemctl', '--user', 'enable', '--now', 'wechat-cc.service'])
  else installCommands.push(['systemctl', '--user', 'start', 'wechat-cc.service'])
  const uninstallCommands: string[][] = autoStart
    ? [['systemctl', '--user', 'disable', '--now', 'wechat-cc.service'], ['systemctl', '--user', 'daemon-reload']]
    : [['systemctl', '--user', 'stop', 'wechat-cc.service'], ['systemctl', '--user', 'daemon-reload']]
  return {
    kind: 'systemd-user',
    serviceName,
    serviceFile,
    fileContent: systemdUnit({ bunPath, binaryPath, cwd: input.cwd, runArgs }),
    installCommands,
    startCommands: [['systemctl', '--user', 'start', 'wechat-cc.service']],
    stopCommands: [['systemctl', '--user', 'stop', 'wechat-cc.service']],
    uninstallCommands,
  }
}

// dryRun=true makes install/uninstall/start/stop pure: no plist on disk, no
// launchctl. The plan is still computed and returned to the caller. Set via
// WECHAT_CC_DRY_RUN=1 (read in cli.ts service handler) so e2e/CI runs against
// the real cli.ts without touching ~/Library/LaunchAgents or launchd.
//
// onProgress is fired BEFORE each step (file write + each install command)
// so a UI driver can display "(M/N) <label>". The wizard wires this via
// install-progress.json so the dashboard can poll real progress instead of
// guessing — install is 5-10s and "卡在哪" is the diagnostic question.
export interface ServiceProgressEvent {
  step: number
  total: number
  label: string
}
export interface ServiceSideEffectOpts {
  dryRun?: boolean
  onProgress?: (e: ServiceProgressEvent) => void
}

/** Human label for a single install command (Chinese — matches existing wizard UX). */
function labelForCommand(cmd: readonly string[]): string {
  const head = cmd[0] ?? ''
  if (head === 'systemctl') {
    if (cmd.includes('daemon-reload')) return 'systemctl daemon-reload'
    if (cmd.includes('enable')) return 'systemctl enable'
    if (cmd.includes('start')) return '启动 systemd 服务'
  }
  if (head === 'launchctl') {
    if (cmd.includes('bootout')) return 'launchctl bootout (清理旧实例)'
    if (cmd.includes('bootstrap')) return 'launchctl bootstrap'
    if (cmd.includes('enable')) return 'launchctl enable'
    if (cmd.includes('kickstart')) return '启动 launchd 服务'
  }
  if (head === 'schtasks') {
    if (cmd.includes('/Create')) return '注册 ScheduledTask'
    if (cmd.includes('/Run')) return '启动 ScheduledTask'
    if (cmd.includes('/Delete')) return '删除旧 ScheduledTask'
  }
  if (head === 'powershell.exe' || head === 'powershell' || head === 'pwsh') {
    // -EncodedCommand argv: ['powershell.exe', '-NoProfile', '-NonInteractive',
    // '-EncodedCommand', '<base64>']. Decode the base64 (UTF-16 LE) so we can
    // identify the cmdlet by name for the user-visible label.
    const idx = cmd.indexOf('-EncodedCommand')
    if (idx >= 0 && cmd[idx + 1]) {
      try {
        const decoded = Buffer.from(cmd[idx + 1]!, 'base64').toString('utf16le')
        if (decoded.includes('Register-ScheduledTask')) return '注册 ScheduledTask'
        if (decoded.includes('Disable-ScheduledTask')) return '禁用自启 (autoStart=off)'
        if (decoded.includes('Start-ScheduledTask')) return '启动 ScheduledTask'
        if (decoded.includes('Stop-ScheduledTask')) return '停止 ScheduledTask'
        if (decoded.includes('Unregister-ScheduledTask')) return '删除 ScheduledTask'
      } catch { /* fall through */ }
    }
    return 'PowerShell ScheduledTask cmdlet'
  }
  return `${head} ${cmd.slice(1, 3).join(' ')}`
}

export function installService(plan: ServicePlan, opts: ServiceSideEffectOpts = {}): void {
  if (opts.dryRun) return
  const hasFile = !!(plan.serviceFile && plan.fileContent)
  const total = (hasFile ? 1 : 0) + plan.installCommands.length
  let step = 0
  const emit = (label: string) => opts.onProgress?.({ step: ++step, total, label })

  if (hasFile) {
    emit('写入服务定义文件')
    mkdirSync(dirname(plan.serviceFile!), { recursive: true, mode: 0o700 })
    // Windows used to need UTF-16 LE + BOM here (schtasks /XML quirk on
    // non-en-US locales). Since v0.5.0+ Windows uses PowerShell cmdlets
    // with no on-disk file, so this branch only runs for systemd / launchd
    // unit files (plain UTF-8).
    writeFileSync(plan.serviceFile!, plan.fileContent!, { mode: 0o600 })
  }
  for (const cmd of plan.installCommands) {
    emit(labelForCommand(cmd))
    runCommands([cmd])
  }
}

export function startService(plan: ServicePlan, opts: ServiceSideEffectOpts = {}): void {
  if (opts.dryRun) return
  const r = tryRunCommands(plan.startCommands)
  if (r.ok) return
  // launchctl kickstart fails (exit 113 on darwin) when the service isn't
  // currently registered in the user's GUI domain — typical right after
  // `service stop` (which boots out the plist) or after launchd dropped the
  // service for any reason. Re-run the full bootstrap+enable+kickstart from
  // installCommands so a "stop → start" round-trip self-heals instead of
  // dead-ending with "Could not find service" until the user reinstalls.
  if (plan.kind === 'launchagent') {
    runCommands(plan.installCommands)
    return
  }
  throw new Error(`${r.command[0]} ${r.command.slice(1).join(' ')} failed with exit ${r.exitCode}`)
}

export function stopService(plan: ServicePlan, opts: ServiceSideEffectOpts = {}): void {
  if (opts.dryRun) return
  runCommands(plan.stopCommands)
}

export function uninstallService(plan: ServicePlan, opts: ServiceSideEffectOpts = {}): void {
  if (opts.dryRun) return
  runCommands(plan.uninstallCommands)
  if (plan.serviceFile) rmSync(plan.serviceFile, { force: true })
}

// Probe whether the service unit/plist/scheduled-task this plan targets is
// currently registered. Decoupled from "is the daemon process alive": a
// service can be installed but stopped, and a daemon can run outside any
// service (foreground `bun cli.ts run`). The GUI restart button + update
// flow both rely on this distinction to render correct prompts.
//
// linux/macOS — file existence at the unit/plist path. The service-manager
// owns that file (writes it during install, removes it during uninstall),
// so file presence is authoritative.
// windows — Get-ScheduledTask via PowerShell exits 0 iff the named task exists.
export function isServiceInstalled(plan: ServicePlan): boolean {
  if (plan.serviceFile) return existsSync(plan.serviceFile)
  if (plan.kind === 'scheduled-task') {
    const cmd = psCmd(`if (Get-ScheduledTask -TaskName '${psQuote(plan.serviceName)}' -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }`)
    const r = spawnSync(cmd[0]!, cmd.slice(1), { encoding: 'utf8' })
    return (r.status ?? 1) === 0
  }
  return false
}

/**
 * Escape a string for safe inclusion inside PowerShell single quotes.
 * Single quotes inside single-quoted strings are escaped by doubling: `'` → `''`.
 * Used for task names, paths, and usernames before interpolation into PS scripts.
 */
function psQuote(s: string): string {
  return s.replace(/'/g, "''")
}

/**
 * Wrap a PowerShell one-liner into a `powershell.exe -EncodedCommand <b64>`
 * argv array. -EncodedCommand takes UTF-16 LE base64; this sidesteps every
 * Windows arg-quoting subtlety (cmd.exe pre-parses, PowerShell re-parses,
 * and any embedded quote/backtick can derail one or the other).
 */
function psCmd(script: string): string[] {
  const utf16 = Buffer.from(script, 'utf16le')
  const b64 = utf16.toString('base64')
  return ['powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand', b64]
}

/**
 * Build the install-time PowerShell commands. Returns 1-2 commands:
 *   1. Register-ScheduledTask  (always)
 *   2. Disable-ScheduledTask   (only when autoStart=false — matches the
 *      old XML's <Enabled>false</Enabled> semantics)
 *   3. Start-ScheduledTask     (always — equivalent to old `schtasks /Run`,
 *      kicks off the daemon immediately so user doesn't need to log out
 *      to see it running)
 *
 * Each command is its own PS invocation so the install-progress.json
 * trail shows distinct phases ("(2/4) 注册 ScheduledTask" etc).
 */
function powershellInstallCommands(opts: { taskName: string; execPath: string; execArgs: string; userName: string; autoStart: boolean }): string[][] {
  const tn = psQuote(opts.taskName)
  const exe = psQuote(opts.execPath)
  const args = psQuote(opts.execArgs)
  const usr = psQuote(opts.userName)
  const register = `
$action    = New-ScheduledTaskAction    -Execute '${exe}' -Argument '${args}'
$trigger   = New-ScheduledTaskTrigger   -AtLogOn -User '${usr}'
$principal = New-ScheduledTaskPrincipal -UserId '${usr}' -LogonType Interactive -RunLevel Limited
$settings  = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName '${tn}' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
`.trim()
  const out: string[][] = [psCmd(register)]
  if (!opts.autoStart) out.push(psCmd(`Disable-ScheduledTask -TaskName '${tn}' | Out-Null`))
  out.push(psCmd(`Start-ScheduledTask -TaskName '${tn}'`))
  return out
}

function runCommands(commands: string[][]): void {
  for (const command of commands) {
    const [cmd, ...args] = command
    if (!cmd) continue
    const r = spawnSync(cmd, args, { stdio: 'inherit' })
    if ((r.status ?? 1) !== 0) throw new Error(`${cmd} ${args.join(' ')} failed with exit ${r.status ?? 1}`)
  }
}

// Variant that returns failure instead of throwing — startService uses this
// to detect a launchctl-not-loaded state and retry via installCommands.
function tryRunCommands(commands: string[][]): { ok: true } | { ok: false; exitCode: number; command: string[] } {
  for (const command of commands) {
    const [cmd, ...args] = command
    if (!cmd) continue
    const r = spawnSync(cmd, args, { stdio: 'inherit' })
    const code = r.status ?? 1
    if (code !== 0) return { ok: false, exitCode: code, command }
  }
  return { ok: true }
}

function launchAgentPlist(opts: { bunPath: string; binaryPath?: string; cwd: string; runArgs: string[]; runAtLoad: boolean }): string {
  const argv = opts.binaryPath
    ? [opts.binaryPath, ...opts.runArgs]
    : [opts.bunPath, join(opts.cwd, 'cli.ts'), ...opts.runArgs]
  const argsXml = argv
    .map(arg => `    <string>${escapeXml(arg)}</string>`)
    .join('\n')
  // KeepAlive is always true: a crashed daemon should be auto-respawned. It
  // used to be a user-facing toggle but no one wanted it off — power users
  // can edit the plist by hand if they really need crash-stays-dead semantics.
  const autoLines =
    `  <key>RunAtLoad</key><${opts.runAtLoad ? 'true' : 'false'}/>\n` +
    `  <key>KeepAlive</key><true/>`
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.wechat-cc.daemon</string>
  <key>ProgramArguments</key><array>
${argsXml}
  </array>
  <key>WorkingDirectory</key><string>${escapeXml(opts.cwd)}</string>
${autoLines}
</dict></plist>
`
}

function systemdUnit(opts: { bunPath: string; binaryPath?: string; cwd: string; runArgs: string[] }): string {
  const execStart = opts.binaryPath
    ? `${opts.binaryPath} ${opts.runArgs.join(' ')}`
    : `${opts.bunPath} ${join(opts.cwd, 'cli.ts')} ${opts.runArgs.join(' ')}`
  // Restart=always is unconditional now (used to be tied to a keepAlive
  // toggle). Crash-respawn is always-on; power users edit the unit by hand
  // if they really want crash-stays-dead semantics.
  return `[Unit]
Description=wechat-cc daemon

[Service]
Type=simple
WorkingDirectory=${opts.cwd}
ExecStart=${execStart}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
