import { describe, expect, it } from 'vitest'
import { buildServicePlan } from './service-manager'

describe('service-manager', () => {
  it('builds a macOS LaunchAgent plan', () => {
    const plan = buildServicePlan({
      platform: 'darwin',
      homeDir: '/Users/alice',
      cwd: '/Users/alice/.wechat-cc',
      bunPath: '/opt/homebrew/bin/bun',
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
    })

    expect(plan.kind).toBe('scheduled-task')
    expect(plan.serviceName).toBe('wechat-cc')
    expect(plan.installCommands[0]![0]).toBe('schtasks')
    expect(plan.installCommands[0]!).toContain('/Create')
  })

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

  it('Windows ScheduledTask /TR includes --dangerously when unattended', () => {
    const plan = buildServicePlan({
      platform: 'win32',
      homeDir: 'C:\\Users\\alice',
      cwd: 'C:\\Users\\alice\\AppData\\Local\\wechat-cc',
      bunPath: 'C:\\bun.exe',
    })
    const create = plan.installCommands.find(c => c[1] === '/Create')!
    const trIdx = create.indexOf('/TR')
    expect(create[trIdx + 1]).toContain('run --dangerously')
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

  it('macOS plist sets RunAtLoad/KeepAlive true by default (autoStart=true)', () => {
    const plan = buildServicePlan({
      platform: 'darwin', homeDir: '/Users/alice', cwd: '/Users/alice/.wechat-cc', bunPath: '/opt/homebrew/bin/bun',
    })
    expect(plan.fileContent).toContain('<key>RunAtLoad</key><true/>')
    expect(plan.fileContent).toContain('<key>KeepAlive</key><true/>')
  })

  it('macOS plist sets RunAtLoad/KeepAlive false when autoStart=false', () => {
    const plan = buildServicePlan({
      platform: 'darwin', homeDir: '/Users/alice', cwd: '/Users/alice/.wechat-cc', bunPath: '/opt/homebrew/bin/bun',
      autoStart: false,
    })
    expect(plan.fileContent).toContain('<key>RunAtLoad</key><false/>')
    expect(plan.fileContent).toContain('<key>KeepAlive</key><false/>')
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

  it('Windows installCommands include /Change /DISABLE step when autoStart=false', () => {
    const plan = buildServicePlan({
      platform: 'win32', homeDir: 'C:\\Users\\alice', cwd: 'C:\\app', bunPath: 'C:\\bun.exe',
      autoStart: false,
    })
    const disable = plan.installCommands.find(c => c.includes('/Change') && c.includes('/DISABLE'))
    expect(disable).toBeDefined()
  })
})
