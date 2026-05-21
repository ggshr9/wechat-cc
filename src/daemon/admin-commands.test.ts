import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { makeAdminCommands, type AdminCommandsDeps } from './admin-commands'
import { makeSessionStateStore } from './session-state'
import { openTestDb, type Db } from '../lib/db'
import type { InboundMsg } from '../core/prompt-format'
import packageJson from '../../package.json'

describe('admin-commands', () => {
  let stateDir: string
  let db: Db
  let sessionState: ReturnType<typeof makeSessionStateStore>
  let sendMessage: ReturnType<typeof vi.fn>
  let stopAccount: ReturnType<typeof vi.fn>
  let stopAccountAndWait: ReturnType<typeof vi.fn>
  let running: ReturnType<typeof vi.fn>
  let isAdmin: ReturnType<typeof vi.fn>
  let log: ReturnType<typeof vi.fn>
  let loadHearthApi: ReturnType<typeof vi.fn>

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'admin-cmd-'))
    db = openTestDb()
    sessionState = makeSessionStateStore(db)
    sendMessage = vi.fn().mockResolvedValue({ msgId: 'm1' })
    stopAccount = vi.fn()
    stopAccountAndWait = vi.fn(async () => {})
    running = vi.fn(() => ['bot-active-1', 'bot-active-2'])
    isAdmin = vi.fn(() => true)
    log = vi.fn()
    loadHearthApi = vi.fn().mockResolvedValue({
      ok: false,
      reason: 'not_found',
      checked: ['hearth'],
    })
  })
  afterEach(() => {
    db.close()
    rmSync(stateDir, { recursive: true, force: true })
  })

  function make(overrides: Partial<AdminCommandsDeps> = {}) {
    return makeAdminCommands({
      stateDir,
      isAdmin: isAdmin as unknown as AdminCommandsDeps['isAdmin'],
      sessionState,
      pollHandle: {
        stopAccount: stopAccount as unknown as AdminCommandsDeps['pollHandle']['stopAccount'],
        stopAccountAndWait: stopAccountAndWait as unknown as AdminCommandsDeps['pollHandle']['stopAccountAndWait'],
        running: running as unknown as AdminCommandsDeps['pollHandle']['running'],
      },
      resolveUserName: () => undefined,
      sendMessage: sendMessage as unknown as AdminCommandsDeps['sendMessage'],
      loadHearthApi: loadHearthApi as unknown as NonNullable<AdminCommandsDeps['loadHearthApi']>,
      log: log as unknown as AdminCommandsDeps['log'],
      startedAt: '2026-04-24T00:00:00Z',
      // Defaults that make legacy tests opt-out of the AI admin surface; new
      // tests inject real fakes via overrides.
      resolveProject: () => null,
      registry: { list: () => [] },
      sessionManager: { release: async () => {}, list: () => [] },
      sessionStore: { get: () => null, delete: () => {} },
      ...overrides,
    })
  }

  function sentBody(call = 0): string {
    const args = sendMessage.mock.calls[call]
    expect(args).toBeDefined()
    return args![1] as string
  }

  function msg(text: string, chatId = 'admin-chat'): InboundMsg {
    return {
      chatId, userId: chatId, accountId: 'bot-active-1',
      text, msgType: 'text', createTimeMs: Date.now(),
    }
  }

  it('returns false for non-matching messages', async () => {
    const cmds = make()
    expect(await cmds.handle(msg('hello'))).toBe(false)
    expect(await cmds.handle(msg('/project list'))).toBe(false)
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('/health with no expired bots shows clean state', async () => {
    const cmds = make()
    expect(await cmds.handle(msg('/health'))).toBe(true)
    expect(sendMessage).toHaveBeenCalledOnce()
    const body = sentBody()
    expect(body).toContain('活跃 bot (2)')
    expect(body).toContain('bot-active-1')
    expect(body).toContain('无过期 bot')
  })

  it('/health with expired bots shows cleanup hint', async () => {
    sessionState.markExpired('bot-dead-im-bot', 'getupdates errcode=-14')
    const cmds = make()
    await cmds.handle(msg('/health'))
    const body = sentBody()
    expect(body).toContain('过期 bot (1)')
    expect(body).toContain('bot-dead-im-bot')
    expect(body).toContain('清理 bot-dead-im-bot')
    expect(body).toContain('清理所有过期')
  })

  it('non-admin sender is silently dropped (no reply)', async () => {
    isAdmin.mockReturnValue(false)
    const cmds = make()
    expect(await cmds.handle(msg('/health'))).toBe(true)  // still consumed
    expect(sendMessage).not.toHaveBeenCalled()             // but no response
    expect(log).toHaveBeenCalledWith('ADMIN_CMD', expect.stringContaining('non-admin'))
  })

  it('清理 <bot-id> removes dir + stops poll + clears state', async () => {
    sessionState.markExpired('bot-dead-im-bot')
    const botDir = join(stateDir, 'accounts', 'bot-dead-im-bot')
    mkdirSync(botDir, { recursive: true })
    writeFileSync(join(botDir, 'token'), 'stale-token')

    const cmds = make()
    await cmds.handle(msg('清理 bot-dead-im-bot'))

    // Phase 3: now uses stopAccountAndWait so the loop's full unwind
    // completes before the rmSync below.
    expect(stopAccountAndWait).toHaveBeenCalledWith('bot-dead-im-bot')
    expect(existsSync(botDir)).toBe(false)
    expect(sessionState.isExpired('bot-dead-im-bot')).toBe(false)
    expect(sentBody()).toContain('清理完成')
  })

  it('清理所有过期 clears multiple at once', async () => {
    sessionState.markExpired('bot-a-im-bot')
    sessionState.markExpired('bot-b-im-bot')
    mkdirSync(join(stateDir, 'accounts', 'bot-a-im-bot'), { recursive: true })
    mkdirSync(join(stateDir, 'accounts', 'bot-b-im-bot'), { recursive: true })

    const cmds = make()
    await cmds.handle(msg('清理所有过期'))

    expect(stopAccountAndWait).toHaveBeenCalledTimes(2)
    expect(sessionState.listExpired()).toHaveLength(0)
    expect(sentBody()).toContain('清理完成 (2)')
  })

  it('清理 <unknown bot> reports error without side effects', async () => {
    sessionState.markExpired('bot-dead-im-bot')
    const cmds = make()
    await cmds.handle(msg('清理 bot-never-existed-im-bot'))

    expect(stopAccountAndWait).not.toHaveBeenCalled()
    expect(sessionState.isExpired('bot-dead-im-bot')).toBe(true)
    expect(sentBody()).toContain('不在过期列表')
  })

  it('does not declare hearth as a hard runtime dependency', () => {
    expect(packageJson.dependencies).not.toHaveProperty('hearth')
  })

  it('/hearth commands report setup guidance when hearth is not installed', async () => {
    const cmds = make()
    expect(await cmds.handle(msg('/hearth list'))).toBe(true)

    expect(loadHearthApi).toHaveBeenCalledOnce()
    expect(sendMessage).toHaveBeenCalledOnce()
    const body = sentBody()
    expect(body).toContain('hearth 未安装或未配置')
    expect(body).toContain('HEARTH_HOME')
    expect(body).toContain('/hearth')
  })

  describe('/reset (AI session reset)', () => {
    it('releases every registered provider\'s in-memory session and clears stored resume ids', async () => {
      const release = vi.fn(async () => {})
      const del = vi.fn()
      const cmds = make({
        resolveProject: () => ({ alias: 'foo', path: '/p/foo' }),
        registry: { list: () => ['claude', 'codex'] },
        sessionManager: { release, list: () => [] },
        sessionStore: { get: () => null, delete: del },
      })
      expect(await cmds.handle(msg('/reset'))).toBe(true)
      // One release call per registered provider, keyed to the chat's alias.
      expect(release).toHaveBeenCalledTimes(2)
      expect(release).toHaveBeenCalledWith('foo', 'claude')
      expect(release).toHaveBeenCalledWith('foo', 'codex')
      // Persisted resume id is wiped so the next dispatch starts fresh.
      expect(del).toHaveBeenCalledWith('foo')
      // User-facing confirmation mentions reset + the chat alias.
      const body = sentBody()
      expect(body).toMatch(/重置|reset/i)
      expect(body).toContain('foo')
    })

    it('/重置 is an accepted alias', async () => {
      const release = vi.fn(async () => {})
      const cmds = make({
        resolveProject: () => ({ alias: 'bar', path: '/p/bar' }),
        registry: { list: () => ['claude'] },
        sessionManager: { release, list: () => [] },
        sessionStore: { get: () => null, delete: () => {} },
      })
      expect(await cmds.handle(msg('/重置'))).toBe(true)
      expect(release).toHaveBeenCalledWith('bar', 'claude')
    })

    it('reports a clear message and no side effects when the chat has no project mapped', async () => {
      const release = vi.fn(async () => {})
      const del = vi.fn()
      const cmds = make({
        resolveProject: () => null,
        registry: { list: () => ['claude'] },
        sessionManager: { release, list: () => [] },
        sessionStore: { get: () => null, delete: del },
      })
      expect(await cmds.handle(msg('/reset'))).toBe(true)
      expect(release).not.toHaveBeenCalled()
      expect(del).not.toHaveBeenCalled()
      expect(sentBody()).toMatch(/未绑定|no project|未映射/i)
    })
  })

  describe('/health ai', () => {
    it('lists every registered provider with stored-session age for the chat', async () => {
      const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString()
      const cmds = make({
        resolveProject: () => ({ alias: 'foo', path: '/p/foo' }),
        registry: { list: () => ['claude', 'codex'] },
        sessionManager: { release: async () => {}, list: () => [] },
        sessionStore: {
          get: (alias, provider) => {
            if (alias === 'foo' && provider === 'claude') {
              return { session_id: 'sid-1', last_used_at: fiveMinAgo, provider: 'claude' }
            }
            return null
          },
          delete: () => {},
        },
      })
      expect(await cmds.handle(msg('/health ai'))).toBe(true)
      const body = sentBody()
      // Both providers appear, with their status.
      expect(body).toContain('claude')
      expect(body).toContain('codex')
      // claude has a session (5m fresh); codex doesn't.
      expect(body).toMatch(/5m|5 min/i)
      expect(body).toMatch(/无.*会话|no.*session/i)
    })

    it('reports gracefully when the chat has no project mapped', async () => {
      const cmds = make({
        resolveProject: () => null,
        registry: { list: () => ['claude'] },
        sessionManager: { release: async () => {}, list: () => [] },
        sessionStore: { get: () => null, delete: () => {} },
      })
      expect(await cmds.handle(msg('/health ai'))).toBe(true)
      expect(sentBody()).toMatch(/未绑定|no project|未映射/i)
    })
  })
})
