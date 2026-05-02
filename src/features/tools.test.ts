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

  it('share_page returns URL (no needs_approval → undefined opts)', async () => {
    const deps = makeDeps()
    const { handlers } = buildWechatMcpServer(deps)
    const out = await handlers.share_page({ title: 't', content: '# hi' })
    expect(deps.sharePage).toHaveBeenCalledWith('t', '# hi', undefined)
    expect(extractText(out)).toContain('https://x/abc')
  })

  it('share_page passes needs_approval through to deps when true', async () => {
    const deps = makeDeps()
    const { handlers } = buildWechatMcpServer(deps)
    await handlers.share_page({ title: 't', content: '# hi', needs_approval: true })
    expect(deps.sharePage).toHaveBeenCalledWith('t', '# hi', { needs_approval: true })
  })

  it('share_page omits opts when needs_approval is false (default off)', async () => {
    const deps = makeDeps()
    const { handlers } = buildWechatMcpServer(deps)
    await handlers.share_page({ title: 't', content: '# hi', needs_approval: false })
    expect(deps.sharePage).toHaveBeenCalledWith('t', '# hi', undefined)
  })

  it('switch_project surfaces failure reason', async () => {
    const deps = makeDeps({
      projects: {
        list: () => [],
        switchTo: async () => ({ ok: false, reason: 'alias not found' }),
        add: async () => {},
        remove: async () => {},
      },
    })
    const { handlers } = buildWechatMcpServer(deps)
    const out = await handlers.switch_project({ alias: 'ghost' })
    expect(extractText(out)).toContain('alias not found')
  })

  it('list_projects returns JSON list', async () => {
    const deps = makeDeps()
    const { handlers } = buildWechatMcpServer(deps)
    const out = await handlers.list_projects({})
    const parsed = JSON.parse(extractText(out)) as Array<{ alias: string }>
    expect(parsed).toHaveLength(1)
    expect(parsed[0]?.alias).toBe('P')
  })

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

  it('save_voice_config passes http_tts args through', async () => {
    const deps = makeDeps()
    const { handlers } = buildWechatMcpServer(deps)
    const out = await handlers.save_voice_config({
      provider: 'http_tts',
      base_url: 'http://mac:8000/v1/audio/speech',
      model: 'openbmb/VoxCPM2',
    })
    expect(deps.voice.saveConfig).toHaveBeenCalledWith({
      provider: 'http_tts',
      base_url: 'http://mac:8000/v1/audio/speech',
      model: 'openbmb/VoxCPM2',
    })
    expect(extractText(out)).toContain('tested_ms')
  })

  it('voice_config_status returns current configured state as JSON', async () => {
    const deps = makeDeps({
      voice: {
        replyVoice: vi.fn(),
        saveConfig: vi.fn(),
        configStatus: () => ({
          configured: true as const,
          provider: 'http_tts' as const,
          default_voice: 'default',
          base_url: 'http://mac:8000/v1/audio/speech',
          model: 'openbmb/VoxCPM2',
          saved_at: '2026-04-22T00:00:00Z',
        }),
      },
    } as any)
    const { handlers } = buildWechatMcpServer(deps)
    const out = await handlers.voice_config_status({})
    const parsed = JSON.parse(extractText(out))
    expect(parsed.configured).toBe(true)
    expect(parsed.provider).toBe('http_tts')
    expect(parsed.base_url).toBe('http://mac:8000/v1/audio/speech')
    // never return api_key
    expect(parsed.api_key).toBeUndefined()
  })

  it('companion_enable returns welcome message on first enable', async () => {
    const deps = makeDeps()
    const { handlers } = buildWechatMcpServer(deps)
    const out = await handlers.companion_enable({})
    expect(deps.companion.enable).toHaveBeenCalled()
    expect(extractText(out)).toContain('开启完成')
  })

  it('companion_disable flips enabled=false', async () => {
    const deps = makeDeps()
    const { handlers } = buildWechatMcpServer(deps)
    const out = await handlers.companion_disable({})
    expect(deps.companion.disable).toHaveBeenCalled()
    const parsed = JSON.parse(extractText(out))
    expect(parsed.enabled).toBe(false)
  })

  it('companion_status returns consolidated status as JSON', async () => {
    const deps = makeDeps({
      companion: {
        enable: vi.fn(),
        disable: vi.fn(),
        status: () => ({
          enabled: true,
          timezone: 'Asia/Shanghai',
          per_project_persona: { P: 'assistant' },
          personas_available: [{ name: 'assistant', display_name: '小助手' }],
          triggers: [{ id: 't', project: 'P', schedule: '* * * * *', personas: [], next_fire_at: '2026-04-22T10:00Z' }],
          snooze_until: null,
          pushes_last_24h: 2,
          runs_last_24h: 10,
        }),
        snooze: vi.fn(),
      },
    } as any)
    const { handlers } = buildWechatMcpServer(deps)
    const out = await handlers.companion_status({})
    const parsed = JSON.parse(extractText(out))
    expect(parsed.enabled).toBe(true)
    expect(parsed.triggers).toHaveLength(1)
    expect(parsed.pushes_last_24h).toBe(2)
  })

  it('companion_snooze delegates minutes to deps', async () => {
    const deps = makeDeps()
    const { handlers } = buildWechatMcpServer(deps)
    await handlers.companion_snooze({ minutes: 60 })
    expect(deps.companion.snooze).toHaveBeenCalledWith(60)
  })

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
