import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { makeAdminCommands, friendlyDelegateReason, type AdminCommandsDeps } from './admin-commands'
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
      // /botname deps — no-op defaults so legacy tests don't need to care
      getBotName: () => null,
      setBotName: async () => {},
      botNameFallback: () => 'cc',
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
      // /reset releases the admin's own (alias, provider, chatId) sessions.
      expect(release).toHaveBeenCalledWith({ alias: 'foo', providerId: 'claude', chatId: 'admin-chat' })
      expect(release).toHaveBeenCalledWith({ alias: 'foo', providerId: 'codex', chatId: 'admin-chat' })
      // Persisted resume ids for the admin's chat are wiped so the next
      // dispatch from that chat starts fresh.
      expect(del).toHaveBeenCalledWith({ alias: 'foo', chatId: 'admin-chat' })
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
      expect(release).toHaveBeenCalledWith({ alias: 'bar', providerId: 'claude', chatId: 'admin-chat' })
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
          get: ({ alias, provider, chatId }) => {
            // /health ai now reads the admin's own session row.
            if (alias === 'foo' && provider === 'claude' && chatId === 'admin-chat') {
              return { alias, session_id: 'sid-1', last_used_at: fiveMinAgo, provider: 'claude', chat_id: chatId }
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

  describe('整理记忆 (memory synthesis)', () => {
    // runSynthesize is fire-and-forget, so flush the macrotask queue before
    // asserting on the async replies.
    const flush = () => new Promise(r => setTimeout(r, 0))

    it('admin triggers synthesis and replies with the result', async () => {
      const synthesizeMemory = vi.fn().mockResolvedValue({
        projectsFound: 3, projectNames: ['alpha', 'beta', 'gamma'], filesScanned: 9,
        written: { path: '_overview.md', bytesWritten: 500 },
      })
      const cmds = make({ synthesizeMemory: synthesizeMemory as unknown as AdminCommandsDeps['synthesizeMemory'] })
      expect(await cmds.handle(msg('整理记忆'))).toBe(true)
      await flush()
      expect(synthesizeMemory).toHaveBeenCalledWith('admin-chat')
      expect(sendMessage).toHaveBeenCalledTimes(2)
      expect(sentBody(0)).toContain('正在重新整理')
      expect(sentBody(1)).toContain('整理完成')
      expect(sentBody(1)).toContain('alpha')
    })

    it('matches natural-language phrasings and slash aliases', async () => {
      const synthesizeMemory = vi.fn().mockResolvedValue({ projectsFound: 0, projectNames: [], filesScanned: 0 })
      const cmds = make({ synthesizeMemory: synthesizeMemory as unknown as AdminCommandsDeps['synthesizeMemory'] })
      // Distinct chats so the per-chat in-flight guard doesn't drop the later
      // ones — we're only asserting the regex matches each phrasing here.
      const phrases = ['重新整理你对我的理解', '更新记忆', '/synthesize']
      for (let i = 0; i < phrases.length; i++) {
        expect(await cmds.handle(msg(phrases[i]!, `admin-${i}`))).toBe(true)
      }
      await flush()
      expect(synthesizeMemory).toHaveBeenCalledTimes(3)
    })

    it('double-tap is guarded: second trigger waits, only one LLM run', async () => {
      // First run hangs until we release it, so the second tap lands while
      // it's in flight.
      let release: () => void = () => {}
      const gate = new Promise<void>(r => { release = r })
      const synthesizeMemory = vi.fn().mockImplementation(async () => {
        await gate
        return { projectsFound: 1, projectNames: ['x'], filesScanned: 1, written: { path: '_overview.md', bytesWritten: 1 } }
      })
      const cmds = make({ synthesizeMemory: synthesizeMemory as unknown as AdminCommandsDeps['synthesizeMemory'] })
      expect(await cmds.handle(msg('整理记忆'))).toBe(true)
      await flush()  // first run is now awaiting the gate
      expect(await cmds.handle(msg('整理记忆'))).toBe(true)
      await flush()  // second run hits the guard
      expect(synthesizeMemory).toHaveBeenCalledTimes(1)
      expect(sendMessage.mock.calls.some(c => String(c[1]).includes('稍等'))).toBe(true)
      release()
      await flush()
    })

    it('non-admin is consumed but does NOT synthesize or reply', async () => {
      isAdmin.mockReturnValue(false)
      const synthesizeMemory = vi.fn()
      const cmds = make({ synthesizeMemory: synthesizeMemory as unknown as AdminCommandsDeps['synthesizeMemory'] })
      expect(await cmds.handle(msg('整理记忆'))).toBe(true)
      await flush()
      expect(synthesizeMemory).not.toHaveBeenCalled()
      expect(sendMessage).not.toHaveBeenCalled()
    })
  })

  describe('让/派 <hand> 执行/跑 <task> (delegate to a hand)', () => {
    const flush = () => new Promise(r => setTimeout(r, 0))

    it('parses hand + task, calls delegateToHand, replies the result', async () => {
      const delegateToHand = vi.fn().mockResolvedValue({ ok: true, response: '家里 README: 项目X' })
      const cmds = make({ delegateToHand: delegateToHand as unknown as AdminCommandsDeps['delegateToHand'] })
      expect(await cmds.handle(msg('让家里执行 看下README'))).toBe(true)
      await flush()
      expect(delegateToHand).toHaveBeenCalledWith('家里', '看下README')
      expect(sentBody(1)).toContain('家里 README: 项目X')
    })

    it('also matches 派…跑 form and a colon', async () => {
      const delegateToHand = vi.fn().mockResolvedValue({ ok: true, response: 'r' })
      const cmds = make({ delegateToHand: delegateToHand as unknown as AdminCommandsDeps['delegateToHand'] })
      expect(await cmds.handle(msg('派公司跑：跑下测试'))).toBe(true)
      await flush()
      expect(delegateToHand).toHaveBeenCalledWith('公司', '跑下测试')
    })

    it('unknown hand → replies the known list (discovery)', async () => {
      const delegateToHand = vi.fn().mockResolvedValue({ ok: false, reason: 'unknown_hand', knownHands: ['家里', '公司'] })
      const cmds = make({ delegateToHand: delegateToHand as unknown as AdminCommandsDeps['delegateToHand'] })
      await cmds.handle(msg('让火星执行 X'))
      await flush()
      expect(sentBody(1)).toContain('已注册的')
      expect(sentBody(1)).toContain('家里')
    })

    it('unknown hand with NO hands registered → guides to pair one', async () => {
      const delegateToHand = vi.fn().mockResolvedValue({ ok: false, reason: 'unknown_hand', knownHands: [] })
      const cmds = make({ delegateToHand: delegateToHand as unknown as AdminCommandsDeps['delegateToHand'] })
      await cmds.handle(msg('让家里执行 X'))
      await flush()
      expect(sentBody(1)).toContain('hand invite')
      expect(sentBody(1)).not.toContain('unknown_hand')   // no raw code leak
    })

    it('a failure reason is shown in friendly form, not a raw code', async () => {
      const delegateToHand = vi.fn().mockResolvedValue({ ok: false, reason: 'http_401' })
      const cmds = make({ delegateToHand: delegateToHand as unknown as AdminCommandsDeps['delegateToHand'] })
      await cmds.handle(msg('让家里执行 X'))
      await flush()
      expect(sentBody(1)).toContain('重新配对')
    })

    it('not wired → tells the operator it is off', async () => {
      const cmds = make()  // no delegateToHand
      expect(await cmds.handle(msg('让家里执行 X'))).toBe(true)
      await flush()
      expect(sentBody(0)).toContain('派活功能未启用')
    })

    it('non-admin is consumed but does NOT delegate', async () => {
      isAdmin.mockReturnValue(false)
      const delegateToHand = vi.fn()
      const cmds = make({ delegateToHand: delegateToHand as unknown as AdminCommandsDeps['delegateToHand'] })
      expect(await cmds.handle(msg('让家里执行 X'))).toBe(true)
      await flush()
      expect(delegateToHand).not.toHaveBeenCalled()
      expect(sendMessage).not.toHaveBeenCalled()
    })
  })

  describe('/botname command', () => {
    let getBotName: ReturnType<typeof vi.fn>
    let setBotName: ReturnType<typeof vi.fn>
    let botNameFallback: ReturnType<typeof vi.fn>

    function mkMsg(text: string, chatId = 'admin-1'): InboundMsg {
      return {
        chatId, userId: chatId, userName: undefined, accountId: 'a1',
        text, msgType: 'text', createTimeMs: 0,
      }
    }

    function build(): ReturnType<typeof makeAdminCommands> {
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
        resolveProject: () => null,
        registry: { list: () => [] },
        sessionManager: { release: vi.fn(), list: vi.fn(() => []) },
        sessionStore: { get: vi.fn(() => null), delete: vi.fn() },
        log: log as unknown as AdminCommandsDeps['log'],
        startedAt: '2026-05-25T00:00:00.000Z',
        getBotName: getBotName as unknown as AdminCommandsDeps['getBotName'],
        setBotName: setBotName as unknown as AdminCommandsDeps['setBotName'],
        botNameFallback: botNameFallback as unknown as AdminCommandsDeps['botNameFallback'],
      })
    }

    beforeEach(() => {
      getBotName = vi.fn(() => null)
      setBotName = vi.fn(async () => {})
      botNameFallback = vi.fn(() => 'cc')
      isAdmin.mockReturnValue(true)
    })

    it('/botname <valid> from admin → setBotName called + ack', async () => {
      const handler = build()
      const consumed = await handler.handle(mkMsg('/botname 小希'))
      expect(consumed).toBe(true)
      expect(setBotName).toHaveBeenCalledWith('小希')
      expect(sendMessage).toHaveBeenCalledWith('admin-1', expect.stringContaining('小希'))
    })

    it('/botname <valid> from non-admin → silently consumed, no setBotName', async () => {
      isAdmin.mockReturnValue(false)
      const handler = build()
      const consumed = await handler.handle(mkMsg('/botname 偷偷改'))
      expect(consumed).toBe(true)  // matches existing admin-cmd convention: drop silently
      expect(setBotName).not.toHaveBeenCalled()
      expect(sendMessage).not.toHaveBeenCalled()
    })

    it('/botname 跳过 → setBotName(null) + ack with fallback', async () => {
      botNameFallback.mockReturnValue('cc')
      const handler = build()
      await handler.handle(mkMsg('/botname 跳过'))
      expect(setBotName).toHaveBeenCalledWith(null)
      expect(sendMessage).toHaveBeenCalledWith('admin-1', expect.stringContaining('cc'))
    })

    it('/botname (bare, bot_name set) → show current', async () => {
      getBotName.mockReturnValue('小希')
      const handler = build()
      await handler.handle(mkMsg('/botname'))
      expect(setBotName).not.toHaveBeenCalled()
      expect(sendMessage).toHaveBeenCalledWith('admin-1', expect.stringContaining('小希'))
    })

    it('/botname (bare, bot_name null) → show fallback', async () => {
      getBotName.mockReturnValue(null)
      botNameFallback.mockReturnValue('cc')
      const handler = build()
      await handler.handle(mkMsg('/botname'))
      expect(sendMessage).toHaveBeenCalledWith('admin-1', expect.stringContaining('cc'))
    })

    it('/botname <too long> → validation reply, no setBotName', async () => {
      const longName = 'a'.repeat(25)
      const handler = build()
      await handler.handle(mkMsg(`/botname ${longName}`))
      expect(setBotName).not.toHaveBeenCalled()
      expect(sendMessage).toHaveBeenCalledWith('admin-1', expect.stringContaining('太长'))
    })

    it('/botname <illegal chars> → validation reply, no setBotName', async () => {
      const handler = build()
      await handler.handle(mkMsg('/botname 🌸emoji🌸'))
      expect(setBotName).not.toHaveBeenCalled()
      expect(sendMessage).toHaveBeenCalledWith('admin-1', expect.stringContaining('不行'))
    })

    it('setBotName throws → ack with retry hint, no crash', async () => {
      setBotName.mockRejectedValueOnce(new Error('disk full'))
      const handler = build()
      const consumed = await handler.handle(mkMsg('/botname 小希'))
      expect(consumed).toBe(true)
      expect(sendMessage).toHaveBeenCalledWith('admin-1', expect.stringContaining('稍后再试'))
    })

    // Regression guard for the /name vs /botname collision (final-review C1):
    // /name is mode-commands' pre-existing user-self-rename, and admin-commands
    // must NOT consume it — otherwise it'd silently drop non-admin renames and
    // hijack admin's own user-rename. The pipeline runs mw-admin before
    // mw-mode, so admin-commands.handle() must return false for /name to let
    // mw-mode see it.
    it('/name <X> from admin → NOT consumed (falls through to mode-commands)', async () => {
      const handler = build()
      const consumed = await handler.handle(mkMsg('/name Nate'))
      expect(consumed).toBe(false)
      expect(setBotName).not.toHaveBeenCalled()
      expect(sendMessage).not.toHaveBeenCalled()
    })

    it('/name <X> from non-admin → NOT consumed either', async () => {
      isAdmin.mockReturnValue(false)
      const handler = build()
      const consumed = await handler.handle(mkMsg('/name 丸子'))
      expect(consumed).toBe(false)
      expect(setBotName).not.toHaveBeenCalled()
      expect(sendMessage).not.toHaveBeenCalled()
    })
  })
})

describe('friendlyDelegateReason', () => {
  it('maps known reason codes to readable lines', () => {
    expect(friendlyDelegateReason('paused')).toContain('暂停')
    expect(friendlyDelegateReason('timeout')).toContain('超时')
    expect(friendlyDelegateReason('http_401')).toContain('重新配对')
    expect(friendlyDelegateReason('http_500')).toContain('http_500')   // shown verbatim inside the line
    expect(friendlyDelegateReason('fetch failed')).toContain('连不上')
  })
  it('passes through an unrecognized (already-readable) reason', () => {
    expect(friendlyDelegateReason('某个自定义说明')).toBe('某个自定义说明')
  })
})
