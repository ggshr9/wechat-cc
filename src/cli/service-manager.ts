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
    // Use schtasks /XML import to sidestep Bun-on-Windows arg-quoting
    // issues (the previous `/TR "path" args` form had spawnSync drop
    // outer quotes, leaving args dangling outside /TR — schtasks then
    // failed with "Access denied" / "file not found"). XML separates
    // <Command> from <Arguments> so quoting is irrelevant.
    //
    // Critical: schtasks /Create /XML needs BOTH a <UserId> element in
    // the XML AND a /RU flag on the command line. With either missing,
    // schtasks errors with "The system cannot find the file specified."
    // followed by "Access is denied." — both noisy generic messages
    // that don't actually point at the missing principal. (Confirmed
    // via Microsoft Learn + community threads on schtasks /XML.)
    const winUser = input.windowsUser ?? userInfo().username
    const command = binaryPath ?? bunPath
    const args = binaryPath
      ? runArgs.join(' ')
      : `"${join(input.cwd, 'cli.ts')}" ${runArgs.join(' ')}`
    const xmlPath = join(homeDir, 'AppData', 'Local', 'Temp', `wechat-cc-task.xml`)
    const xmlContent = buildScheduledTaskXml({ command, args, autoStart, userId: winUser })
    const installCommands: string[][] = [
      // The XML write is an in-memory side effect (handled by installService
      // before runCommands runs) — this command list only contains schtasks
      // calls. We thread the XML content via fileContent, and the file path
      // via serviceFile so installService writes it before /Create.
      //
      // schtasks /Create /XML password / "file not found" history:
      //   v0.5.0 — `/RU user /F` (no /IT, no /RP):
      //     schtasks prompts for the user's password to persist creds
      //     (for "run when not logged on" capability) — prompt has no GUI
      //     in our spawnSync context, hangs forever at "(2/4) 注册...".
      //   v0.5.0 hotfix #1 — added `/IT` (Interactive Token):
      //     skipped the password prompt but emitted the confusing pair
      //     `ERROR: The system cannot find the file specified. /
      //     ERROR: Access is denied.` — `/IT` conflicts with the XML's
      //     Principal section on some Win11 builds.
      //   v0.5.0 hotfix #2 (CURRENT) — drop /IT, switch XML LogonType to S4U:
      //     S4U (Service-for-User) tells Windows to mint a token for the
      //     RU user without storing a password. No password prompt, no /IT
      //     conflict. Task runs whether the user is logged in or not, but
      //     network access is limited to local resources (which is fine
      //     for wechat-cc — daemon talks to localhost ilink + spawns
      //     local Claude Code subprocess).
      ['schtasks', '/Create', '/TN', serviceName, '/XML', xmlPath, '/RU', winUser, '/F'],
    ]
    if (!autoStart) installCommands.push(['schtasks', '/Change', '/TN', serviceName, '/DISABLE'])
    installCommands.push(['schtasks', '/Run', '/TN', serviceName])
    return {
      kind: 'scheduled-task',
      serviceName,
      serviceFile: xmlPath,
      fileContent: xmlContent,
      installCommands,
      startCommands: [['schtasks', '/Run', '/TN', serviceName]],
      stopCommands: [['schtasks', '/End', '/TN', serviceName]],
      uninstallCommands: [['schtasks', '/Delete', '/TN', serviceName, '/F']],
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
    if (plan.kind === 'scheduled-task') {
      // Windows schtasks /XML requires UTF-16 LE with BOM. Bun's
      // writeFileSync defaults to UTF-8 (no BOM) which schtasks
      // rejects on non-en-US locales with "cannot switch encoding".
      // Manually prepend U+FEFF (encodes to 0xFF 0xFE in LE) and
      // serialize the rest as utf16le.
      const utf16Buf = Buffer.from('﻿' + plan.fileContent!, 'utf16le')
      writeFileSync(plan.serviceFile!, utf16Buf, { mode: 0o600 })
    } else {
      writeFileSync(plan.serviceFile!, plan.fileContent!, { mode: 0o600 })
    }
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
// windows — schtasks /Query exits 0 iff the named task exists.
export function isServiceInstalled(plan: ServicePlan): boolean {
  if (plan.serviceFile) return existsSync(plan.serviceFile)
  if (plan.kind === 'scheduled-task') {
    const r = spawnSync('schtasks', ['/Query', '/TN', plan.serviceName], { encoding: 'utf8' })
    return (r.status ?? 1) === 0
  }
  return false
}

/**
 * Build a Windows Scheduled Task XML payload (schtasks /XML format).
 * Avoids the /TR-arg-quoting hell — Command and Arguments live in
 * separate XML elements, so spawnSync arg-list quoting never gets
 * applied to the executable path.
 */
function buildScheduledTaskXml(opts: { command: string; args: string; autoStart: boolean; userId: string }): string {
  const cmdEsc = xmlEsc(opts.command)
  const argsEsc = xmlEsc(opts.args)
  const userEsc = xmlEsc(opts.userId)
  const enabled = opts.autoStart ? 'true' : 'false'
  // schtasks /XML on Windows is strict about encoding — on locales
  // like zh-CN it rejects UTF-8 with "无法切换编码" (cannot switch
  // encoding) regardless of what the declaration claims. Declare
  // UTF-16 here; installService writes the file as UTF-16 LE with a
  // BOM (0xFF 0xFE) so schtasks reads it correctly across locales.
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>wechat-cc daemon — bridges WeChat ilink to Claude Code</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>${enabled}</Enabled>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${userEsc}</UserId>
      <!-- S4U logon: no password needed; pairs with bare /RU /F command-line.
           Skips the password prompt that plain InteractiveToken triggered
           on Win11 in v0.5.0. Network access restricted to local resources
           (fine for wechat-cc; daemon only talks to localhost). -->
      <LogonType>S4U</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>${enabled}</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${cmdEsc}</Command>
      <Arguments>${argsEsc}</Arguments>
    </Exec>
  </Actions>
</Task>
`
}

function xmlEsc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
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
