import { describe, it, expect } from 'vitest'
import {
  DoctorOutput,
  SetupPollOutput,
  SetupStatusOutput,
  SetupQrJsonOutput,
} from './schema'

describe('DoctorOutput', () => {
  it('accepts a minimal valid report', () => {
    const sample = {
      ready: false,
      stateDir: '/tmp/wechat-cc',
      runtime: 'source',
      wslDetected: false,
      checks: {
        bun: { ok: true, path: '/usr/local/bin/bun' },
        git: { ok: true, path: '/usr/bin/git' },
        claude: { ok: false, path: null, severity: 'hard', fix: { command: 'npm install -g @anthropic-ai/claude-code' } },
        codex: { ok: false, path: null, severity: 'soft' },
        accounts: { ok: false, count: 0, items: [] },
        access: { ok: false, dmPolicy: 'allowlist', allowFromCount: 0 },
        provider: { ok: false, provider: 'claude', binaryPath: null, severity: 'hard' },
        daemon: { alive: false, pid: null },
        service: { installed: false, kind: 'launchagent' },
      },
      userNames: {},
      expiredBots: [],
      nextActions: ['install_claude', 'run_wechat_setup'],
    }
    expect(DoctorOutput.safeParse(sample).success).toBe(true)
  })

  it('accepts a fully-green report with optional fields present', () => {
    const sample = {
      ready: true,
      stateDir: '/home/user/.local/share/wechat-cc',
      runtime: 'compiled-bundle',
      wslDetected: false,
      checks: {
        bun: { ok: true, path: '/usr/local/bin/bun' },
        git: { ok: true, path: '/usr/bin/git' },
        claude: { ok: true, path: '/usr/local/bin/claude' },
        codex: { ok: false, path: null, severity: 'soft' },
        accounts: {
          ok: true,
          count: 1,
          items: [{ id: 'bot1', botId: 'bot1', userId: 'user1', baseUrl: 'https://example.com' }],
        },
        access: { ok: true, dmPolicy: 'allowlist', allowFromCount: 1 },
        provider: { ok: true, provider: 'claude', model: 'claude-opus-4-5', binaryPath: '/usr/local/bin/claude' },
        daemon: { alive: true, pid: 12345 },
        service: { installed: true, kind: 'launchagent' },
      },
      userNames: { 'chat-abc': 'Alice' },
      expiredBots: [{ botId: 'old-bot', firstSeenExpiredAt: '2026-01-01T00:00:00Z', lastReason: 'session expired' }],
      nextActions: [],
    }
    expect(DoctorOutput.safeParse(sample).success).toBe(true)
  })

  it('rejects an empty object', () => {
    expect(DoctorOutput.safeParse({}).success).toBe(false)
  })

  it('rejects a report with invalid runtime value', () => {
    const sample = {
      ready: true,
      stateDir: '/tmp',
      runtime: 'invalid-runtime',
      wslDetected: false,
      checks: {
        bun: { ok: true, path: null },
        git: { ok: true, path: null },
        claude: { ok: true, path: null },
        codex: { ok: true, path: null },
        accounts: { ok: true, count: 0, items: [] },
        access: { ok: true, dmPolicy: 'allowlist', allowFromCount: 0 },
        provider: { ok: true, provider: 'claude', binaryPath: null },
        daemon: { alive: false, pid: null },
        service: { installed: false, kind: 'launchagent' },
      },
      userNames: {},
      expiredBots: [],
      nextActions: [],
    }
    expect(DoctorOutput.safeParse(sample).success).toBe(false)
  })
})

describe('SetupPollOutput', () => {
  it('accepts wait status', () => {
    expect(SetupPollOutput.safeParse({ status: 'wait' }).success).toBe(true)
  })
  it('accepts scaned status', () => {
    expect(SetupPollOutput.safeParse({ status: 'scaned' }).success).toBe(true)
  })
  it('accepts expired status', () => {
    expect(SetupPollOutput.safeParse({ status: 'expired' }).success).toBe(true)
  })
  it('accepts scaned_but_redirect with baseUrl', () => {
    expect(SetupPollOutput.safeParse({ status: 'scaned_but_redirect', baseUrl: 'https://alt.example.com' }).success).toBe(true)
  })
  it('accepts confirmed with accountId and userId', () => {
    expect(SetupPollOutput.safeParse({ status: 'confirmed', accountId: 'bot-123', userId: 'user-456' }).success).toBe(true)
  })
  it('rejects an empty payload', () => {
    expect(SetupPollOutput.safeParse({}).success).toBe(false)
  })
})

describe('SetupStatusOutput', () => {
  it('accepts the snapshot shape', () => {
    expect(SetupStatusOutput.safeParse({
      stateDir: '/tmp/wechat-cc',
      bound: true,
      accounts: [{ id: 'bot-1', botId: 'bot-1', userId: 'user-1', baseUrl: 'https://example.com' }],
      access: { dmPolicy: 'allowlist', allowFrom: ['user-1'] },
      provider: 'claude',
      daemon: { alive: true, pid: 1234 },
      service: { installed: true, kind: 'launchagent' },
    }).success).toBe(true)
  })
  it('accepts the snapshot shape with optional model field', () => {
    expect(SetupStatusOutput.safeParse({
      stateDir: '/tmp/wechat-cc',
      bound: false,
      accounts: [],
      access: { dmPolicy: 'allowlist', allowFrom: [] },
      provider: 'claude',
      model: 'claude-opus-4-5',
      daemon: { alive: false, pid: null },
      service: { installed: false, kind: 'systemd-user' },
    }).success).toBe(true)
  })
  it('rejects an empty payload', () => {
    expect(SetupStatusOutput.safeParse({}).success).toBe(false)
  })
})

describe('SetupQrJsonOutput', () => {
  it('accepts the QR payload shape', () => {
    expect(SetupQrJsonOutput.safeParse({
      qrcode: 'https://qr.example.com/token-abc',
      qrcode_img_content: 'data:image/png;base64,abc123',
      expires_in_ms: 480000,
    }).success).toBe(true)
  })
  it('rejects missing qrcode', () => {
    expect(SetupQrJsonOutput.safeParse({ qrcode_img_content: 'x', expires_in_ms: 480000 }).success).toBe(false)
  })
})
