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

  it('share_page returns URL', async () => {
    const deps = makeDeps()
    const { handlers } = buildWechatMcpServer(deps)
    const out = await handlers.share_page({ title: 't', content: '# hi' })
    expect(deps.sharePage).toHaveBeenCalledWith('t', '# hi')
    expect(JSON.stringify(out)).toContain('https://x/abc')
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
    expect(JSON.stringify(out)).toContain('alias not found')
  })

  it('list_projects returns JSON list', async () => {
    const deps = makeDeps()
    const { handlers } = buildWechatMcpServer(deps)
    const out = await handlers.list_projects({})
    expect(JSON.stringify(out)).toContain('"P"')
  })
})
