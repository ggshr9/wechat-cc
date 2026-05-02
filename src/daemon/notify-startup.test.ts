import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { notifyStartup, renderStartupText } from './notify-startup'

function makeStateDir() {
  return mkdtempSync(join(tmpdir(), 'notify-startup-'))
}

describe('notify-startup', () => {
  it('first-ever startup notifies with the "已启动" template', async () => {
    const stateDir = makeStateDir()
    try {
      const sent: Array<{ chatId: string; text: string }> = []
      const result = await notifyStartup(
        {
          stateDir,
          loadAccess: () => ({ allowFrom: ['owner-wxid'] }),
          send: async (chatId, text) => { sent.push({ chatId, text }) },
          log: () => {},
          now: () => 1_700_000_000_000,
        },
        { pid: 42, accounts: 1, dangerously: true }
      )
      expect(result).toEqual({ notified: true, recipients: ['owner-wxid'], sinceLastMs: null })
      expect(sent).toHaveLength(1)
      expect(sent[0]!.chatId).toBe('owner-wxid')
      expect(sent[0]!.text).toMatch(/已启动/)
      expect(sent[0]!.text).toMatch(/pid=42/)
      expect(sent[0]!.text).toMatch(/✅ unattended/)
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('skips notification when restart is within 60s of previous (KeepAlive crash-loop)', async () => {
    const stateDir = makeStateDir()
    try {
      // First startup persists last-startup.json.
      await notifyStartup(
        { stateDir, loadAccess: () => ({ allowFrom: ['x'] }), send: async () => {}, log: () => {}, now: () => 1_000_000 },
        { pid: 1, accounts: 1, dangerously: true }
      )
      // Restart 5s later.
      const sent: unknown[] = []
      const result = await notifyStartup(
        {
          stateDir,
          loadAccess: () => ({ allowFrom: ['x'] }),
          send: async (...args) => { sent.push(args) },
          log: () => {},
          now: () => 1_005_000,
        },
        { pid: 2, accounts: 1, dangerously: true }
      )
      expect(result.notified).toBe(false)
      expect(result.reason).toBe('too-soon')
      expect(result.sinceLastMs).toBe(5_000)
      expect(sent).toHaveLength(0)
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('renders 重启 template with elapsed time when restart is well after previous', async () => {
    const stateDir = makeStateDir()
    try {
      await notifyStartup(
        { stateDir, loadAccess: () => ({ allowFrom: ['x'] }), send: async () => {}, log: () => {}, now: () => 0 },
        { pid: 1, accounts: 1, dangerously: true }
      )
      const sent: Array<{ chatId: string; text: string }> = []
      const HOUR = 60 * 60 * 1000
      const result = await notifyStartup(
        {
          stateDir,
          loadAccess: () => ({ allowFrom: ['x'] }),
          send: async (chatId, text) => { sent.push({ chatId, text }) },
          log: () => {},
          now: () => 3 * HOUR,
        },
        { pid: 2, accounts: 1, dangerously: false }
      )
      expect(result.notified).toBe(true)
      expect(sent[0]!.text).toMatch(/已重启/)
      expect(sent[0]!.text).toMatch(/3.0 小时前/)
      expect(sent[0]!.text).toMatch(/⚠️ strict/)
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('prefers admins over allowFrom when both present', async () => {
    const stateDir = makeStateDir()
    try {
      const sent: string[] = []
      const result = await notifyStartup(
        {
          stateDir,
          loadAccess: () => ({ allowFrom: ['user-a', 'user-b'], admins: ['admin-x'] }),
          send: async (chatId) => { sent.push(chatId) },
          log: () => {},
        },
        { pid: 1, accounts: 1, dangerously: true }
      )
      expect(result.notified).toBe(true)
      expect(sent).toEqual(['admin-x'])
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('reports no-recipients when access is empty', async () => {
    const stateDir = makeStateDir()
    try {
      const result = await notifyStartup(
        { stateDir, loadAccess: () => ({ allowFrom: [] }), send: async () => {}, log: () => {} },
        { pid: 1, accounts: 0, dangerously: true }
      )
      expect(result).toEqual({ notified: false, reason: 'no-recipients', recipients: [], sinceLastMs: null })
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('reports send-failed-all when every recipient send throws', async () => {
    const stateDir = makeStateDir()
    try {
      const result = await notifyStartup(
        {
          stateDir,
          loadAccess: () => ({ allowFrom: ['owner'] }),
          send: async () => { throw new Error('network down') },
          log: () => {},
        },
        { pid: 1, accounts: 1, dangerously: true }
      )
      expect(result.notified).toBe(false)
      expect(result.reason).toBe('send-failed-all')
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('persists last-startup.json so the next call can compare', async () => {
    const stateDir = makeStateDir()
    try {
      await notifyStartup(
        { stateDir, loadAccess: () => ({ allowFrom: ['x'] }), send: async () => {}, log: () => {}, now: () => 12345 },
        { pid: 99, accounts: 1, dangerously: true }
      )
      const persisted = JSON.parse(readFileSync(join(stateDir, 'last-startup.json'), 'utf8'))
      expect(persisted.ts).toBe(12345)
      expect(persisted.pid).toBe(99)
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('renderStartupText: dangerously toggles the mode tag', () => {
    expect(renderStartupText({ pid: 1, accounts: 1, dangerously: true }, null)).toMatch(/✅ unattended/)
    expect(renderStartupText({ pid: 1, accounts: 1, dangerously: false }, null)).toMatch(/⚠️ strict/)
  })
})
