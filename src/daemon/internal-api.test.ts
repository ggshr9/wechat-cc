import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createInternalApi, type InternalApi } from './internal-api'
import { makeMemoryFS } from './memory/fs-api'

describe('internal-api', () => {
  let stateDir: string
  let api: InternalApi | null = null

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'internal-api-'))
  })
  afterEach(async () => {
    if (api) await api.stop()
    api = null
    rmSync(stateDir, { recursive: true, force: true })
  })

  async function start(): Promise<{ port: number; tokenFilePath: string; token: string }> {
    api = createInternalApi({ stateDir, daemonPid: 12345 })
    const { port, tokenFilePath } = await api.start()
    const token = readFileSync(tokenFilePath, 'utf8').trim()
    return { port, tokenFilePath, token }
  }

  it('binds to 127.0.0.1 on a random port and writes a 64-hex token file', async () => {
    const { port, tokenFilePath, token } = await start()
    expect(port).toBeGreaterThan(0)
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    const st = statSync(tokenFilePath)
    // Mode bits: must be readable/writable by owner only (0600). Mask with
    // 0o777 to drop file-type bits.
    expect((st.mode & 0o777).toString(8)).toBe('600')
  })

  it('GET /v1/health with valid bearer token returns ok=true and daemon_pid', async () => {
    const { port, token } = await start()
    const resp = await fetch(`http://127.0.0.1:${port}/v1/health`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(resp.status).toBe(200)
    const body = await resp.json() as { ok: boolean; daemon_pid: number }
    expect(body.ok).toBe(true)
    expect(body.daemon_pid).toBe(12345)
  })

  it('returns 401 without Authorization header', async () => {
    const { port } = await start()
    const resp = await fetch(`http://127.0.0.1:${port}/v1/health`)
    expect(resp.status).toBe(401)
    const body = await resp.json() as { error: string }
    expect(body.error).toBe('unauthorized')
  })

  it('returns 401 with wrong bearer token', async () => {
    const { port } = await start()
    const resp = await fetch(`http://127.0.0.1:${port}/v1/health`, {
      headers: { Authorization: 'Bearer 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' },
    })
    expect(resp.status).toBe(401)
  })

  it('returns 401 with malformed Authorization header', async () => {
    const { port } = await start()
    const resp = await fetch(`http://127.0.0.1:${port}/v1/health`, {
      headers: { Authorization: 'Basic foo' },
    })
    expect(resp.status).toBe(401)
  })

  it('returns 401 when token has wrong byte length (defense against truncation)', async () => {
    const { port } = await start()
    const resp = await fetch(`http://127.0.0.1:${port}/v1/health`, {
      headers: { Authorization: 'Bearer abcd' },
    })
    expect(resp.status).toBe(401)
  })

  it('returns 404 on unknown route (with valid token)', async () => {
    const { port, token } = await start()
    const resp = await fetch(`http://127.0.0.1:${port}/v1/unknown-route`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(resp.status).toBe(404)
    const body = await resp.json() as { error: string }
    expect(body.error).toBe('not_found')
  })

  it('start() twice rejects with explicit error', async () => {
    api = createInternalApi({ stateDir, daemonPid: 1 })
    await api.start()
    await expect(api.start()).rejects.toThrow(/already started/)
  })

  it('stop({ unlinkToken: true }) removes the token file', async () => {
    const { tokenFilePath } = await start()
    expect(existsSync(tokenFilePath)).toBe(true)
    await api!.stop({ unlinkToken: true })
    api = null
    expect(existsSync(tokenFilePath)).toBe(false)
  })

  it('stop() leaves token file in place by default', async () => {
    const { tokenFilePath } = await start()
    await api!.stop()
    api = null
    expect(existsSync(tokenFilePath)).toBe(true)
  })

  it('rotates the token across restarts (each start() generates a fresh one)', async () => {
    const t1 = await start()
    await api!.stop()
    api = null
    const t2 = await start()
    expect(t2.token).not.toBe(t1.token)
    expect(t2.token).toMatch(/^[0-9a-f]{64}$/)
  })

  // ─── memory_* routes (RFC 03 P1.B B2) ─────────────────────────────────

  describe('memory routes', () => {
    let memoryRoot: string
    async function startWithMemory(): Promise<{ port: number; token: string }> {
      memoryRoot = join(stateDir, 'memory')
      const memory = makeMemoryFS({ rootDir: memoryRoot })
      api = createInternalApi({ stateDir, daemonPid: 999, memory })
      const { port, tokenFilePath } = await api.start()
      const token = readFileSync(tokenFilePath, 'utf8').trim()
      return { port, token }
    }

    it('POST /v1/memory/write then /v1/memory/read round-trips content', async () => {
      const { port, token } = await startWithMemory()
      const writeResp = await fetch(`http://127.0.0.1:${port}/v1/memory/write`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ path: 'profile.md', content: '# hello\nfrom test' }),
      })
      expect(writeResp.status).toBe(200)
      expect(await writeResp.json()).toEqual({ ok: true })

      const readResp = await fetch(`http://127.0.0.1:${port}/v1/memory/read`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ path: 'profile.md' }),
      })
      expect(readResp.status).toBe(200)
      expect(await readResp.json()).toEqual({ exists: true, content: '# hello\nfrom test' })
    })

    it('POST /v1/memory/read returns exists:false for missing file', async () => {
      const { port, token } = await startWithMemory()
      const resp = await fetch(`http://127.0.0.1:${port}/v1/memory/read`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ path: 'nope.md' }),
      })
      expect(resp.status).toBe(200)
      expect(await resp.json()).toEqual({ exists: false })
    })

    it('POST /v1/memory/read returns 400 when path missing', async () => {
      const { port, token } = await startWithMemory()
      const resp = await fetch(`http://127.0.0.1:${port}/v1/memory/read`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(resp.status).toBe(400)
      expect(await resp.json()).toMatchObject({ error: 'path_required' })
    })

    it('POST /v1/memory/write returns ok:false + error on FS rejection (e.g. .txt extension)', async () => {
      const { port, token } = await startWithMemory()
      const resp = await fetch(`http://127.0.0.1:${port}/v1/memory/write`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ path: 'bad.txt', content: 'x' }),
      })
      // MemoryFS errors are caught and surfaced in the body shape — agent
      // sees the failure mode rather than a transport-layer crash.
      expect(resp.status).toBe(200)
      const body = await resp.json() as { ok: boolean; error?: string }
      expect(body.ok).toBe(false)
      expect(body.error).toMatch(/\.md/i)
    })

    it('GET /v1/memory/list returns files written so far', async () => {
      const { port, token } = await startWithMemory()
      // Seed two files
      for (const p of ['a.md', 'sub/b.md']) {
        await fetch(`http://127.0.0.1:${port}/v1/memory/write`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ path: p, content: 'x' }),
        })
      }
      const resp = await fetch(`http://127.0.0.1:${port}/v1/memory/list`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(resp.status).toBe(200)
      const body = await resp.json() as { files: string[] }
      expect(body.files.sort()).toEqual(['a.md', 'sub/b.md'])
    })

    it('GET /v1/memory/list?dir=sub scopes to subdirectory', async () => {
      const { port, token } = await startWithMemory()
      for (const p of ['top.md', 'sub/x.md', 'sub/y.md']) {
        await fetch(`http://127.0.0.1:${port}/v1/memory/write`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ path: p, content: 'x' }),
        })
      }
      const resp = await fetch(`http://127.0.0.1:${port}/v1/memory/list?dir=sub`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(resp.status).toBe(200)
      const body = await resp.json() as { files: string[] }
      expect(body.files.sort()).toEqual(['sub/x.md', 'sub/y.md'])
    })

    it('memory routes return 503 when memory dep is not wired', async () => {
      api = createInternalApi({ stateDir, daemonPid: 1 })  // no memory
      const { port, tokenFilePath } = await api.start()
      const token = readFileSync(tokenFilePath, 'utf8').trim()
      const resp = await fetch(`http://127.0.0.1:${port}/v1/memory/list`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(resp.status).toBe(503)
      expect(await resp.json()).toEqual({ error: 'memory_fs_not_wired' })
    })
  })

  it('returns 400 on malformed JSON body', async () => {
    const memory = makeMemoryFS({ rootDir: join(stateDir, 'memory') })
    api = createInternalApi({ stateDir, daemonPid: 1, memory })
    const { port, tokenFilePath } = await api.start()
    const token = readFileSync(tokenFilePath, 'utf8').trim()
    const resp = await fetch(`http://127.0.0.1:${port}/v1/memory/read`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: 'not-json{',
    })
    expect(resp.status).toBe(400)
    expect(await resp.json()).toMatchObject({ error: 'malformed_json' })
  })

  // ─── projects + user_name routes (RFC 03 P1.B B3) ─────────────────────

  describe('projects + user_name routes', () => {
    interface MockProjects {
      list: () => { alias: string; path: string; current: boolean }[]
      switchTo: (alias: string) => Promise<{ ok: true; path: string } | { ok: false; reason: string }>
      add: (alias: string, path: string) => Promise<void>
      remove: (alias: string) => Promise<void>
    }

    function startWithProjects(opts: {
      projects?: MockProjects
      setUserName?: (chatId: string, name: string) => Promise<void>
    } = {}): Promise<{ port: number; token: string }> {
      api = createInternalApi({
        stateDir,
        daemonPid: 1,
        ...(opts.projects ? { projects: opts.projects } : {}),
        ...(opts.setUserName ? { setUserName: opts.setUserName } : {}),
      })
      return api.start().then(({ port, tokenFilePath }) => ({
        port,
        token: readFileSync(tokenFilePath, 'utf8').trim(),
      }))
    }

    it('GET /v1/projects/list returns array (legacy unwrapped shape)', async () => {
      const { port, token } = await startWithProjects({
        projects: {
          list: () => [{ alias: 'a', path: '/p/a', current: true }, { alias: 'b', path: '/p/b', current: false }],
          switchTo: async () => ({ ok: true, path: '/p/a' }),
          add: async () => {},
          remove: async () => {},
        },
      })
      const resp = await fetch(`http://127.0.0.1:${port}/v1/projects/list`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(resp.status).toBe(200)
      const body = await resp.json() as Array<{ alias: string; current: boolean }>
      expect(body).toHaveLength(2)
      expect(body[0]).toMatchObject({ alias: 'a', current: true })
    })

    it('POST /v1/projects/switch forwards alias and returns ok:true on success', async () => {
      const switchTo = vi.fn(async () => ({ ok: true as const, path: '/x' }))
      const { port, token } = await startWithProjects({
        projects: { list: () => [], switchTo, add: async () => {}, remove: async () => {} },
      })
      const resp = await fetch(`http://127.0.0.1:${port}/v1/projects/switch`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ alias: 'mobile' }),
      })
      expect(resp.status).toBe(200)
      expect(await resp.json()).toEqual({ ok: true, path: '/x' })
      expect(switchTo).toHaveBeenCalledWith('mobile')
    })

    it('POST /v1/projects/switch surfaces ok:false reason on failure', async () => {
      const { port, token } = await startWithProjects({
        projects: {
          list: () => [],
          switchTo: async () => ({ ok: false, reason: 'alias_not_found' }),
          add: async () => {}, remove: async () => {},
        },
      })
      const resp = await fetch(`http://127.0.0.1:${port}/v1/projects/switch`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ alias: 'ghost' }),
      })
      expect(resp.status).toBe(200)
      expect(await resp.json()).toEqual({ ok: false, reason: 'alias_not_found' })
    })

    it('POST /v1/projects/switch returns 400 when alias missing', async () => {
      const { port, token } = await startWithProjects({
        projects: { list: () => [], switchTo: async () => ({ ok: true, path: '/' }), add: async () => {}, remove: async () => {} },
      })
      const resp = await fetch(`http://127.0.0.1:${port}/v1/projects/switch`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(resp.status).toBe(400)
      expect(await resp.json()).toMatchObject({ error: 'alias_required' })
    })

    it('POST /v1/projects/add forwards alias + path', async () => {
      const add = vi.fn(async () => {})
      const { port, token } = await startWithProjects({
        projects: { list: () => [], switchTo: async () => ({ ok: true, path: '/' }), add, remove: async () => {} },
      })
      const resp = await fetch(`http://127.0.0.1:${port}/v1/projects/add`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ alias: 'newp', path: '/abs/path' }),
      })
      expect(resp.status).toBe(200)
      expect(await resp.json()).toEqual({ ok: true })
      expect(add).toHaveBeenCalledWith('newp', '/abs/path')
    })

    it('POST /v1/projects/add catches add() errors and returns ok:false (legacy shape)', async () => {
      const { port, token } = await startWithProjects({
        projects: {
          list: () => [],
          switchTo: async () => ({ ok: true, path: '/' }),
          add: async () => { throw new Error('alias already exists') },
          remove: async () => {},
        },
      })
      const resp = await fetch(`http://127.0.0.1:${port}/v1/projects/add`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ alias: 'dup', path: '/p' }),
      })
      expect(resp.status).toBe(200)
      const body = await resp.json() as { ok: boolean; error?: string }
      expect(body.ok).toBe(false)
      expect(body.error).toContain('alias already exists')
    })

    it('POST /v1/projects/remove forwards alias', async () => {
      const remove = vi.fn(async () => {})
      const { port, token } = await startWithProjects({
        projects: { list: () => [], switchTo: async () => ({ ok: true, path: '/' }), add: async () => {}, remove },
      })
      const resp = await fetch(`http://127.0.0.1:${port}/v1/projects/remove`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ alias: 'x' }),
      })
      expect(resp.status).toBe(200)
      expect(await resp.json()).toEqual({ ok: true })
      expect(remove).toHaveBeenCalledWith('x')
    })

    it('POST /v1/user/set_name forwards chat_id + name', async () => {
      const setUserName = vi.fn(async () => {})
      const { port, token } = await startWithProjects({ setUserName })
      const resp = await fetch(`http://127.0.0.1:${port}/v1/user/set_name`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: 'chat@bot', name: '丸子' }),
      })
      expect(resp.status).toBe(200)
      expect(await resp.json()).toEqual({ ok: true })
      expect(setUserName).toHaveBeenCalledWith('chat@bot', '丸子')
    })

    it('POST /v1/user/set_name returns 400 on missing fields', async () => {
      const { port, token } = await startWithProjects({ setUserName: async () => {} })
      const resp = await fetch(`http://127.0.0.1:${port}/v1/user/set_name`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: 'c' }),  // name missing
      })
      expect(resp.status).toBe(400)
      expect(await resp.json()).toMatchObject({ error: 'name_required' })
    })

    it('returns 503 when projects dep is not wired', async () => {
      api = createInternalApi({ stateDir, daemonPid: 1 })
      const { port, tokenFilePath } = await api.start()
      const token = readFileSync(tokenFilePath, 'utf8').trim()
      const resp = await fetch(`http://127.0.0.1:${port}/v1/projects/list`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(resp.status).toBe(503)
      expect(await resp.json()).toEqual({ error: 'projects_not_wired' })
    })

    it('returns 503 when set_user_name dep is not wired', async () => {
      api = createInternalApi({ stateDir, daemonPid: 1 })
      const { port, tokenFilePath } = await api.start()
      const token = readFileSync(tokenFilePath, 'utf8').trim()
      const resp = await fetch(`http://127.0.0.1:${port}/v1/user/set_name`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: 'c', name: 'n' }),
      })
      expect(resp.status).toBe(503)
      expect(await resp.json()).toEqual({ error: 'set_user_name_not_wired' })
    })
  })

  // ─── voice routes (RFC 03 P1.B B4) ────────────────────────────────────

  describe('voice routes', () => {
    interface MockVoice {
      saveConfig: (input: {
        provider: 'http_tts' | 'qwen'
        base_url?: string
        model?: string
        api_key?: string
        default_voice?: string
      }) => Promise<
        | { ok: true; tested_ms: number; provider: string; default_voice: string }
        | { ok: false; reason: string; detail?: string }
      >
      configStatus: () => { configured: false } | {
        configured: true
        provider: 'http_tts' | 'qwen'
        default_voice: string
        base_url?: string
        model?: string
        saved_at: string
      }
    }

    function startWithVoice(voice: MockVoice): Promise<{ port: number; token: string }> {
      api = createInternalApi({ stateDir, daemonPid: 1, voice })
      return api.start().then(({ port, tokenFilePath }) => ({
        port,
        token: readFileSync(tokenFilePath, 'utf8').trim(),
      }))
    }

    it('GET /v1/voice/status returns configStatus() result verbatim (configured)', async () => {
      const status = {
        configured: true as const,
        provider: 'http_tts' as const,
        default_voice: 'default',
        base_url: 'http://mac:8000/v1/audio/speech',
        model: 'openbmb/VoxCPM2',
        saved_at: '2026-04-22T00:00:00Z',
      }
      const { port, token } = await startWithVoice({
        configStatus: () => status,
        saveConfig: async () => ({ ok: false, reason: 'unused' }),
      })
      const resp = await fetch(`http://127.0.0.1:${port}/v1/voice/status`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(resp.status).toBe(200)
      expect(await resp.json()).toEqual(status)
    })

    it('GET /v1/voice/status returns {configured:false} when unset', async () => {
      const { port, token } = await startWithVoice({
        configStatus: () => ({ configured: false }),
        saveConfig: async () => ({ ok: false, reason: 'unused' }),
      })
      const resp = await fetch(`http://127.0.0.1:${port}/v1/voice/status`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(await resp.json()).toEqual({ configured: false })
    })

    it('does NOT leak api_key in status response (legacy security guarantee)', async () => {
      // configStatus() never includes api_key by contract; route is a
      // pass-through, so as long as we don't add fields, we're safe. Test
      // that the route does not synthesize the field even when input has it.
      const { port, token } = await startWithVoice({
        configStatus: () => ({
          configured: true, provider: 'qwen', default_voice: 'qingyu',
          saved_at: '2026-04-22T00:00:00Z',
        }),
        saveConfig: async () => ({ ok: true, tested_ms: 0, provider: 'qwen', default_voice: 'qingyu' }),
      })
      const resp = await fetch(`http://127.0.0.1:${port}/v1/voice/status`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const body = await resp.json() as Record<string, unknown>
      expect(body.api_key).toBeUndefined()
    })

    it('POST /v1/voice/save_config forwards http_tts args + returns ok+tested_ms', async () => {
      const saveConfig = vi.fn(async () => ({
        ok: true as const, tested_ms: 800, provider: 'http_tts', default_voice: 'default',
      }))
      const { port, token } = await startWithVoice({
        saveConfig, configStatus: () => ({ configured: false }),
      })
      const resp = await fetch(`http://127.0.0.1:${port}/v1/voice/save_config`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          provider: 'http_tts',
          base_url: 'http://mac:8000/v1/audio/speech',
          model: 'openbmb/VoxCPM2',
        }),
      })
      expect(resp.status).toBe(200)
      const body = await resp.json() as { ok: boolean; tested_ms: number }
      expect(body.ok).toBe(true)
      expect(body.tested_ms).toBe(800)
      expect(saveConfig).toHaveBeenCalledWith({
        provider: 'http_tts',
        base_url: 'http://mac:8000/v1/audio/speech',
        model: 'openbmb/VoxCPM2',
      })
    })

    it('POST /v1/voice/save_config surfaces ok:false reason on validation fail', async () => {
      const { port, token } = await startWithVoice({
        saveConfig: async () => ({ ok: false, reason: 'http_tts_unreachable', detail: 'ECONNREFUSED' }),
        configStatus: () => ({ configured: false }),
      })
      const resp = await fetch(`http://127.0.0.1:${port}/v1/voice/save_config`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'http_tts', base_url: 'http://nope:9999/x', model: 'm' }),
      })
      expect(resp.status).toBe(200)
      expect(await resp.json()).toEqual({
        ok: false, reason: 'http_tts_unreachable', detail: 'ECONNREFUSED',
      })
    })

    it('POST /v1/voice/save_config returns 400 on bad provider', async () => {
      const { port, token } = await startWithVoice({
        saveConfig: async () => ({ ok: true, tested_ms: 0, provider: 'http_tts', default_voice: 'd' }),
        configStatus: () => ({ configured: false }),
      })
      const resp = await fetch(`http://127.0.0.1:${port}/v1/voice/save_config`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'mystery' }),
      })
      expect(resp.status).toBe(400)
      const body = await resp.json() as { error: string; allowed?: string[] }
      expect(body.error).toBe('provider_required')
      expect(body.allowed).toEqual(['http_tts', 'qwen'])
    })

    it('POST /v1/voice/save_config catches saveConfig() throw and shapes ok:false', async () => {
      const { port, token } = await startWithVoice({
        saveConfig: async () => { throw new Error('disk full') },
        configStatus: () => ({ configured: false }),
      })
      const resp = await fetch(`http://127.0.0.1:${port}/v1/voice/save_config`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'qwen', api_key: 'sk-x' }),
      })
      expect(resp.status).toBe(200)
      const body = await resp.json() as { ok: boolean; reason?: string; detail?: string }
      expect(body.ok).toBe(false)
      expect(body.reason).toBe('unexpected_error')
      expect(body.detail).toContain('disk full')
    })

    it('returns 503 when voice dep not wired', async () => {
      api = createInternalApi({ stateDir, daemonPid: 1 })
      const { port, tokenFilePath } = await api.start()
      const token = readFileSync(tokenFilePath, 'utf8').trim()
      const resp = await fetch(`http://127.0.0.1:${port}/v1/voice/status`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(resp.status).toBe(503)
      expect(await resp.json()).toEqual({ error: 'voice_not_wired' })
    })
  })

  // ─── share / resurface routes (RFC 03 P1.B B5) ────────────────────────

  describe('share routes', () => {
    function startWithShare(opts: {
      sharePage?: (title: string, content: string, o?: { needs_approval?: boolean; chat_id?: string; account_id?: string }) => Promise<{ url: string; slug: string }>
      resurfacePage?: (q: { slug?: string; title_fragment?: string }) => Promise<{ url: string; slug: string } | null>
    } = {}): Promise<{ port: number; token: string }> {
      api = createInternalApi({
        stateDir, daemonPid: 1,
        ...(opts.sharePage ? { sharePage: opts.sharePage } : {}),
        ...(opts.resurfacePage ? { resurfacePage: opts.resurfacePage } : {}),
      })
      return api.start().then(({ port, tokenFilePath }) => ({
        port, token: readFileSync(tokenFilePath, 'utf8').trim(),
      }))
    }

    it('POST /v1/share/page omits opts when no flags supplied (legacy semantics)', async () => {
      const sharePage = vi.fn(async () => ({ url: 'https://x/abc', slug: 'abc' }))
      const { port, token } = await startWithShare({ sharePage })
      const resp = await fetch(`http://127.0.0.1:${port}/v1/share/page`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ title: 't', content: '# hi' }),
      })
      expect(resp.status).toBe(200)
      expect(await resp.json()).toEqual({ url: 'https://x/abc', slug: 'abc' })
      // sharePage receives undefined opts (not {}) — legacy contract
      expect(sharePage).toHaveBeenCalledWith('t', '# hi', undefined)
    })

    it('POST /v1/share/page forwards needs_approval=true', async () => {
      const sharePage = vi.fn(async () => ({ url: 'u', slug: 's' }))
      const { port, token } = await startWithShare({ sharePage })
      await fetch(`http://127.0.0.1:${port}/v1/share/page`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ title: 't', content: '# hi', needs_approval: true }),
      })
      expect(sharePage).toHaveBeenCalledWith('t', '# hi', { needs_approval: true })
    })

    it('POST /v1/share/page omits opts when needs_approval is explicitly false (legacy default-off)', async () => {
      const sharePage = vi.fn(async () => ({ url: 'u', slug: 's' }))
      const { port, token } = await startWithShare({ sharePage })
      await fetch(`http://127.0.0.1:${port}/v1/share/page`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ title: 't', content: '# hi', needs_approval: false }),
      })
      expect(sharePage).toHaveBeenCalledWith('t', '# hi', undefined)
    })

    it('POST /v1/share/page forwards chat_id + account_id when supplied', async () => {
      const sharePage = vi.fn(async () => ({ url: 'u', slug: 's' }))
      const { port, token } = await startWithShare({ sharePage })
      await fetch(`http://127.0.0.1:${port}/v1/share/page`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ title: 't', content: '# hi', chat_id: 'c1', account_id: 'a1' }),
      })
      expect(sharePage).toHaveBeenCalledWith('t', '# hi', { chat_id: 'c1', account_id: 'a1' })
    })

    it('POST /v1/share/page returns 400 when title or content missing', async () => {
      const { port, token } = await startWithShare({ sharePage: async () => ({ url: 'u', slug: 's' }) })
      const r1 = await fetch(`http://127.0.0.1:${port}/v1/share/page`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ content: '# hi' }),
      })
      expect(r1.status).toBe(400)
      expect(await r1.json()).toMatchObject({ error: 'title_required' })
      const r2 = await fetch(`http://127.0.0.1:${port}/v1/share/page`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ title: 't' }),
      })
      expect(r2.status).toBe(400)
      expect(await r2.json()).toMatchObject({ error: 'content_required' })
    })

    it('POST /v1/share/page catches sharePage() throw and returns ok:false', async () => {
      const { port, token } = await startWithShare({
        sharePage: async () => { throw new Error('cloudflared not running') },
      })
      const resp = await fetch(`http://127.0.0.1:${port}/v1/share/page`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ title: 't', content: '# hi' }),
      })
      expect(resp.status).toBe(200)
      const body = await resp.json() as { ok: boolean; error?: string }
      expect(body.ok).toBe(false)
      expect(body.error).toContain('cloudflared')
    })

    it('POST /v1/share/resurface returns the page record on hit', async () => {
      const resurfacePage = vi.fn(async () => ({ url: 'https://x/abc', slug: 'abc' }))
      const { port, token } = await startWithShare({ resurfacePage })
      const resp = await fetch(`http://127.0.0.1:${port}/v1/share/resurface`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ slug: 'abc' }),
      })
      expect(resp.status).toBe(200)
      expect(await resp.json()).toEqual({ url: 'https://x/abc', slug: 'abc' })
      expect(resurfacePage).toHaveBeenCalledWith({ slug: 'abc' })
    })

    it('POST /v1/share/resurface returns {ok:false, reason:not found} on miss (legacy shape)', async () => {
      const { port, token } = await startWithShare({
        resurfacePage: async () => null,
      })
      const resp = await fetch(`http://127.0.0.1:${port}/v1/share/resurface`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ title_fragment: 'never' }),
      })
      expect(resp.status).toBe(200)
      expect(await resp.json()).toEqual({ ok: false, reason: 'not found' })
    })

    it('POST /v1/share/resurface forwards both slug and title_fragment when supplied', async () => {
      const resurfacePage = vi.fn(async () => ({ url: 'u', slug: 's' }))
      const { port, token } = await startWithShare({ resurfacePage })
      await fetch(`http://127.0.0.1:${port}/v1/share/resurface`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ slug: 's1', title_fragment: 'review' }),
      })
      expect(resurfacePage).toHaveBeenCalledWith({ slug: 's1', title_fragment: 'review' })
    })

    it('POST /v1/share/resurface returns 400 when slug or title_fragment have wrong type', async () => {
      const { port, token } = await startWithShare({
        resurfacePage: async () => null,
      })
      const resp = await fetch(`http://127.0.0.1:${port}/v1/share/resurface`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ slug: 123 }),
      })
      expect(resp.status).toBe(400)
      expect(await resp.json()).toMatchObject({ error: 'slug_must_be_string' })
    })

    it('returns 503 when share_page dep not wired', async () => {
      api = createInternalApi({ stateDir, daemonPid: 1 })
      const { port, tokenFilePath } = await api.start()
      const token = readFileSync(tokenFilePath, 'utf8').trim()
      const resp = await fetch(`http://127.0.0.1:${port}/v1/share/page`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ title: 't', content: 'c' }),
      })
      expect(resp.status).toBe(503)
      expect(await resp.json()).toEqual({ error: 'share_page_not_wired' })
    })

    it('returns 503 when resurface_page dep not wired', async () => {
      api = createInternalApi({ stateDir, daemonPid: 1 })
      const { port, tokenFilePath } = await api.start()
      const token = readFileSync(tokenFilePath, 'utf8').trim()
      const resp = await fetch(`http://127.0.0.1:${port}/v1/share/resurface`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ slug: 's' }),
      })
      expect(resp.status).toBe(503)
      expect(await resp.json()).toEqual({ error: 'resurface_page_not_wired' })
    })
  })
})
