import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, platform, userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { findOnPath } from './util'

export type ServicePlatform = 'darwin' | 'win32' | 'linux'
export type ServiceKind = 'launchagent' | 'scheduled-task' | 'systemd-user'

export interface ServicePlanInput {
  platform?: NodeJS.Platform
  homeDir?: string
  cwd: string
  bunPath?: string
  // Pass through to plist/unit `ProgramArguments` so the daemon starts with
  // `cli.ts run --dangerously`. Defaults true: wizard-installed daemons must
  // bypass permission prompts since no human will be there to answer them.
  dangerouslySkipPermissions?: boolean
  // When true (default), the unit registers for auto-start: macOS plist gets
  // RunAtLoad+KeepAlive, systemd is `enable --now`, schtasks uses ONLOGON.
  // When false, the daemon is installed + started ONCE this session but
  // won't come back after reboot (and on macOS won't restart on crash).
  autoStart?: boolean
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
  const serviceName = 'wechat-cc'
  const dangerously = input.dangerouslySkipPermissions ?? true
  const autoStart = input.autoStart ?? true
  const runArgs = dangerously ? ['run', '--dangerously'] : ['run']

  if (pf === 'darwin') {
    const serviceFile = join(homeDir, 'Library', 'LaunchAgents', 'com.wechat-cc.daemon.plist')
    const gui = `gui/${typeof process.getuid === 'function' ? process.getuid() : 501}`
    // autoStart=false: bootstrap+enable+kickstart still runs the daemon now
    // (user clicked "install AND start"), but plist omits RunAtLoad+KeepAlive
    // so it won't auto-start at next login or auto-restart on crash.
    return {
      kind: 'launchagent',
      serviceName,
      serviceFile,
      fileContent: launchAgentPlist({ bunPath, cwd: input.cwd, runArgs, autoStart }),
      installCommands: [['launchctl', 'bootstrap', gui, serviceFile], ['launchctl', 'enable', `${gui}/com.wechat-cc.daemon`], ['launchctl', 'kickstart', '-k', `${gui}/com.wechat-cc.daemon`]],
      startCommands: [['launchctl', 'kickstart', '-k', `${gui}/com.wechat-cc.daemon`]],
      stopCommands: [['launchctl', 'bootout', gui, serviceFile]],
      uninstallCommands: [['launchctl', 'bootout', gui, serviceFile]],
    }
  }

  if (pf === 'win32') {
    const taskRun = `"${bunPath}" "${join(input.cwd, 'cli.ts')}" ${runArgs.join(' ')}`
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

  const serviceFile = join(homeDir, '.config', 'systemd', 'user', 'wechat-cc.service')
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
    fileContent: systemdUnit({ bunPath, cwd: input.cwd, runArgs }),
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

function runCommands(commands: string[][]): void {
  for (const command of commands) {
    const [cmd, ...args] = command
    if (!cmd) continue
    const r = spawnSync(cmd, args, { stdio: 'inherit' })
    if ((r.status ?? 1) !== 0) throw new Error(`${cmd} ${args.join(' ')} failed with exit ${r.status ?? 1}`)
  }
}

function launchAgentPlist(opts: { bunPath: string; cwd: string; runArgs: string[]; autoStart: boolean }): string {
  const argsXml = [opts.bunPath, join(opts.cwd, 'cli.ts'), ...opts.runArgs]
    .map(arg => `    <string>${escapeXml(arg)}</string>`)
    .join('\n')
  const autoLines = opts.autoStart
    ? '  <key>RunAtLoad</key><true/>\n  <key>KeepAlive</key><true/>'
    : '  <key>RunAtLoad</key><false/>\n  <key>KeepAlive</key><false/>'
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

function systemdUnit(opts: { bunPath: string; cwd: string; runArgs: string[] }): string {
  return `[Unit]
Description=wechat-cc daemon

[Service]
Type=simple
WorkingDirectory=${opts.cwd}
ExecStart=${opts.bunPath} ${join(opts.cwd, 'cli.ts')} ${opts.runArgs.join(' ')}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
