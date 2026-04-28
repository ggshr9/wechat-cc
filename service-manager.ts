import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, platform, userInfo } from 'node:os'
import { dirname, join, posix } from 'node:path'
import { spawnSync } from 'node:child_process'
import { findOnPath } from './util'

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
  // When true (default), the daemon respawns on crash: macOS plist sets
  // KeepAlive=true, systemd unit gets `Restart=always`. When false, a
  // crashed daemon stays dead until the user restarts it. Decoupled from
  // autoStart per user request 2026-04-28: 推荐打开 (recommended on).
  keepAlive?: boolean
  // macOS-only: override the uid used in the launchctl `gui/<uid>` domain.
  // Tests on non-macOS platforms inject a fixed uid so assertions are
  // deterministic; production reads `process.getuid()`.
  uid?: number
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
  // keepAlive defaults to autoStart so callers that only pass `autoStart`
  // get the pre-2026-04-28 behavior unchanged. New callers (GUI) pass both.
  const keepAlive = input.keepAlive ?? autoStart
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
      fileContent: launchAgentPlist({ bunPath, binaryPath, cwd: input.cwd, runArgs, runAtLoad: autoStart, keepAlive }),
      installCommands: [['launchctl', 'bootstrap', gui, serviceFile], ['launchctl', 'enable', `${gui}/com.wechat-cc.daemon`], ['launchctl', 'kickstart', '-k', `${gui}/com.wechat-cc.daemon`]],
      startCommands: [['launchctl', 'kickstart', '-k', `${gui}/com.wechat-cc.daemon`]],
      stopCommands: [['launchctl', 'bootout', gui, serviceFile]],
      uninstallCommands: [['launchctl', 'bootout', gui, serviceFile]],
    }
  }

  if (pf === 'win32') {
    const taskRun = binaryPath
      ? `"${binaryPath}" ${runArgs.join(' ')}`
      : `"${bunPath}" "${join(input.cwd, 'cli.ts')}" ${runArgs.join(' ')}`
    // autoStart=false on Windows: create the task disabled (no ONLOGON
    // trigger fires), then explicitly /Run it once for this session.
    const installCommands: string[][] = [['schtasks', '/Create', '/TN', serviceName, '/SC', 'ONLOGON', '/TR', taskRun, '/F']]
    if (!autoStart) installCommands.push(['schtasks', '/Change', '/TN', serviceName, '/DISABLE'])
    installCommands.push(['schtasks', '/Run', '/TN', serviceName])
    return {
      kind: 'scheduled-task',
      serviceName,
      serviceFile: null,
      fileContent: null,
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
    fileContent: systemdUnit({ bunPath, binaryPath, cwd: input.cwd, runArgs, keepAlive }),
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
export interface ServiceSideEffectOpts {
  dryRun?: boolean
}

export function installService(plan: ServicePlan, opts: ServiceSideEffectOpts = {}): void {
  if (opts.dryRun) return
  if (plan.serviceFile && plan.fileContent) {
    mkdirSync(dirname(plan.serviceFile), { recursive: true, mode: 0o700 })
    writeFileSync(plan.serviceFile, plan.fileContent, { mode: 0o600 })
  }
  runCommands(plan.installCommands)
}

export function startService(plan: ServicePlan, opts: ServiceSideEffectOpts = {}): void {
  if (opts.dryRun) return
  runCommands(plan.startCommands)
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

function runCommands(commands: string[][]): void {
  for (const command of commands) {
    const [cmd, ...args] = command
    if (!cmd) continue
    const r = spawnSync(cmd, args, { stdio: 'inherit' })
    if ((r.status ?? 1) !== 0) throw new Error(`${cmd} ${args.join(' ')} failed with exit ${r.status ?? 1}`)
  }
}

function launchAgentPlist(opts: { bunPath: string; binaryPath?: string; cwd: string; runArgs: string[]; runAtLoad: boolean; keepAlive: boolean }): string {
  const argv = opts.binaryPath
    ? [opts.binaryPath, ...opts.runArgs]
    : [opts.bunPath, join(opts.cwd, 'cli.ts'), ...opts.runArgs]
  const argsXml = argv
    .map(arg => `    <string>${escapeXml(arg)}</string>`)
    .join('\n')
  const autoLines =
    `  <key>RunAtLoad</key><${opts.runAtLoad ? 'true' : 'false'}/>\n` +
    `  <key>KeepAlive</key><${opts.keepAlive ? 'true' : 'false'}/>`
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

function systemdUnit(opts: { bunPath: string; binaryPath?: string; cwd: string; runArgs: string[]; keepAlive: boolean }): string {
  const execStart = opts.binaryPath
    ? `${opts.binaryPath} ${opts.runArgs.join(' ')}`
    : `${opts.bunPath} ${join(opts.cwd, 'cli.ts')} ${opts.runArgs.join(' ')}`
  // keepAlive=false → omit Restart= so a crashed daemon stays dead. We
  // still set Type/WorkingDirectory/ExecStart unconditionally; toggling
  // Restart is the only knob users care about here.
  const restartLines = opts.keepAlive ? 'Restart=always\nRestartSec=5\n' : ''
  return `[Unit]
Description=wechat-cc daemon

[Service]
Type=simple
WorkingDirectory=${opts.cwd}
ExecStart=${execStart}
${restartLines}
[Install]
WantedBy=default.target
`
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
