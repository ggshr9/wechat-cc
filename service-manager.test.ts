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

  it('Windows ScheduledTask XML <Arguments> includes --dangerously when unattended', () => {
    const plan = buildServicePlan({
      platform: 'win32',
      homeDir: 'C:\\Users\\alice',
      cwd: 'C:\\Users\\alice\\AppData\\Local\\wechat-cc',
      bunPath: 'C:\\bun.exe',
    })
    expect(plan.fileContent).toContain('<Arguments>')
    expect(plan.fileContent).toContain('run --dangerously')
    // /Create arg list is /XML <path> /F — no /TR arg now
    const create = plan.installCommands.find(c => c[1] === '/Create')!
    expect(create).toContain('/XML')
    expect(create).not.toContain('/TR')
  })

  it('Windows ScheduledTask XML separates Command from Arguments (no quoting hell)', () => {
    const plan = buildServicePlan({
      platform: 'win32',
      homeDir: 'C:\\Users\\alice',
      cwd: 'C:\\Users\\alice\\AppData\\Local\\wechat-cc',
      bunPath: 'C:\\bun.exe',
      binaryPath: 'D:\\wechat-cc\\wechat-cc-cli.exe',
    })
    expect(plan.fileContent).toContain('<Command>D:\\wechat-cc\\wechat-cc-cli.exe</Command>')
    expect(plan.fileContent).toContain('<Arguments>run --dangerously</Arguments>')
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

  it('Windows installCommands include /Change /DISABLE step when autoStart=false', () => {
    const plan = buildServicePlan({
      platform: 'win32', homeDir: 'C:\\Users\\alice', cwd: 'C:\\app', bunPath: 'C:\\bun.exe',
      autoStart: false,
    })
    const disable = plan.installCommands.find(c => c.includes('/Change') && c.includes('/DISABLE'))
    expect(disable).toBeDefined()
  })

  // schtasks /XML on Chinese Windows (and other non-en-US locales)
  // rejects UTF-8 with "无法切换编码" — it requires UTF-16 LE with BOM.
  // Regression: catch any future writeFileSync change that drops the
  // explicit utf16le encoding.
  it('Windows ScheduledTask XML file is written as UTF-16 LE with BOM (0xFF 0xFE)', () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'svcmgr-'))
    try {
      const plan = buildServicePlan({
        platform: 'win32',
        homeDir: tmpHome,
        cwd: join(tmpHome, 'app'),
        bunPath: 'C:\\bun.exe',
      })
      // Stub commands so installService doesn't actually shell out.
      const planNoCmds = { ...plan, installCommands: [] }
      installService(planNoCmds)
      const bytes = readFileSync(plan.serviceFile!)
      // UTF-16 LE BOM is the first two bytes
      expect(bytes[0]).toBe(0xFF)
      expect(bytes[1]).toBe(0xFE)
      // After the BOM, the next bytes should encode '<' (0x3C 0x00) — XML opener
      expect(bytes[2]).toBe(0x3C)
      expect(bytes[3]).toBe(0x00)
    } finally {
      rmSync(tmpHome, { recursive: true, force: true })
    }
  })
})
