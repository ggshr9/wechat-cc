import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { makeAdminCommands } from './admin-commands'
import { makeSessionStateStore } from './session-state'
import type { InboundMsg } from '../core/prompt-format'

describe('admin-commands', () => {
  let stateDir: string
  let sessionState: ReturnType<typeof makeSessionStateStore>
  let sendMessage: ReturnType<typeof vi.fn>
  let stopAccount: ReturnType<typeof vi.fn>
  let running: ReturnType<typeof vi.fn>
  let isAdmin: ReturnType<typeof vi.fn>
  let log: ReturnType<typeof vi.fn>

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'admin-cmd-'))
    sessionState = makeSessionStateStore(join(stateDir, 'session-state.json'), { debounceMs: 0 })
    sendMessage = vi.fn().mockResolvedValue({ msgId: 'm1' })
    stopAccount = vi.fn()
    running = vi.fn(() => ['bot-active-1', 'bot-active-2'])
    isAdmin = vi.fn(() => true)
    log = vi.fn()
  })
  afterEach(() => { rmSync(stateDir, { recursive: true, force: true }) })

  function make() {
    return makeAdminCommands({
      stateDir,
      isAdmin,
      sessionState,
      pollHandle: { stopAccount, running },
      resolveUserName: () => undefined,
      sendMessage,
      log,
      startedAt: '2026-04-24T00:00:00Z',
    })
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
    const body = sendMessage.mock.calls[0][1] as string
    expect(body).toContain('活跃 bot (2)')
    expect(body).toContain('bot-active-1')
    expect(body).toContain('无过期 bot')
  })

  it('/health with expired bots shows cleanup hint', async () => {
    sessionState.markExpired('bot-dead-im-bot', 'getupdates errcode=-14')
    const cmds = make()
    await cmds.handle(msg('/health'))
    const body = sendMessage.mock.calls[0][1] as string
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
    expect(sendMessage.mock.calls[0][1]).toContain('清理完成')
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
    expect(sendMessage.mock.calls[0][1]).toContain('清理完成 (2)')
  })

  it('清理 <unknown bot> reports error without side effects', async () => {
    sessionState.markExpired('bot-dead-im-bot')
    const cmds = make()
    await cmds.handle(msg('清理 bot-never-existed-im-bot'))

    expect(stopAccount).not.toHaveBeenCalled()
    expect(sessionState.isExpired('bot-dead-im-bot')).toBe(true)
    expect(sendMessage.mock.calls[0][1]).toContain('不在过期列表')
  })
})
