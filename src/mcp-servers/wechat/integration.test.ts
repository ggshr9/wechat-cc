import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { createInternalApi, type InternalApi } from '../../daemon/internal-api'
import { makeMemoryFS } from '../../daemon/memory/fs-api'

/**
 * P1.A end-to-end: this test wires up the complete provider→stdio MCP→
 * loopback HTTP→daemon round-trip without involving Claude/Codex SDK.
 * If this passes, the architecture proven in RFC 03 §5 is operational.
 *
 *  ┌─────────────────────────────────────────────────────────────┐
 *  │ test process                                                │
 *  │  ─ MCP Client ────────── stdio ────► wechat-mcp child       │
 *  │      ▲                                  │                   │
 *  │      │ tool result (daemon_pid)         │ HTTP fetch         │
 *  │      │                                  ▼                   │
 *  │  ─ internalApi ◄───────── 127.0.0.1:<port> ────────────────┘ │
 *  └─────────────────────────────────────────────────────────────┘
 *
 * The wechat-mcp child is spawned with WECHAT_INTERNAL_API + WECHAT_INTERNAL_TOKEN_FILE
 * env vars so its hand-off matches what bootstrap.ts wires for production.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const WECHAT_MCP_MAIN = join(HERE, 'main.ts')
// We always spawn wechat-mcp under bun: the source is .ts and uses
// extensionless imports (e.g. `./client`) that node's ESM loader can't
// resolve. Bootstrap.ts in production passes process.execPath because
// the daemon itself runs under bun (`bun src/daemon/main.ts`); tests
// here run under node via vitest, so we hard-code bun. If the test
// machine doesn't have bun on PATH, this expectedly fails fast.
const RUNTIME = 'bun'

describe('wechat-mcp stdio integration', () => {
  let stateDir: string
  let api: InternalApi | null = null
  let client: Client | null = null

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'wechat-mcp-int-'))
  })
  afterEach(async () => {
    if (client) {
      try { await client.close() } catch { /* swallow */ }
      client = null
    }
    if (api) {
      try { await api.stop({ unlinkToken: true }) } catch { /* swallow */ }
      api = null
    }
    rmSync(stateDir, { recursive: true, force: true })
  })

  async function bootChain(): Promise<{ client: Client }> {
    const memory = makeMemoryFS({ rootDir: join(stateDir, 'memory') })
    api = createInternalApi({ stateDir, daemonPid: 7777, memory })
    const { port, tokenFilePath } = await api.start()

    const transport = new StdioClientTransport({
      command: RUNTIME,
      args: [WECHAT_MCP_MAIN],
      env: {
        ...process.env as Record<string, string>,
        WECHAT_INTERNAL_API: `http://127.0.0.1:${port}`,
        WECHAT_INTERNAL_TOKEN_FILE: tokenFilePath,
      },
      stderr: 'pipe',
    })
    const c = new Client({ name: 'integration-test', version: '0.0.1' }, { capabilities: {} })
    await c.connect(transport)
    client = c
    return { client: c }
  }

  it('lists the ping tool via tools/list', async () => {
    const { client } = await bootChain()
    const list = await client.listTools()
    const names = list.tools.map(t => t.name)
    expect(names).toContain('ping')
  })

  it('ping tool round-trips the daemon_pid through the full provider → stdio → HTTP → daemon chain', async () => {
    const { client } = await bootChain()
    const result = await client.callTool({ name: 'ping', arguments: {} })
    expect(result.isError).toBeFalsy()

    // The ping handler returns both a text content block (JSON-encoded) and
    // structuredContent ({ ok, daemon_pid }). Either is fine for the test.
    const sc = result.structuredContent as { ok: boolean; daemon_pid: number } | undefined
    if (sc) {
      expect(sc).toEqual({ ok: true, daemon_pid: 7777 })
      return
    }
    const content = result.content as Array<{ type: string; text?: string }>
    const textBlock = content.find(b => b.type === 'text')
    expect(textBlock).toBeDefined()
    const parsed = JSON.parse(textBlock!.text!) as { ok: boolean; daemon_pid: number }
    expect(parsed).toEqual({ ok: true, daemon_pid: 7777 })
  })

  it('memory_write → memory_read round-trips content through stdio + HTTP + MemoryFS', async () => {
    const { client } = await bootChain()

    const writeResult = await client.callTool({
      name: 'memory_write',
      arguments: { path: 'profile.md', content: '# 用户画像\n端到端写入测试' },
    })
    expect(writeResult.isError).toBeFalsy()
    const writeText = (writeResult.content as Array<{ type: string; text?: string }>)[0]?.text
    expect(JSON.parse(writeText!)).toEqual({ ok: true })

    const readResult = await client.callTool({
      name: 'memory_read',
      arguments: { path: 'profile.md' },
    })
    expect(readResult.isError).toBeFalsy()
    const readText = (readResult.content as Array<{ type: string; text?: string }>)[0]?.text
    expect(JSON.parse(readText!)).toEqual({
      exists: true,
      content: '# 用户画像\n端到端写入测试',
    })
  })

  it('memory_list returns files written via memory_write', async () => {
    const { client } = await bootChain()
    for (const path of ['top.md', 'sub/a.md', 'sub/b.md']) {
      await client.callTool({ name: 'memory_write', arguments: { path, content: 'x' } })
    }
    const listResult = await client.callTool({ name: 'memory_list', arguments: {} })
    expect(listResult.isError).toBeFalsy()
    const listText = (listResult.content as Array<{ type: string; text?: string }>)[0]?.text
    const parsed = JSON.parse(listText!) as { files: string[] }
    expect(parsed.files.sort()).toEqual(['sub/a.md', 'sub/b.md', 'top.md'])
  })

  it('memory_read for missing file surfaces exists:false (legacy wire shape preserved)', async () => {
    const { client } = await bootChain()
    const result = await client.callTool({
      name: 'memory_read',
      arguments: { path: 'never-existed.md' },
    })
    expect(result.isError).toBeFalsy()
    const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text
    expect(JSON.parse(text!)).toEqual({ exists: false })
  })

  it('memory_write with invalid extension surfaces ok:false + error (legacy wire shape preserved)', async () => {
    const { client } = await bootChain()
    const result = await client.callTool({
      name: 'memory_write',
      arguments: { path: 'bad.txt', content: 'x' },
    })
    expect(result.isError).toBeFalsy()
    const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text
    const parsed = JSON.parse(text!) as { ok: boolean; error?: string }
    expect(parsed.ok).toBe(false)
    expect(parsed.error).toMatch(/\.md/i)
  })

  // ── B3: projects + set_user_name end-to-end ─────────────────────────────

  async function bootChainWithProjects(): Promise<{ client: Client; setUserNameCalls: Array<[string, string]>; switchToCalls: string[] }> {
    const memory = makeMemoryFS({ rootDir: join(stateDir, 'memory') })
    const setUserNameCalls: Array<[string, string]> = []
    const switchToCalls: string[] = []
    const projects = {
      list: () => [
        { alias: 'compass', path: '/p/compass', current: true },
        { alias: 'mobile', path: '/p/mobile', current: false },
      ],
      switchTo: async (alias: string) => {
        switchToCalls.push(alias)
        return alias === 'compass' || alias === 'mobile'
          ? { ok: true as const, path: `/p/${alias}` }
          : { ok: false as const, reason: 'alias_not_found' }
      },
      add: async () => {},
      remove: async () => {},
    }
    const setUserName = async (chatId: string, name: string) => { setUserNameCalls.push([chatId, name]) }
    api = createInternalApi({ stateDir, daemonPid: 7777, memory, projects, setUserName })
    const { port, tokenFilePath } = await api.start()
    const transport = new StdioClientTransport({
      command: RUNTIME,
      args: [WECHAT_MCP_MAIN],
      env: {
        ...process.env as Record<string, string>,
        WECHAT_INTERNAL_API: `http://127.0.0.1:${port}`,
        WECHAT_INTERNAL_TOKEN_FILE: tokenFilePath,
      },
      stderr: 'pipe',
    })
    const c = new Client({ name: 'integration-projects', version: '0.0.1' }, { capabilities: {} })
    await c.connect(transport)
    client = c
    return { client: c, setUserNameCalls, switchToCalls }
  }

  it('list_projects round-trips through stdio + HTTP + projects.list()', async () => {
    const { client } = await bootChainWithProjects()
    const result = await client.callTool({ name: 'list_projects', arguments: {} })
    expect(result.isError).toBeFalsy()
    const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text
    const arr = JSON.parse(text!) as Array<{ alias: string; current: boolean }>
    expect(arr).toHaveLength(2)
    expect(arr[0]).toMatchObject({ alias: 'compass', current: true })
  })

  it('switch_project surfaces ok:false reason from server through stdio', async () => {
    const { client, switchToCalls } = await bootChainWithProjects()
    const result = await client.callTool({ name: 'switch_project', arguments: { alias: 'ghost' } })
    expect(result.isError).toBeFalsy()
    const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text
    expect(JSON.parse(text!)).toEqual({ ok: false, reason: 'alias_not_found' })
    expect(switchToCalls).toEqual(['ghost'])
  })

  it('set_user_name forwards chat_id + name through full chain', async () => {
    const { client, setUserNameCalls } = await bootChainWithProjects()
    const result = await client.callTool({
      name: 'set_user_name',
      arguments: { chat_id: 'user@bot', name: '丸子' },
    })
    expect(result.isError).toBeFalsy()
    const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text
    expect(JSON.parse(text!)).toEqual({ ok: true })
    expect(setUserNameCalls).toEqual([['user@bot', '丸子']])
  })

  // ── B4: voice config tools end-to-end ───────────────────────────────────

  // ── B1: ilink-bound message family end-to-end ─────────────────────────

  it('reply / send_file / edit_message / broadcast / reply_voice round-trip through stdio + HTTP + ilink mocks', async () => {
    const memory = makeMemoryFS({ rootDir: join(stateDir, 'memory') })
    const calls: Array<[string, ...unknown[]]> = []
    const ilinkDep = {
      sendReply: async (chatId: string, text: string) => {
        calls.push(['sendReply', chatId, text])
        return { msgId: 'm-reply-1' }
      },
      sendFile: async (chatId: string, path: string) => {
        calls.push(['sendFile', chatId, path])
      },
      editMessage: async (chatId: string, msgId: string, text: string) => {
        calls.push(['editMessage', chatId, msgId, text])
      },
      broadcast: async (text: string, accountId?: string) => {
        calls.push(['broadcast', text, accountId])
        return { ok: 3, failed: 0 }
      },
    }
    const voice = {
      replyVoice: async (chatId: string, text: string) => {
        calls.push(['replyVoice', chatId, text])
        return { ok: true as const, msgId: 'm-voice-1' }
      },
      saveConfig: async (): Promise<{ ok: false; reason: string }> => ({ ok: false, reason: 'unused' }),
      configStatus: () => ({ configured: false as const }),
    }
    api = createInternalApi({ stateDir, daemonPid: 7777, memory, ilink: ilinkDep, voice })
    const { port, tokenFilePath } = await api.start()
    const transport = new StdioClientTransport({
      command: RUNTIME, args: [WECHAT_MCP_MAIN],
      env: {
        ...process.env as Record<string, string>,
        WECHAT_INTERNAL_API: `http://127.0.0.1:${port}`,
        WECHAT_INTERNAL_TOKEN_FILE: tokenFilePath,
      },
      stderr: 'pipe',
    })
    const c = new Client({ name: 'integration-ilink', version: '0.0.1' }, { capabilities: {} })
    await c.connect(transport)
    client = c

    // reply
    const reply = await c.callTool({ name: 'reply', arguments: { chat_id: 'u@bot', text: 'hi' } })
    expect(JSON.parse(((reply.content as Array<{ text?: string }>)[0]?.text)!)).toEqual({
      ok: true, msg_id: 'm-reply-1',
    })
    expect(calls[0]).toEqual(['sendReply', 'u@bot', 'hi'])

    // reply_voice
    const replyVoice = await c.callTool({ name: 'reply_voice', arguments: { chat_id: 'u@bot', text: '念这一段' } })
    expect(JSON.parse(((replyVoice.content as Array<{ text?: string }>)[0]?.text)!)).toEqual({
      ok: true, msgId: 'm-voice-1',
    })
    expect(calls[1]).toEqual(['replyVoice', 'u@bot', '念这一段'])

    // send_file
    const sendFile = await c.callTool({ name: 'send_file', arguments: { chat_id: 'u@bot', path: '/abs/x.pdf' } })
    expect(JSON.parse(((sendFile.content as Array<{ text?: string }>)[0]?.text)!)).toEqual({ ok: true })
    expect(calls[2]).toEqual(['sendFile', 'u@bot', '/abs/x.pdf'])

    // edit_message
    const edit = await c.callTool({
      name: 'edit_message',
      arguments: { chat_id: 'u@bot', msg_id: 'm-1', text: 'edited' },
    })
    expect(JSON.parse(((edit.content as Array<{ text?: string }>)[0]?.text)!)).toEqual({ ok: true })
    expect(calls[3]).toEqual(['editMessage', 'u@bot', 'm-1', 'edited'])

    // broadcast
    const bc = await c.callTool({ name: 'broadcast', arguments: { text: 'hi all' } })
    expect(JSON.parse(((bc.content as Array<{ text?: string }>)[0]?.text)!)).toEqual({ ok: 3, failed: 0 })
    expect(calls[4]).toEqual(['broadcast', 'hi all', undefined])
  })

  it('reply_voice with text > 500 chars surfaces ok:false reason without crossing ilink (legacy cap)', async () => {
    const memory = makeMemoryFS({ rootDir: join(stateDir, 'memory') })
    const replyVoiceCalls: number[] = []
    const voice = {
      replyVoice: async () => { replyVoiceCalls.push(1); return { ok: true as const, msgId: 'should-not-be-called' } },
      saveConfig: async (): Promise<{ ok: false; reason: string }> => ({ ok: false, reason: 'unused' }),
      configStatus: () => ({ configured: false as const }),
    }
    api = createInternalApi({ stateDir, daemonPid: 7777, memory, voice })
    const { port, tokenFilePath } = await api.start()
    const transport = new StdioClientTransport({
      command: RUNTIME, args: [WECHAT_MCP_MAIN],
      env: {
        ...process.env as Record<string, string>,
        WECHAT_INTERNAL_API: `http://127.0.0.1:${port}`,
        WECHAT_INTERNAL_TOKEN_FILE: tokenFilePath,
      },
      stderr: 'pipe',
    })
    const c = new Client({ name: 'integration-voice-cap', version: '0.0.1' }, { capabilities: {} })
    await c.connect(transport)
    client = c

    const result = await c.callTool({
      name: 'reply_voice',
      arguments: { chat_id: 'u@bot', text: 'x'.repeat(501) },
    })
    expect(JSON.parse(((result.content as Array<{ text?: string }>)[0]?.text)!)).toEqual({
      ok: false, reason: 'too_long', limit: 500,
    })
    expect(replyVoiceCalls).toHaveLength(0)  // dep was NOT crossed
  })

  // ── B5: share_page / resurface_page end-to-end ────────────────────────

  it('share_page publishes then resurface_page returns the same record (legacy wire shapes preserved)', async () => {
    const memory = makeMemoryFS({ rootDir: join(stateDir, 'memory') })
    const published = new Map<string, { url: string; slug: string; title: string }>()
    const sharePage = async (
      title: string,
      _content: string,
      opts?: { needs_approval?: boolean; chat_id?: string; account_id?: string },
    ) => {
      const slug = `s-${published.size + 1}`
      const url = `https://share.example/${slug}${opts?.needs_approval ? '?approve=1' : ''}`
      published.set(slug, { url, slug, title })
      return { url, slug }
    }
    const resurfacePage = async (q: { slug?: string; title_fragment?: string }) => {
      if (q.slug && published.has(q.slug)) {
        const r = published.get(q.slug)!
        return { url: r.url, slug: r.slug }
      }
      if (q.title_fragment) {
        for (const r of published.values()) {
          if (r.title.includes(q.title_fragment)) return { url: r.url, slug: r.slug }
        }
      }
      return null
    }
    api = createInternalApi({ stateDir, daemonPid: 7777, memory, sharePage, resurfacePage })
    const { port, tokenFilePath } = await api.start()
    const transport = new StdioClientTransport({
      command: RUNTIME, args: [WECHAT_MCP_MAIN],
      env: {
        ...process.env as Record<string, string>,
        WECHAT_INTERNAL_API: `http://127.0.0.1:${port}`,
        WECHAT_INTERNAL_TOKEN_FILE: tokenFilePath,
      },
      stderr: 'pipe',
    })
    const c = new Client({ name: 'integration-share', version: '0.0.1' }, { capabilities: {} })
    await c.connect(transport)
    client = c

    // Publish
    const pub = await c.callTool({
      name: 'share_page',
      arguments: { title: 'My Plan', content: '# todo\n- x', needs_approval: true },
    })
    const pubBody = JSON.parse(((pub.content as Array<{ text?: string }>)[0]?.text)!) as { url: string; slug: string }
    expect(pubBody.slug).toBe('s-1')
    expect(pubBody.url).toContain('approve=1')

    // Resurface by slug
    const bySlug = await c.callTool({
      name: 'resurface_page',
      arguments: { slug: pubBody.slug },
    })
    expect(JSON.parse(((bySlug.content as Array<{ text?: string }>)[0]?.text)!)).toEqual({
      url: pubBody.url, slug: pubBody.slug,
    })

    // Resurface miss → legacy {ok:false, reason:'not found'} shape
    const miss = await c.callTool({
      name: 'resurface_page',
      arguments: { slug: 'never-existed' },
    })
    expect(JSON.parse(((miss.content as Array<{ text?: string }>)[0]?.text)!)).toEqual({
      ok: false, reason: 'not found',
    })
  })

  // ── B6: companion proactive-tick controls end-to-end ──────────────────

  it('companion enable → snooze → status round-trips through stdio + HTTP', async () => {
    const memory = makeMemoryFS({ rootDir: join(stateDir, 'memory') })
    let enabled = false
    let snoozeUntil: string | null = null
    const companion = {
      enable: async () => {
        const wasEnabled = enabled
        enabled = true
        return wasEnabled
          ? { ok: true as const, already_configured: true as const }
          : { ok: true as const, state_dir: '/state', welcome_message: '开启完成', cost_estimate_note: '~$0.02/tick' }
      },
      disable: async () => { enabled = false; return { ok: true as const, enabled: false as const } },
      status: () => ({
        enabled, timezone: 'Asia/Shanghai',
        default_chat_id: enabled ? 'c1' : null,
        snooze_until: snoozeUntil,
      }),
      snooze: async (minutes: number) => {
        snoozeUntil = new Date(Date.parse('2026-04-22T00:00:00Z') + minutes * 60_000).toISOString()
        return { ok: true as const, until: snoozeUntil }
      },
    }
    api = createInternalApi({ stateDir, daemonPid: 7777, memory, companion })
    const { port, tokenFilePath } = await api.start()
    const transport = new StdioClientTransport({
      command: RUNTIME, args: [WECHAT_MCP_MAIN],
      env: {
        ...process.env as Record<string, string>,
        WECHAT_INTERNAL_API: `http://127.0.0.1:${port}`,
        WECHAT_INTERNAL_TOKEN_FILE: tokenFilePath,
      },
      stderr: 'pipe',
    })
    const c = new Client({ name: 'integration-companion', version: '0.0.1' }, { capabilities: {} })
    await c.connect(transport)
    client = c

    // First enable: welcome_message
    const enable1 = await c.callTool({ name: 'companion_enable', arguments: {} })
    const enable1Body = JSON.parse(((enable1.content as Array<{ text?: string }>)[0]?.text)!) as Record<string, unknown>
    expect(enable1Body.welcome_message).toBe('开启完成')

    // Second enable: already_configured
    const enable2 = await c.callTool({ name: 'companion_enable', arguments: {} })
    expect(JSON.parse(((enable2.content as Array<{ text?: string }>)[0]?.text)!)).toEqual({
      ok: true, already_configured: true,
    })

    // Snooze 60min
    const snooze = await c.callTool({ name: 'companion_snooze', arguments: { minutes: 60 } })
    const snoozeBody = JSON.parse(((snooze.content as Array<{ text?: string }>)[0]?.text)!) as { ok: boolean; until: string }
    expect(snoozeBody.ok).toBe(true)
    expect(snoozeBody.until).toBe('2026-04-22T01:00:00.000Z')

    // Status reflects both
    const status = await c.callTool({ name: 'companion_status', arguments: {} })
    const statusBody = JSON.parse(((status.content as Array<{ text?: string }>)[0]?.text)!) as Record<string, unknown>
    expect(statusBody.enabled).toBe(true)
    expect(statusBody.snooze_until).toBe('2026-04-22T01:00:00.000Z')

    // Disable
    const disable = await c.callTool({ name: 'companion_disable', arguments: {} })
    expect(JSON.parse(((disable.content as Array<{ text?: string }>)[0]?.text)!)).toEqual({
      ok: true, enabled: false,
    })
  })

  it('save_voice_config → voice_config_status round-trips through stdio + HTTP', async () => {
    const memory = makeMemoryFS({ rootDir: join(stateDir, 'memory') })
    let stored: { provider: 'http_tts'; default_voice: string; base_url: string; model: string; saved_at: string } | null = null
    const voice = {
      replyVoice: async (): Promise<{ ok: false; reason: string }> => ({ ok: false, reason: 'unused_in_voice_config_test' }),
      saveConfig: async (input: { provider: 'http_tts' | 'qwen'; base_url?: string; model?: string; default_voice?: string }) => {
        stored = {
          provider: 'http_tts' as const,
          default_voice: input.default_voice ?? 'default',
          base_url: input.base_url!,
          model: input.model!,
          saved_at: new Date('2026-04-22T00:00:00Z').toISOString(),
        }
        return { ok: true as const, tested_ms: 800, provider: input.provider, default_voice: stored.default_voice }
      },
      configStatus: () => stored
        ? { configured: true as const, ...stored }
        : { configured: false as const },
    }
    api = createInternalApi({ stateDir, daemonPid: 7777, memory, voice })
    const { port, tokenFilePath } = await api.start()
    const transport = new StdioClientTransport({
      command: RUNTIME, args: [WECHAT_MCP_MAIN],
      env: {
        ...process.env as Record<string, string>,
        WECHAT_INTERNAL_API: `http://127.0.0.1:${port}`,
        WECHAT_INTERNAL_TOKEN_FILE: tokenFilePath,
      },
      stderr: 'pipe',
    })
    const c = new Client({ name: 'integration-voice', version: '0.0.1' }, { capabilities: {} })
    await c.connect(transport)
    client = c

    // Initially unset
    const status1 = await c.callTool({ name: 'voice_config_status', arguments: {} })
    expect(JSON.parse(((status1.content as Array<{ text?: string }>)[0]?.text)!)).toEqual({ configured: false })

    // Save
    const save = await c.callTool({
      name: 'save_voice_config',
      arguments: { provider: 'http_tts', base_url: 'http://mac:8000/v1/audio/speech', model: 'openbmb/VoxCPM2' },
    })
    const saveBody = JSON.parse(((save.content as Array<{ text?: string }>)[0]?.text)!) as { ok: boolean; tested_ms: number }
    expect(saveBody.ok).toBe(true)
    expect(saveBody.tested_ms).toBe(800)

    // Status now reflects saved config
    const status2 = await c.callTool({ name: 'voice_config_status', arguments: {} })
    const status2Body = JSON.parse(((status2.content as Array<{ text?: string }>)[0]?.text)!) as Record<string, unknown>
    expect(status2Body.configured).toBe(true)
    expect(status2Body.provider).toBe('http_tts')
    expect(status2Body.base_url).toBe('http://mac:8000/v1/audio/speech')
    // never leak api_key
    expect(status2Body.api_key).toBeUndefined()
  })

  it('ping tool returns isError=true when internal-api is unreachable', async () => {
    // Don't start internal-api — point the child at a port that nothing
    // is listening on. The child should still come up (no precondition
    // on api at boot) but the ping call must surface the failure cleanly
    // rather than hang or crash the child.
    const transport = new StdioClientTransport({
      command: RUNTIME,
      args: [WECHAT_MCP_MAIN],
      env: {
        ...process.env as Record<string, string>,
        // Point at port 1 — privileged on linux, fails fast with ECONNREFUSED.
        WECHAT_INTERNAL_API: 'http://127.0.0.1:1',
        WECHAT_INTERNAL_TOKEN_FILE: join(stateDir, 'never-exists'),
      },
      stderr: 'pipe',
    })
    const c = new Client({ name: 'integration-test-noapi', version: '0.0.1' }, { capabilities: {} })
    await c.connect(transport)
    client = c

    const result = await client.callTool({ name: 'ping', arguments: {} })
    expect(result.isError).toBe(true)
    const content = result.content as Array<{ type: string; text?: string }>
    expect(content[0]?.text).toMatch(/ping failed/)
  })
})
