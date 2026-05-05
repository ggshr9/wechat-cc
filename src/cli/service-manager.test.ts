import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildServicePlan, installService } from './service-manager'

describe('service-manager', () => {
  it('builds a macOS LaunchAgent plan', () => {
    const plan = buildServicePlan({
      platform: 'darwin',
      homeDir: '/Users/alice',
      cwd: '/Users/alice/.wechat-cc',
      bunPath: '/opt/homebrew/bin/bun',
      uid: 501,
    })

    expect(plan.kind).toBe('launchagent')
    expect(plan.serviceFile).toBe('/Users/alice/Library/LaunchAgents/com.wechat-cc.daemon.plist')
    expect(plan.installCommands[0]).toEqual(['launchctl', 'bootstrap', 'gui/501', plan.serviceFile])
  })

  it('builds a Windows Scheduled Task plan', () => {
    const plan = buildServicePlan({
      platform: 'win32',
      homeDir: 'C:\\Users\\alice',
      cwd: 'C:\\Users\\alice\\AppData\\Local\\wechat-cc',
      bunPath: 'C:\\Users\\alice\\.bun\\bin\\bun.exe',
      windowsUser: 'alice',
    })

    expect(plan.kind).toBe('scheduled-task')
    expect(plan.serviceName).toBe('wechat-cc')
    // Since v0.5.0 hotfix #3: Windows uses PowerShell *-ScheduledTask cmdlets
    // via -EncodedCommand. schtasks.exe was retired (had blocking failures
    // on Win11 24H2+ with MSA logins).
    expect(plan.installCommands[0]![0]).toBe('powershell.exe')
    expect(plan.installCommands[0]!).toContain('-EncodedCommand')
    // No on-disk XML — PowerShell builds the task definition in-memory
    expect(plan.serviceFile).toBeNull()
    expect(plan.fileContent).toBeNull()
  })

  // Decode a PowerShell -EncodedCommand argv into the underlying script
  // (used by Windows tests below that need to assert on cmdlet args).
  function decodePsScript(cmd: string[]): string {
    const idx = cmd.indexOf('-EncodedCommand')
    if (idx < 0 || !cmd[idx + 1]) return ''
    return Buffer.from(cmd[idx + 1]!, 'base64').toString('utf16le')
  }

  it('builds a Linux systemd user plan', () => {
    const plan = buildServicePlan({
      platform: 'linux',
      homeDir: '/home/alice',
      cwd: '/home/alice/.wechat-cc',
      bunPath: '/home/alice/.bun/bin/bun',
    })

    expect(plan.kind).toBe('systemd-user')
    expect(plan.serviceFile).toBe('/home/alice/.config/systemd/user/wechat-cc.service')
    expect(plan.installCommands).toContainEqual(['systemctl', '--user', 'enable', '--now', 'wechat-cc.service'])
  })

  it('macOS plist defaults to --dangerously (unattended) so daemon does not hang on permission prompts', () => {
    const plan = buildServicePlan({
      platform: 'darwin',
      homeDir: '/Users/alice',
      cwd: '/Users/alice/.wechat-cc',
      bunPath: '/opt/homebrew/bin/bun',
    })
    expect(plan.fileContent).toContain('<string>run</string>')
    expect(plan.fileContent).toContain('<string>--dangerously</string>')
  })

  it('macOS plist omits --dangerously when dangerouslySkipPermissions=false', () => {
    const plan = buildServicePlan({
      platform: 'darwin',
      homeDir: '/Users/alice',
      cwd: '/Users/alice/.wechat-cc',
      bunPath: '/opt/homebrew/bin/bun',
      dangerouslySkipPermissions: false,
    })
    expect(plan.fileContent).toContain('<string>run</string>')
    expect(plan.fileContent).not.toContain('--dangerously')
  })

  it('Windows ScheduledTask Action -Argument includes --dangerously when unattended', () => {
    const plan = buildServicePlan({
      platform: 'win32',
      homeDir: 'C:\\Users\\alice',
      cwd: 'C:\\Users\\alice\\AppData\\Local\\wechat-cc',
      bunPath: 'C:\\bun.exe',
      windowsUser: 'alice',
    })
    const register = plan.installCommands.find(c => decodePsScript(c).includes('Register-ScheduledTask'))!
    const script = decodePsScript(register)
    expect(script).toContain('-Argument')
    expect(script).toContain('run --dangerously')
  })

  it('Windows ScheduledTask passes execPath separately from args (-Execute / -Argument)', () => {
    const plan = buildServicePlan({
      platform: 'win32',
      homeDir: 'C:\\Users\\alice',
      cwd: 'C:\\Users\\alice\\AppData\\Local\\wechat-cc',
      bunPath: 'C:\\bun.exe',
      binaryPath: 'D:\\wechat-cc\\wechat-cc-cli.exe',
      windowsUser: 'alice',
    })
    const script = decodePsScript(plan.installCommands.find(c => decodePsScript(c).includes('Register-ScheduledTask'))!)
    // -Execute and -Argument are separate New-ScheduledTaskAction params
    expect(script).toContain("-Execute 'D:\\wechat-cc\\wechat-cc-cli.exe'")
    expect(script).toContain("-Argument 'run --dangerously'")
  })

  it('Linux systemd ExecStart includes --dangerously when unattended', () => {
    const plan = buildServicePlan({
      platform: 'linux',
      homeDir: '/home/alice',
      cwd: '/home/alice/.wechat-cc',
      bunPath: '/home/alice/.bun/bin/bun',
    })
    expect(plan.fileContent).toContain('cli.ts run --dangerously')
  })

  it('macOS plist defaults to RunAtLoad=true (autoStart default true) + KeepAlive always true', () => {
    const plan = buildServicePlan({
      platform: 'darwin', homeDir: '/Users/alice', cwd: '/Users/alice/.wechat-cc', bunPath: '/opt/homebrew/bin/bun',
    })
    expect(plan.fileContent).toContain('<key>RunAtLoad</key><true/>')
    expect(plan.fileContent).toContain('<key>KeepAlive</key><true/>')
  })

  it('macOS plist with autoStart=false drops RunAtLoad but KeepAlive stays true (crash respawn always on)', () => {
    const plan = buildServicePlan({
      platform: 'darwin', homeDir: '/Users/alice', cwd: '/Users/alice/.wechat-cc', bunPath: '/opt/homebrew/bin/bun',
      autoStart: false,
    })
    expect(plan.fileContent).toContain('<key>RunAtLoad</key><false/>')
    expect(plan.fileContent).toContain('<key>KeepAlive</key><true/>')
  })

  it('Linux unit always includes Restart=always (crash respawn is unconditional)', () => {
    const plan = buildServicePlan({
      platform: 'linux', homeDir: '/home/alice', cwd: '/home/alice/.wechat-cc', bunPath: '/home/alice/.bun/bin/bun',
    })
    expect(plan.fileContent).toContain('Restart=always')
  })

  it('Linux install runs `start` (not `enable --now`) when autoStart=false', () => {
    const plan = buildServicePlan({
      platform: 'linux', homeDir: '/home/alice', cwd: '/home/alice/.wechat-cc', bunPath: '/home/alice/.bun/bin/bun',
      autoStart: false,
    })
    expect(plan.installCommands).toContainEqual(['systemctl', '--user', 'start', 'wechat-cc.service'])
    expect(plan.installCommands).not.toContainEqual(['systemctl', '--user', 'enable', '--now', 'wechat-cc.service'])
  })

  it('Linux uninstall stops (not disable) when autoStart=false (no enable to undo)', () => {
    const plan = buildServicePlan({
      platform: 'linux', homeDir: '/home/alice', cwd: '/home/alice/.wechat-cc', bunPath: '/home/alice/.bun/bin/bun',
      autoStart: false,
    })
    expect(plan.uninstallCommands).toContainEqual(['systemctl', '--user', 'stop', 'wechat-cc.service'])
    expect(plan.uninstallCommands.find(c => c.includes('disable'))).toBeUndefined()
  })

  // autoStart controls the LogonTrigger's Enabled, NOT the whole task's
  // State. We previously used Disable-ScheduledTask which disabled the
  // entire task — the next Start-ScheduledTask would fail with "The task
  // is disabled." Now autoStart=false just sets $trigger.Enabled = $false,
  // so manual Start (this install + future dashboard restart) still works.
  it('Windows trigger.Enabled mirrors autoStart=false (no whole-task Disable)', () => {
    const plan = buildServicePlan({
      platform: 'win32', homeDir: 'C:\\Users\\alice', cwd: 'C:\\app', bunPath: 'C:\\bun.exe',
      windowsUser: 'alice',
      autoStart: false,
    })
    // No Disable-ScheduledTask anywhere — that would disable manual Start
    expect(plan.installCommands.find(c => decodePsScript(c).includes('Disable-ScheduledTask'))).toBeUndefined()
    // Register script sets trigger.Enabled = $false
    const register = decodePsScript(plan.installCommands.find(c => decodePsScript(c).includes('Register-ScheduledTask'))!)
    expect(register).toContain('$trigger.Enabled = $false')
  })

  it('Windows trigger.Enabled = $true when autoStart defaults true', () => {
    const plan = buildServicePlan({
      platform: 'win32', homeDir: 'C:\\Users\\alice', cwd: 'C:\\app', bunPath: 'C:\\bun.exe',
      windowsUser: 'alice',
    })
    const register = decodePsScript(plan.installCommands.find(c => decodePsScript(c).includes('Register-ScheduledTask'))!)
    expect(register).toContain('$trigger.Enabled = $true')
  })

  // Linux/macOS install always start the daemon immediately, regardless of
  // autoStart toggle (which only controls boot-time trigger). Match that on
  // Windows: install always ends with Start-ScheduledTask.
  it('Windows install always ends with Start-ScheduledTask (matches linux/macos semantics)', () => {
    for (const autoStart of [true, false]) {
      const plan = buildServicePlan({
        platform: 'win32', homeDir: 'C:\\Users\\alice', cwd: 'C:\\app', bunPath: 'C:\\bun.exe',
        windowsUser: 'alice',
        autoStart,
      })
      const last = plan.installCommands[plan.installCommands.length - 1]!
      const lastScript = decodePsScript(last)
      expect(lastScript).toContain('Start-ScheduledTask')
    }
  })

  // PowerShell New-ScheduledTaskPrincipal -UserId + -LogonType Interactive
  // is the modern Win11-friendly path: no password prompt, no SeBatchLogonRight
  // requirement, MSA-account-compatible. Saga (all in v0.5.0):
  //   1) schtasks /Create /RU user /F          → password prompt → hang
  //   2) schtasks /Create /RU user /IT /F      → "file not found / access denied"
  //   3) schtasks /Create /RU user /F + S4U XML → still password prompt + S4U needs SeBatchLogonRight
  //   4) PowerShell Register-ScheduledTask     → works clean (CURRENT)
  it('Windows Register-ScheduledTask script uses Interactive LogonType + Limited RunLevel', () => {
    const plan = buildServicePlan({
      platform: 'win32',
      homeDir: 'C:\\Users\\bob',
      cwd: 'C:\\app',
      bunPath: 'C:\\bun.exe',
      windowsUser: 'bob',
    })
    const script = decodePsScript(plan.installCommands.find(c => decodePsScript(c).includes('Register-ScheduledTask'))!)
    expect(script).toContain("-UserId 'bob'")
    expect(script).toContain('-LogonType Interactive')
    expect(script).toContain('-RunLevel Limited')
    // No more schtasks-era flags or password references
    expect(script).not.toContain('schtasks')
    expect(script).not.toContain('S4U')
    expect(script).not.toContain('/IT')
    expect(script).not.toContain('/RP')
  })

  // -EncodedCommand is critical: it's UTF-16 LE base64 — no quoting needed
  // around the script itself, sidesteps every Windows arg-parsing layer
  // (cmd.exe, PowerShell, spawnSync). Regression test: catch any future
  // shift to plain -Command which would re-introduce quoting bugs.
  it('Windows commands use powershell.exe -EncodedCommand with UTF-16 LE base64 payload', () => {
    const plan = buildServicePlan({
      platform: 'win32', homeDir: 'C:\\Users\\bob', cwd: 'C:\\app', bunPath: 'C:\\bun.exe', windowsUser: 'bob',
    })
    for (const cmd of [...plan.installCommands, ...plan.startCommands, ...plan.stopCommands, ...plan.uninstallCommands]) {
      expect(cmd[0]).toBe('powershell.exe')
      expect(cmd).toContain('-NoProfile')
      expect(cmd).toContain('-NonInteractive')
      expect(cmd).toContain('-EncodedCommand')
      // The script is non-empty UTF-16 LE
      const decoded = decodePsScript(cmd)
      expect(decoded.length).toBeGreaterThan(0)
    }
  })

  it('Win32 stopCommands include Stop-ScheduledTask + cmdline match + Wait + force-kill + ready-poll', () => {
    const plan = buildServicePlan({
      platform: 'win32',
      homeDir: 'C:\\Users\\bob',
      cwd: 'C:\\app',
      bunPath: 'C:\\bun.exe',
      windowsUser: 'bob',
    })
    expect(plan.stopCommands).toHaveLength(1)
    const decoded = decodePsScript(plan.stopCommands[0]!)

    expect(decoded).toContain('Stop-ScheduledTask')
    expect(decoded).toMatch(/Get-CimInstance\s+Win32_Process/)
    expect(decoded).toMatch(/CommandLine\s*-match\s*'wechat-cc'/)
    expect(decoded).toContain('WaitForExit(5000)')
    expect(decoded).toMatch(/Stop-Process\s+-Id\s+\$p\.ProcessId\s+-Force/)
    expect(decoded).toMatch(/State\s+-eq\s+'Running'/)  // the poll loop's exit predicate
  })

  it('Win32 install task settings include -AllowHardTerminate $true', () => {
    const plan = buildServicePlan({
      platform: 'win32',
      homeDir: 'C:\\Users\\bob',
      cwd: 'C:\\app',
      bunPath: 'C:\\bun.exe',
      windowsUser: 'bob',
    })
    // installCommands[0] is Register-ScheduledTask; AllowHardTerminate lives
    // inside New-ScheduledTaskSettingsSet in that same script
    const decoded = decodePsScript(plan.installCommands[0]!)
    expect(decoded).toMatch(/AllowHardTerminate\s+\$true/)
  })
})
