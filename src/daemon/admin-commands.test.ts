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

  function make() {
    return makeAdminCommands({
      stateDir,
      isAdmin: isAdmin as unknown as AdminCommandsDeps['isAdmin'],
      sessionState,
      pollHandle: {
        stopAccount: stopAccount as unknown as AdminCommandsDeps['pollHandle']['stopAccount'],
        running: running as unknown as AdminCommandsDeps['pollHandle']['running'],
      },
      resolveUserName: () => undefined,
      sendMessage: sendMessage as unknown as AdminCommandsDeps['sendMessage'],
      loadHearthApi: loadHearthApi as unknown as NonNullable<AdminCommandsDeps['loadHearthApi']>,
      log: log as unknown as AdminCommandsDeps['log'],
      startedAt: '2026-04-24T00:00:00Z',
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

    expect(stopAccount).toHaveBeenCalledWith('bot-dead-im-bot')
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

    expect(stopAccount).toHaveBeenCalledTimes(2)
    expect(sessionState.listExpired()).toHaveLength(0)
    expect(sentBody()).toContain('清理完成 (2)')
  })

  it('清理 <unknown bot> reports error without side effects', async () => {
    sessionState.markExpired('bot-dead-im-bot')
    const cmds = make()
    await cmds.handle(msg('清理 bot-never-existed-im-bot'))

    expect(stopAccount).not.toHaveBeenCalled()
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
})
