import { describe, it, expect, vi } from 'vitest'
import { buildWechatMcpServer, type ToolDeps } from './tools'

function makeDeps(over: Partial<ToolDeps> = {}): ToolDeps {
  return {
    sendReply: vi.fn().mockResolvedValue({ msgId: 'm1' }),
    sendFile: vi.fn().mockResolvedValue(undefined),
    editMessage: vi.fn().mockResolvedValue(undefined),
    broadcast: vi.fn().mockResolvedValue({ ok: 1, failed: 0 }),
    sharePage: vi.fn().mockResolvedValue({ url: 'https://x/abc', slug: 'abc' }),
    resurfacePage: vi.fn().mockResolvedValue({ url: 'https://x/abc', slug: 'abc' }),
    setUserName: vi.fn().mockResolvedValue(undefined),
    projects: {
      list: () => [{ alias: 'P', path: '/p', current: true }],
      switchTo: vi.fn().mockResolvedValue({ ok: true, path: '/p' }),
      add: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    },
    voice: {
      replyVoice: vi.fn().mockResolvedValue({ ok: true, msgId: 'v1' }),
      saveConfig: vi.fn().mockResolvedValue({
        ok: true, tested_ms: 800, provider: 'http_tts', default_voice: 'default',
      }),
      configStatus: () => ({ configured: false as const }),
    },
    companion: {
      enable: vi.fn().mockResolvedValue({
        ok: true,
        state_dir: '/tmp/state',
        personas_scaffolded: ['assistant', 'companion'],
        welcome_message: '开启完成。两个人格已经装好...',
        cost_estimate_note: '每次评估约 $0.01',
      }),
      disable: vi.fn().mockResolvedValue({ ok: true, enabled: false }),
      status: () => ({
        enabled: false,
        timezone: 'Asia/Shanghai',
        default_chat_id: null,
        snooze_until: null,
      }),
      snooze: vi.fn().mockResolvedValue({ ok: true, until: '2026-04-22T13:00:00Z' }),
    },
    memory: {
      read: vi.fn(() => null),
      write: vi.fn(),
      list: vi.fn(() => []),
      delete: vi.fn(),
      rootDir: () => '/tmp/fake-memory',
    },
    ...over,
  }
}

describe('buildWechatMcpServer', () => {
  it('exposes sdk config with name=wechat', () => {
    const { config } = buildWechatMcpServer(makeDeps())
    expect(config.type).toBe('sdk')
    expect(config.name).toBe('wechat')
    expect(config.instance).toBeDefined()
  })

  it('reply tool invokes deps.sendReply', async () => {
    const deps = makeDeps()
    const { handlers } = buildWechatMcpServer(deps)
    const out = await handlers.reply({ chat_id: 'c1', text: 'hi' })
    expect(deps.sendReply).toHaveBeenCalledWith('c1', 'hi')
    expect(out).toMatchObject({ content: [{ type: 'text' }] })
  })

  // share_page / resurface_page tests moved to internal-api.test.ts +
  // integration.test.ts when extracted to wechat-mcp stdio in P1.B B5.
  //
  // list_projects / switch_project / add_project / remove_project /
  // set_user_name tests moved to internal-api.test.ts + integration.test.ts
  // when these tools were extracted to wechat-mcp stdio in P1.B B3.


  it('reply_voice delegates to deps.voice.replyVoice', async () => {
    const deps = makeDeps()
    const { handlers } = buildWechatMcpServer(deps)
    const out = await handlers.reply_voice({ chat_id: 'c', text: '你好' })
    expect(deps.voice.replyVoice).toHaveBeenCalledWith('c', '你好')
    expect(extractText(out)).toContain('msgId')
  })

  it('reply_voice refuses text > 500 chars without calling deps', async () => {
    const deps = makeDeps()
    const { handlers } = buildWechatMcpServer(deps)
    const long = 'x'.repeat(501)
    const out = await handlers.reply_voice({ chat_id: 'c', text: long })
    expect(deps.voice.replyVoice).not.toHaveBeenCalled()
    expect(extractText(out)).toContain('too_long')
  })

  // save_voice_config / voice_config_status tests moved to
  // internal-api.test.ts + integration.test.ts in P1.B B4.

  // companion_* tests moved to internal-api.test.ts + integration.test.ts
  // when these tools were extracted to wechat-mcp stdio in P1.B B6.

  // memory_read / memory_write / memory_list tests moved to:
  //   - src/daemon/internal-api.test.ts          (route handlers)
  //   - src/mcp-servers/wechat/integration.test.ts (end-to-end stdio)
  // when these tools were extracted out of the in-process MCP in P1.B B2.
})

function extractText(result: unknown): string {
  const block = (result as { content?: Array<{ type: string; text?: string }> })?.content?.[0]
  if (!block || block.type !== 'text') throw new Error('expected MCP text content block')
  return block.text ?? ''
}
