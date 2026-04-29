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
