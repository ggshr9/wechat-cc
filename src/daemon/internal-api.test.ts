import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createInternalApi, type InternalApi } from './internal-api'
import { makeMemoryFS } from './memory/fs-api'
import { makeEventsStore } from './events/store'
import { openTestDb } from '../lib/db'
import { makeTurnRecordStore } from '../core/turn-record-store'
import type { TurnRecord } from '../core/conversation-coordinator'
import { loadAgentConfig, saveAgentConfig } from '../lib/agent-config'
import type { A2ARegistry } from '../core/a2a-registry'
import type { A2AClient, SendResult, AgentCard } from '../core/a2a-client'
import type { A2AEventsStore, EventRow, AppendInput } from '../core/a2a-events-store'

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
    // POSIX mode 0600 is the contract; Windows / NTFS doesn't model POSIX
    // permissions and reports 0666 from fs.stat. Skip the mode assertion
    // there — security on Windows comes from the user-profile ACL on the
    // state directory, not file modes.
    if (process.platform !== 'win32') {
      // Mode bits: must be readable/writable by owner only (0600). Mask with
      // 0o777 to drop file-type bits.
      expect((st.mode & 0o777).toString(8)).toBe('600')
    }
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
      // After T7: schema validation fires in index.ts before the handler.
      expect(await resp.json()).toMatchObject({ error: 'invalid_request' })
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

    describe('POST /v1/memory/delete (soft-delete + audit)', () => {
      async function startWithMemoryAndDb(): Promise<{ port: number; token: string; db: ReturnType<typeof openTestDb> }> {
        memoryRoot = join(stateDir, 'memory')
        const memory = makeMemoryFS({ rootDir: memoryRoot })
        const db = openTestDb()
        api = createInternalApi({ stateDir, daemonPid: 999, memory, db })
        const { port, tokenFilePath } = await api.start()
        const token = readFileSync(tokenFilePath, 'utf8').trim()
        return { port, token, db }
      }

      it('soft-deletes existing file and writes memory_deleted audit event', async () => {
        const { port, token, db } = await startWithMemoryAndDb()
        // Seed a memory file
        await fetch(`http://127.0.0.1:${port}/v1/memory/write`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ path: 'profile.md', content: 'doomed' }),
        })
        const resp = await fetch(`http://127.0.0.1:${port}/v1/memory/delete`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: 'chat_test', path: 'profile.md', reason: 'user said forget that' }),
        })
        expect(resp.status).toBe(200)
        const body = await resp.json() as { ok: boolean; existed: boolean; tombstone: string }
        expect(body.ok).toBe(true)
        expect(body.existed).toBe(true)
        expect(body.tombstone).toMatch(/^profile\.md\.deleted-/)

        // Audit row landed in events for this chat
        const events = await makeEventsStore(db, 'chat_test').list()
        expect(events).toHaveLength(1)
        expect(events[0]).toMatchObject({
          kind: 'memory_deleted',
          trigger: 'mcp_tool_call',
          reasoning: 'user said forget that',
          memory_path: body.tombstone,
        })
        db.close()
      })

      it('returns ok:true existed:false (no event) when target does not exist', async () => {
        const { port, token, db } = await startWithMemoryAndDb()
        const resp = await fetch(`http://127.0.0.1:${port}/v1/memory/delete`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: 'chat_test', path: 'nope.md', reason: 'user said remove it' }),
        })
        expect(resp.status).toBe(200)
        expect(await resp.json()).toEqual({ ok: true, existed: false })
        const events = await makeEventsStore(db, 'chat_test').list()
        expect(events).toHaveLength(0)
        db.close()
      })

      it('returns 400 when reason is shorter than 4 chars (schema validation)', async () => {
        const { port, token, db } = await startWithMemoryAndDb()
        const resp = await fetch(`http://127.0.0.1:${port}/v1/memory/delete`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: 'chat_test', path: 'a.md', reason: 'no' }),
        })
        expect(resp.status).toBe(400)
        expect(await resp.json()).toMatchObject({ error: 'invalid_request' })
        db.close()
      })
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
      // After T7: schema validation fires in index.ts before the handler.
      expect(await resp.json()).toMatchObject({ error: 'invalid_request' })
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
      // After T7: schema validation fires in index.ts before the handler.
      expect(await resp.json()).toMatchObject({ error: 'invalid_request' })
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
      replyVoice: (chatId: string, text: string) => Promise<
        | { ok: true; msgId: string }
        | { ok: false; reason: string }
      >
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

    const stubReplyVoice: MockVoice['replyVoice'] = async () => ({ ok: false, reason: 'unused_in_b4_tests' })

    function startWithVoice(voiceParts: Omit<MockVoice, 'replyVoice'> & Partial<Pick<MockVoice, 'replyVoice'>>): Promise<{ port: number; token: string }> {
      const voice: MockVoice = { replyVoice: voiceParts.replyVoice ?? stubReplyVoice, saveConfig: voiceParts.saveConfig, configStatus: voiceParts.configStatus }
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
      // After T7: schema validation fires in index.ts before the handler.
      const body = await resp.json() as { error: string }
      expect(body.error).toBe('invalid_request')
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
      // After T7: schema validation fires in index.ts before the handler.
      expect(await r1.json()).toMatchObject({ error: 'invalid_request' })
      const r2 = await fetch(`http://127.0.0.1:${port}/v1/share/page`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ title: 't' }),
      })
      expect(r2.status).toBe(400)
      expect(await r2.json()).toMatchObject({ error: 'invalid_request' })
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
      // After T7: schema validation fires in index.ts before the handler.
      expect(await resp.json()).toMatchObject({ error: 'invalid_request' })
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

  // ─── companion routes (RFC 03 P1.B B6) ────────────────────────────────

  describe('companion routes', () => {
    interface MockCompanion {
      enable: () => Promise<
        | { ok: true; state_dir: string; welcome_message: string; cost_estimate_note: string }
        | { ok: true; already_configured: true }
      >
      disable: () => Promise<{ ok: true; enabled: false }>
      status: () => {
        enabled: boolean
        timezone: string
        default_chat_id: string | null
        snooze_until: string | null
      }
      snooze: (minutes: number) => Promise<{ ok: true; until: string }>
    }

    function startWithCompanion(companion: MockCompanion): Promise<{ port: number; token: string }> {
      api = createInternalApi({ stateDir, daemonPid: 1, companion })
      return api.start().then(({ port, tokenFilePath }) => ({
        port, token: readFileSync(tokenFilePath, 'utf8').trim(),
      }))
    }

    it('GET /v1/companion/status passes through status() result', async () => {
      const { port, token } = await startWithCompanion({
        enable: async () => ({ ok: true, state_dir: '/x', welcome_message: 'w', cost_estimate_note: 'c' }),
        disable: async () => ({ ok: true, enabled: false }),
        status: () => ({ enabled: true, timezone: 'Asia/Shanghai', default_chat_id: 'c1', snooze_until: null }),
        snooze: async () => ({ ok: true, until: '2026-04-22T00:00:00Z' }),
      })
      const resp = await fetch(`http://127.0.0.1:${port}/v1/companion/status`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(resp.status).toBe(200)
      expect(await resp.json()).toEqual({
        enabled: true, timezone: 'Asia/Shanghai', default_chat_id: 'c1', snooze_until: null,
      })
    })

    it('POST /v1/companion/enable returns first-time welcome shape', async () => {
      const enable = vi.fn(async () => ({
        ok: true as const,
        state_dir: '/state',
        welcome_message: '开启完成',
        cost_estimate_note: '~$0.02/tick',
      }))
      const { port, token } = await startWithCompanion({
        enable, disable: async () => ({ ok: true, enabled: false }),
        status: () => ({ enabled: false, timezone: 'UTC', default_chat_id: null, snooze_until: null }),
        snooze: async () => ({ ok: true, until: '' }),
      })
      const resp = await fetch(`http://127.0.0.1:${port}/v1/companion/enable`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: '{}',
      })
      expect(resp.status).toBe(200)
      const body = await resp.json() as { ok: boolean; welcome_message?: string }
      expect(body.ok).toBe(true)
      expect(body.welcome_message).toBe('开启完成')
      expect(enable).toHaveBeenCalled()
    })

    it('POST /v1/companion/enable surfaces already_configured shape on second call', async () => {
      const { port, token } = await startWithCompanion({
        enable: async () => ({ ok: true, already_configured: true }),
        disable: async () => ({ ok: true, enabled: false }),
        status: () => ({ enabled: true, timezone: 'UTC', default_chat_id: null, snooze_until: null }),
        snooze: async () => ({ ok: true, until: '' }),
      })
      const resp = await fetch(`http://127.0.0.1:${port}/v1/companion/enable`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: '{}',
      })
      expect(await resp.json()).toEqual({ ok: true, already_configured: true })
    })

    it('POST /v1/companion/disable returns ok:true,enabled:false', async () => {
      const disable = vi.fn(async () => ({ ok: true as const, enabled: false as const }))
      const { port, token } = await startWithCompanion({
        enable: async () => ({ ok: true, state_dir: '', welcome_message: '', cost_estimate_note: '' }),
        disable,
        status: () => ({ enabled: true, timezone: 'UTC', default_chat_id: null, snooze_until: null }),
        snooze: async () => ({ ok: true, until: '' }),
      })
      const resp = await fetch(`http://127.0.0.1:${port}/v1/companion/disable`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: '{}',
      })
      expect(resp.status).toBe(200)
      expect(await resp.json()).toEqual({ ok: true, enabled: false })
      expect(disable).toHaveBeenCalled()
    })

    it('POST /v1/companion/snooze forwards minutes', async () => {
      const snooze = vi.fn(async (m: number) => ({
        ok: true as const,
        until: new Date(Date.now() + m * 60_000).toISOString(),
      }))
      const { port, token } = await startWithCompanion({
        enable: async () => ({ ok: true, state_dir: '', welcome_message: '', cost_estimate_note: '' }),
        disable: async () => ({ ok: true, enabled: false }),
        status: () => ({ enabled: true, timezone: 'UTC', default_chat_id: null, snooze_until: null }),
        snooze,
      })
      const resp = await fetch(`http://127.0.0.1:${port}/v1/companion/snooze`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ minutes: 90 }),
      })
      expect(resp.status).toBe(200)
      const body = await resp.json() as { ok: boolean; until: string }
      expect(body.ok).toBe(true)
      expect(typeof body.until).toBe('string')
      expect(snooze).toHaveBeenCalledWith(90)
    })

    it('POST /v1/companion/snooze rejects out-of-range / non-int minutes (400)', async () => {
      const { port, token } = await startWithCompanion({
        enable: async () => ({ ok: true, state_dir: '', welcome_message: '', cost_estimate_note: '' }),
        disable: async () => ({ ok: true, enabled: false }),
        status: () => ({ enabled: true, timezone: 'UTC', default_chat_id: null, snooze_until: null }),
        snooze: async () => ({ ok: true, until: '' }),
      })
      const cases = [
        { minutes: 0 },          // below min
        { minutes: 24 * 60 + 1 }, // above max
        { minutes: 1.5 },         // non-int
        { minutes: 'sixty' },     // wrong type
        {},                       // missing
      ]
      for (const body of cases) {
        const resp = await fetch(`http://127.0.0.1:${port}/v1/companion/snooze`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
        expect(resp.status).toBe(400)
        // After T7: schema validation fires in index.ts before the handler.
        expect(await resp.json()).toMatchObject({ error: 'invalid_request' })
      }
    })

    it('catches enable() throw and returns ok:false', async () => {
      const { port, token } = await startWithCompanion({
        enable: async () => { throw new Error('config write failed') },
        disable: async () => ({ ok: true, enabled: false }),
        status: () => ({ enabled: false, timezone: 'UTC', default_chat_id: null, snooze_until: null }),
        snooze: async () => ({ ok: true, until: '' }),
      })
      const resp = await fetch(`http://127.0.0.1:${port}/v1/companion/enable`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: '{}',
      })
      expect(resp.status).toBe(200)
      const body = await resp.json() as { ok: boolean; error?: string }
      expect(body.ok).toBe(false)
      expect(body.error).toContain('config write failed')
    })

    it('returns 503 when companion dep not wired', async () => {
      api = createInternalApi({ stateDir, daemonPid: 1 })
      const { port, tokenFilePath } = await api.start()
      const token = readFileSync(tokenFilePath, 'utf8').trim()
      const resp = await fetch(`http://127.0.0.1:${port}/v1/companion/status`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(resp.status).toBe(503)
      expect(await resp.json()).toEqual({ error: 'companion_not_wired' })
    })
  })

  // ─── ilink-bound message family routes (RFC 03 P1.B B1) ──────────────

  describe('ilink message routes', () => {
    interface MockIlink {
      sendReply: (chatId: string, text: string) => Promise<{ msgId: string; error?: string }>
      sendFile: (chatId: string, path: string) => Promise<void>
      editMessage: (chatId: string, msgId: string, text: string) => Promise<void>
      broadcast: (text: string, accountId?: string) => Promise<{ ok: number; failed: number }>
    }

    function startWithIlink(opts: {
      ilink?: MockIlink
      replyVoice?: (chatId: string, text: string) => Promise<{ ok: true; msgId: string } | { ok: false; reason: string }>
    } = {}): Promise<{ port: number; token: string }> {
      const voice: WechatVoiceImports = opts.replyVoice
        ? {
            replyVoice: opts.replyVoice,
            saveConfig: async () => ({ ok: false, reason: 'unused' }),
            configStatus: () => ({ configured: false }),
          }
        : undefined as unknown as WechatVoiceImports
      api = createInternalApi({
        stateDir, daemonPid: 1,
        ...(opts.ilink ? { ilink: opts.ilink } : {}),
        ...(voice ? { voice } : {}),
      })
      return api.start().then(({ port, tokenFilePath }) => ({
        port, token: readFileSync(tokenFilePath, 'utf8').trim(),
      }))
    }

    // Local alias for the import shape used inside startWithIlink (avoids
    // pulling the real type just for the test conditional).
    type WechatVoiceImports = {
      replyVoice: (chatId: string, text: string) => Promise<{ ok: true; msgId: string } | { ok: false; reason: string }>
      saveConfig: (i: { provider: 'http_tts' | 'qwen' }) => Promise<{ ok: false; reason: string }>
      configStatus: () => { configured: false }
    } | undefined

    it('POST /v1/wechat/reply forwards chat_id+text and returns ok+msg_id (legacy reshape)', async () => {
      const sendReply = vi.fn(async () => ({ msgId: 'm-123' }))
      const { port, token } = await startWithIlink({
        ilink: { sendReply, sendFile: async () => {}, editMessage: async () => {}, broadcast: async () => ({ ok: 0, failed: 0 }) },
      })
      const resp = await fetch(`http://127.0.0.1:${port}/v1/wechat/reply`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: 'c@bot', text: 'hi' }),
      })
      expect(resp.status).toBe(200)
      // Legacy in-process tool reshaped {msgId,error?} → {ok,msg_id} or
      // {ok:false,error}. Test asserts the reshape so the agent's mental
      // model survives the migration unchanged.
      expect(await resp.json()).toEqual({ ok: true, msg_id: 'm-123' })
      expect(sendReply).toHaveBeenCalledWith('c@bot', 'hi')
    })

    it('POST /v1/wechat/reply surfaces ok:false+error when ilink reports an error', async () => {
      const { port, token } = await startWithIlink({
        ilink: {
          sendReply: async () => ({ msgId: '', error: 'session timeout' }),
          sendFile: async () => {}, editMessage: async () => {},
          broadcast: async () => ({ ok: 0, failed: 0 }),
        },
      })
      const resp = await fetch(`http://127.0.0.1:${port}/v1/wechat/reply`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: 'c', text: 't' }),
      })
      expect(await resp.json()).toEqual({ ok: false, error: 'session timeout' })
    })

    it('POST /v1/wechat/reply returns 400 on missing fields', async () => {
      const { port, token } = await startWithIlink({
        ilink: { sendReply: async () => ({ msgId: 'm' }), sendFile: async () => {}, editMessage: async () => {}, broadcast: async () => ({ ok: 0, failed: 0 }) },
      })
      const r1 = await fetch(`http://127.0.0.1:${port}/v1/wechat/reply`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ text: 't' }),
      })
      expect(r1.status).toBe(400)
      // After T7: schema validation fires in index.ts before the handler.
      expect(await r1.json()).toMatchObject({ error: 'invalid_request' })
      const r2 = await fetch(`http://127.0.0.1:${port}/v1/wechat/reply`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: 'c' }),
      })
      expect(r2.status).toBe(400)
      expect(await r2.json()).toMatchObject({ error: 'invalid_request' })
    })

    it('POST /v1/wechat/reply catches sendReply throw and returns ok:false', async () => {
      const { port, token } = await startWithIlink({
        ilink: {
          sendReply: async () => { throw new Error('ilink down') },
          sendFile: async () => {}, editMessage: async () => {},
          broadcast: async () => ({ ok: 0, failed: 0 }),
        },
      })
      const resp = await fetch(`http://127.0.0.1:${port}/v1/wechat/reply`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: 'c', text: 't' }),
      })
      expect(resp.status).toBe(200)
      const body = await resp.json() as { ok: boolean; error?: string }
      expect(body.ok).toBe(false)
      expect(body.error).toContain('ilink down')
    })

    it('POST /v1/wechat/reply_voice forwards chat_id+text and returns voice result', async () => {
      const replyVoice = vi.fn(async () => ({ ok: true as const, msgId: 'voice-1' }))
      const { port, token } = await startWithIlink({ replyVoice })
      const resp = await fetch(`http://127.0.0.1:${port}/v1/wechat/reply_voice`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: 'c', text: '念这一段' }),
      })
      expect(resp.status).toBe(200)
      expect(await resp.json()).toEqual({ ok: true, msgId: 'voice-1' })
      expect(replyVoice).toHaveBeenCalledWith('c', '念这一段')
    })

    it('POST /v1/wechat/reply_voice rejects text > 500 chars (handler business rule)', async () => {
      const replyVoice = vi.fn()
      const { port, token } = await startWithIlink({ replyVoice: replyVoice as never })
      const resp = await fetch(`http://127.0.0.1:${port}/v1/wechat/reply_voice`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: 'c', text: 'x'.repeat(501) }),
      })
      // 500-char cap is a handler business rule (not a schema constraint),
      // so the wire contract is 200 with structured reason — preserves the
      // agent client's ability to adapt vs a generic 400 invalid_request.
      expect(resp.status).toBe(200)
      expect(await resp.json()).toEqual({ ok: false, reason: 'too_long', limit: 500 })
      // dep was NOT called — handler short-circuits before crossing the boundary
      expect(replyVoice).not.toHaveBeenCalled()
    })

    it('POST /v1/wechat/send_file forwards chat_id+path and returns ok:true', async () => {
      const sendFile = vi.fn(async () => {})
      const { port, token } = await startWithIlink({
        ilink: { sendReply: async () => ({ msgId: 'm' }), sendFile, editMessage: async () => {}, broadcast: async () => ({ ok: 0, failed: 0 }) },
      })
      const resp = await fetch(`http://127.0.0.1:${port}/v1/wechat/send_file`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: 'c', path: '/abs/file.pdf' }),
      })
      expect(resp.status).toBe(200)
      expect(await resp.json()).toEqual({ ok: true })
      expect(sendFile).toHaveBeenCalledWith('c', '/abs/file.pdf')
    })

    it('POST /v1/wechat/edit_message forwards all 3 args and returns ok:true', async () => {
      const editMessage = vi.fn(async () => {})
      const { port, token } = await startWithIlink({
        ilink: { sendReply: async () => ({ msgId: 'm' }), sendFile: async () => {}, editMessage, broadcast: async () => ({ ok: 0, failed: 0 }) },
      })
      const resp = await fetch(`http://127.0.0.1:${port}/v1/wechat/edit_message`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: 'c', msg_id: 'm-1', text: 'edited' }),
      })
      expect(resp.status).toBe(200)
      expect(await resp.json()).toEqual({ ok: true })
      expect(editMessage).toHaveBeenCalledWith('c', 'm-1', 'edited')
    })

    it('POST /v1/wechat/broadcast forwards text + optional account_id', async () => {
      const broadcast = vi.fn(async () => ({ ok: 5, failed: 1 }))
      const { port, token } = await startWithIlink({
        ilink: { sendReply: async () => ({ msgId: 'm' }), sendFile: async () => {}, editMessage: async () => {}, broadcast },
      })
      const resp = await fetch(`http://127.0.0.1:${port}/v1/wechat/broadcast`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'hi all', account_id: 'a-2' }),
      })
      expect(resp.status).toBe(200)
      expect(await resp.json()).toEqual({ ok: 5, failed: 1 })
      expect(broadcast).toHaveBeenCalledWith('hi all', 'a-2')
    })

    it('POST /v1/wechat/broadcast forwards undefined account_id when missing (legacy semantics)', async () => {
      const broadcast = vi.fn(async () => ({ ok: 0, failed: 0 }))
      const { port, token } = await startWithIlink({
        ilink: { sendReply: async () => ({ msgId: 'm' }), sendFile: async () => {}, editMessage: async () => {}, broadcast },
      })
      await fetch(`http://127.0.0.1:${port}/v1/wechat/broadcast`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'hi' }),
      })
      // Legacy in-process tool passed `account_id ?? undefined` — not {} —
      // so deps.broadcast's optional second argument behaves as "use default".
      expect(broadcast).toHaveBeenCalledWith('hi', undefined)
    })

    // ── reply prefixing in parallel/chatroom modes (RFC 03 P3) ─────────

    describe('reply prefixing (RFC 03 P3)', () => {
      function startWithPrefix(opts: {
        mode: { kind: 'solo' | 'parallel' | 'chatroom' | 'primary_tool'; provider?: string; primary?: string } | null
        sendReply: (chatId: string, text: string) => Promise<{ msgId: string; error?: string }>
      }): Promise<{ port: number; token: string }> {
        const conversationStore = {
          get: (chatId: string) => opts.mode ? { mode: opts.mode as never } : null,
        }
        api = createInternalApi({
          stateDir, daemonPid: 1,
          ilink: {
            sendReply: opts.sendReply,
            sendFile: async () => {},
            editMessage: async () => {},
            broadcast: async () => ({ ok: 0, failed: 0 }),
          },
          prefix: {
            conversationStore,
            providerDisplayName: (id) => id === 'claude' ? 'Claude' : id === 'codex' ? 'Codex' : id,
            permissionMode: 'strict' as const,
          },
        })
        return api.start().then(({ port, tokenFilePath }) => ({
          port, token: readFileSync(tokenFilePath, 'utf8').trim(),
        }))
      }

      it('prefixes [Claude] in parallel mode when participant_tag=claude', async () => {
        const sentText: string[] = []
        const sendReply = async (_chatId: string, text: string) => { sentText.push(text); return { msgId: 'm' } }
        const { port, token } = await startWithPrefix({
          mode: { kind: 'parallel' }, sendReply,
        })
        await fetch(`http://127.0.0.1:${port}/v1/wechat/reply`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: 'c', text: 'hello', participant_tag: 'claude' }),
        })
        expect(sentText).toEqual(['[Claude] hello'])
      })

      it('prefixes [Codex] when participant_tag=codex', async () => {
        const sentText: string[] = []
        const sendReply = async (_chatId: string, text: string) => { sentText.push(text); return { msgId: 'm' } }
        const { port, token } = await startWithPrefix({
          mode: { kind: 'parallel' }, sendReply,
        })
        await fetch(`http://127.0.0.1:${port}/v1/wechat/reply`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: 'c', text: 'codex says hi', participant_tag: 'codex' }),
        })
        expect(sentText).toEqual(['[Codex] codex says hi'])
      })

      it('passes text through UNPREFIXED in solo mode (no behaviour change for existing users)', async () => {
        const sentText: string[] = []
        const sendReply = async (_chatId: string, text: string) => { sentText.push(text); return { msgId: 'm' } }
        const { port, token } = await startWithPrefix({
          mode: { kind: 'solo', provider: 'claude' }, sendReply,
        })
        await fetch(`http://127.0.0.1:${port}/v1/wechat/reply`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: 'c', text: 'hi', participant_tag: 'claude' }),
        })
        // No prefix even though participant_tag was supplied — solo doesn't disambiguate.
        expect(sentText).toEqual(['hi'])
      })

      it('passes text through UNPREFIXED when no mode persisted (defaults to solo)', async () => {
        const sentText: string[] = []
        const sendReply = async (_chatId: string, text: string) => { sentText.push(text); return { msgId: 'm' } }
        const { port, token } = await startWithPrefix({ mode: null, sendReply })
        await fetch(`http://127.0.0.1:${port}/v1/wechat/reply`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: 'c', text: 'hi', participant_tag: 'claude' }),
        })
        expect(sentText).toEqual(['hi'])
      })

      it('passes text through UNPREFIXED when participant_tag absent (legacy clients)', async () => {
        const sentText: string[] = []
        const sendReply = async (_chatId: string, text: string) => { sentText.push(text); return { msgId: 'm' } }
        const { port, token } = await startWithPrefix({
          mode: { kind: 'parallel' }, sendReply,
        })
        await fetch(`http://127.0.0.1:${port}/v1/wechat/reply`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: 'c', text: 'hi' }),
        })
        // tag missing → no prefix even though mode is parallel
        expect(sentText).toEqual(['hi'])
      })

      it('prefixes in chatroom mode too (P5 will use the same plumbing)', async () => {
        const sentText: string[] = []
        const sendReply = async (_chatId: string, text: string) => { sentText.push(text); return { msgId: 'm' } }
        const { port, token } = await startWithPrefix({
          mode: { kind: 'chatroom' }, sendReply,
        })
        await fetch(`http://127.0.0.1:${port}/v1/wechat/reply`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: 'c', text: 'speaks', participant_tag: 'claude' }),
        })
        expect(sentText).toEqual(['[Claude] speaks'])
      })

      it('falls back to id when providerDisplayName returns custom names (e.g. tests)', async () => {
        const sentText: string[] = []
        const sendReply = async (_chatId: string, text: string) => { sentText.push(text); return { msgId: 'm' } }
        const conversationStore = {
          get: () => ({ mode: { kind: 'parallel' as const } }),
        }
        api = createInternalApi({
          stateDir, daemonPid: 1,
          ilink: { sendReply, sendFile: async () => {}, editMessage: async () => {}, broadcast: async () => ({ ok: 0, failed: 0 }) },
          prefix: {
            conversationStore,
            providerDisplayName: (id) => id,  // identity — no friendly name
            permissionMode: 'strict' as const,
          },
        })
        const { port, tokenFilePath } = await api.start()
        const token = readFileSync(tokenFilePath, 'utf8').trim()
        await fetch(`http://127.0.0.1:${port}/v1/wechat/reply`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: 'c', text: 'hi', participant_tag: 'gemini-experimental' }),
        })
        expect(sentText).toEqual(['[gemini-experimental] hi'])
      })

      it('prefix decision goes through capability-matrix lookup (parallel mode → [Claude] prefix)', async () => {
        // Verify that the matrix-driven lookup is exercised: in parallel mode
        // the matrix returns replyPrefix='always' for known providers, so the
        // reply text arrives prefixed.
        const sentText: string[] = []
        const sendReply = async (_chatId: string, text: string) => { sentText.push(text); return { msgId: 'm' } }
        const { port, token } = await startWithPrefix({
          mode: { kind: 'parallel' }, sendReply,
        })
        await fetch(`http://127.0.0.1:${port}/v1/wechat/reply`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: 'c', text: 'matrix-check', participant_tag: 'claude' }),
        })
        // matrix row: parallel × claude × strict → replyPrefix='always' → prefixed
        expect(sentText).toEqual(['[Claude] matrix-check'])
      })
    })

    // ── delegate route (RFC 03 P4) ─────────────────────────────────────

    describe('/v1/delegate route', () => {
      it('returns 503 before setDelegate has been called', async () => {
        api = createInternalApi({ stateDir, daemonPid: 1 })
        const { port, tokenFilePath } = await api.start()
        const token = readFileSync(tokenFilePath, 'utf8').trim()
        const resp = await fetch(`http://127.0.0.1:${port}/v1/delegate`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ peer: 'codex', prompt: 'hi' }),
        })
        expect(resp.status).toBe(503)
        expect(await resp.json()).toEqual({ error: 'delegate_not_wired' })
      })

      it('routes through dispatchOneShot after setDelegate', async () => {
        const dispatchOneShot = vi.fn(async (peer: string, prompt: string) => ({
          ok: true as const, response: `from ${peer}: ${prompt.slice(0, 20)}...`, duration_ms: 5,
        }))
        api = createInternalApi({ stateDir, daemonPid: 1 })
        const { port, tokenFilePath } = await api.start()
        api.setDelegate({ dispatchOneShot, knownPeers: () => ['claude', 'codex'] })
        const token = readFileSync(tokenFilePath, 'utf8').trim()
        const resp = await fetch(`http://127.0.0.1:${port}/v1/delegate`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ peer: 'codex', prompt: 'review this code' }),
        })
        expect(resp.status).toBe(200)
        const body = await resp.json() as { ok: boolean; response: string }
        expect(body.ok).toBe(true)
        expect(body.response).toContain('from codex')
        // Third arg (cwd) is undefined when not supplied — RFC 03 review #10.
        expect(dispatchOneShot).toHaveBeenCalledWith('codex', 'review this code', undefined)
      })

      it('appends context_summary to prompt when supplied', async () => {
        const dispatchOneShot = vi.fn(async (_peer: string, prompt: string) => ({
          ok: true as const, response: prompt, duration_ms: 0,
        }))
        api = createInternalApi({ stateDir, daemonPid: 1 })
        const { port, tokenFilePath } = await api.start()
        api.setDelegate({ dispatchOneShot, knownPeers: () => ['claude', 'codex'] })
        const token = readFileSync(tokenFilePath, 'utf8').trim()
        await fetch(`http://127.0.0.1:${port}/v1/delegate`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            peer: 'codex',
            prompt: 'should we use map or set?',
            context_summary: 'we are deduping ~10k strings',
          }),
        })
        const fullPrompt = dispatchOneShot.mock.calls[0]![1]
        expect(fullPrompt).toContain('should we use map or set?')
        expect(fullPrompt).toContain('Context from the calling agent:')
        expect(fullPrompt).toContain('we are deduping ~10k strings')
      })

      it('returns 400 on missing peer/prompt', async () => {
        api = createInternalApi({ stateDir, daemonPid: 1 })
        const { port, tokenFilePath } = await api.start()
        api.setDelegate({ dispatchOneShot: async () => ({ ok: true, response: '', duration_ms: 0 }), knownPeers: () => ['claude', 'codex'] })
        const token = readFileSync(tokenFilePath, 'utf8').trim()

        const r1 = await fetch(`http://127.0.0.1:${port}/v1/delegate`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ prompt: 'hi' }),
        })
        expect(r1.status).toBe(400)
        // After T7: schema validation fires in index.ts before the handler.
        expect(await r1.json()).toMatchObject({ error: 'invalid_request' })

        const r2 = await fetch(`http://127.0.0.1:${port}/v1/delegate`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ peer: 'codex' }),
        })
        expect(r2.status).toBe(400)
        expect(await r2.json()).toMatchObject({ error: 'invalid_request' })
      })

      it('returns 400 on unknown peer with allowed list', async () => {
        api = createInternalApi({ stateDir, daemonPid: 1 })
        const { port, tokenFilePath } = await api.start()
        api.setDelegate({
          dispatchOneShot: async () => ({ ok: true, response: '', duration_ms: 0 }),
          knownPeers: () => ['claude', 'codex'],
        })
        const token = readFileSync(tokenFilePath, 'utf8').trim()
        const resp = await fetch(`http://127.0.0.1:${port}/v1/delegate`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ peer: 'gemini', prompt: 'hi' }),
        })
        expect(resp.status).toBe(400)
        const body = await resp.json() as { error: string; allowed?: string[] }
        expect(body.error).toBe('unknown_peer')
        expect(body.allowed).toEqual(['claude', 'codex'])
      })

      it('passes ok:false from dispatchOneShot through verbatim', async () => {
        api = createInternalApi({ stateDir, daemonPid: 1 })
        const { port, tokenFilePath } = await api.start()
        api.setDelegate({
          dispatchOneShot: async () => ({ ok: false, reason: 'codex CLI not authenticated' }),
          knownPeers: () => ['claude', 'codex'],
        })
        const token = readFileSync(tokenFilePath, 'utf8').trim()
        const resp = await fetch(`http://127.0.0.1:${port}/v1/delegate`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ peer: 'codex', prompt: 'hi' }),
        })
        expect(resp.status).toBe(200)
        expect(await resp.json()).toEqual({ ok: false, reason: 'codex CLI not authenticated' })
      })

      it('rejects nested delegate calls (depth > 0) — RFC 03 review #7 defense', async () => {
        api = createInternalApi({ stateDir, daemonPid: 1 })
        const { port, tokenFilePath } = await api.start()
        const dispatchOneShot = vi.fn(async () => ({ ok: true as const, response: 'should not be called', duration_ms: 0 }))
        api.setDelegate({ dispatchOneShot, knownPeers: () => ['claude', 'codex'] })
        const token = readFileSync(tokenFilePath, 'utf8').trim()
        const resp = await fetch(`http://127.0.0.1:${port}/v1/delegate`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ peer: 'codex', prompt: 'recurse', depth: 1 }),
        })
        expect(resp.status).toBe(403)
        const body = await resp.json() as { ok: boolean; reason: string; depth: number }
        expect(body.ok).toBe(false)
        expect(body.reason).toBe('nested_delegate_rejected')
        expect(body.depth).toBe(1)
        expect(dispatchOneShot).not.toHaveBeenCalled()
      })

      it('forwards optional cwd to dispatchOneShot — RFC 03 review #10', async () => {
        api = createInternalApi({ stateDir, daemonPid: 1 })
        const { port, tokenFilePath } = await api.start()
        const dispatchOneShot = vi.fn(async (_peer: string, _prompt: string, _cwd?: string) => ({
          ok: true as const, response: 'ok', duration_ms: 0,
        }))
        api.setDelegate({ dispatchOneShot, knownPeers: () => ['claude', 'codex'] })
        const token = readFileSync(tokenFilePath, 'utf8').trim()
        await fetch(`http://127.0.0.1:${port}/v1/delegate`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ peer: 'codex', prompt: 'p', cwd: '/abs/project' }),
        })
        expect(dispatchOneShot).toHaveBeenCalledWith('codex', 'p', '/abs/project')
      })

      it('rejects non-absolute cwd as 400 — RFC 03 review #10 path safety', async () => {
        api = createInternalApi({ stateDir, daemonPid: 1 })
        const { port, tokenFilePath } = await api.start()
        api.setDelegate({
          dispatchOneShot: async () => ({ ok: true, response: 'x', duration_ms: 0 }),
          knownPeers: () => ['claude', 'codex'],
        })
        const token = readFileSync(tokenFilePath, 'utf8').trim()
        const resp = await fetch(`http://127.0.0.1:${port}/v1/delegate`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ peer: 'codex', prompt: 'p', cwd: 'relative/path' }),
        })
        expect(resp.status).toBe(400)
        // After T7: schema validation fires in index.ts before the handler.
        expect(await resp.json()).toMatchObject({ error: 'invalid_request' })
      })

      it('catches dispatchOneShot throw and returns ok:false', async () => {
        api = createInternalApi({ stateDir, daemonPid: 1 })
        const { port, tokenFilePath } = await api.start()
        api.setDelegate({
          dispatchOneShot: async () => { throw new Error('SDK exploded') },
          knownPeers: () => ['claude', 'codex'],
        })
        const token = readFileSync(tokenFilePath, 'utf8').trim()
        const resp = await fetch(`http://127.0.0.1:${port}/v1/delegate`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ peer: 'codex', prompt: 'hi' }),
        })
        expect(resp.status).toBe(200)
        const body = await resp.json() as { ok: boolean; reason: string }
        expect(body.ok).toBe(false)
        expect(body.reason).toContain('SDK exploded')
      })
    })

    it('returns 503 when ilink dep not wired', async () => {
      api = createInternalApi({ stateDir, daemonPid: 1 })
      const { port, tokenFilePath } = await api.start()
      const token = readFileSync(tokenFilePath, 'utf8').trim()
      for (const path of ['/v1/wechat/reply', '/v1/wechat/send_file', '/v1/wechat/edit_message', '/v1/wechat/broadcast']) {
        const resp = await fetch(`http://127.0.0.1:${port}${path}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: 'c', text: 't', path: '/p', msg_id: 'm' }),
        })
        expect(resp.status).toBe(503)
        expect(await resp.json()).toEqual({ error: 'ilink_not_wired' })
      }
    })
  })
})

// ─── request validation (T7) ──────────────────────────────────────────────────

describe('internal-api request validation', () => {
  let stateDir: string
  let api: import('./internal-api').InternalApi | null = null

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'internal-api-validation-'))
  })
  afterEach(async () => {
    if (api) await api.stop()
    api = null
    rmSync(stateDir, { recursive: true, force: true })
  })

  it('POST with missing required field returns 400 + invalid_request', async () => {
    const memory = makeMemoryFS({ rootDir: join(stateDir, 'memory') })
    api = createInternalApi({ stateDir, daemonPid: 1, memory })
    const { port, tokenFilePath } = await api.start()
    const token = readFileSync(tokenFilePath, 'utf8').trim()
    const resp = await fetch(`http://127.0.0.1:${port}/v1/memory/read`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({}),  // missing required `path`
    })
    expect(resp.status).toBe(400)
    const body = await resp.json() as { error: string; detail: unknown }
    expect(body.error).toBe('invalid_request')
    expect(body.detail).toBeDefined()
  })

  it('POST with valid body has handler receive parsed data (memory read round-trip)', async () => {
    const memory = makeMemoryFS({ rootDir: join(stateDir, 'memory') })
    api = createInternalApi({ stateDir, daemonPid: 1, memory })
    const { port, tokenFilePath } = await api.start()
    const token = readFileSync(tokenFilePath, 'utf8').trim()
    const resp = await fetch(`http://127.0.0.1:${port}/v1/memory/read`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'foo.md' }),
    })
    expect(resp.status).toBe(200)
    const body = await resp.json() as { exists: boolean }
    expect(body.exists).toBe(false)  // file not found, but handler ran correctly
  })

  it('POST to route with no registered schema skips body validation', async () => {
    api = createInternalApi({ stateDir, daemonPid: 1 })
    const { port, tokenFilePath } = await api.start()
    const token = readFileSync(tokenFilePath, 'utf8').trim()
    // POST /v1/companion/enable has no body schema — any body should pass through
    const resp = await fetch(`http://127.0.0.1:${port}/v1/companion/enable`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: '{}',
    })
    // No companion wired — returns 503, not 400; validation did not block it
    expect(resp.status).toBe(503)
    expect(await resp.json()).toMatchObject({ error: 'companion_not_wired' })
  })

  it('GET with valid query string proceeds normally', async () => {
    const memory = makeMemoryFS({ rootDir: join(stateDir, 'memory') })
    api = createInternalApi({ stateDir, daemonPid: 1, memory })
    const { port, tokenFilePath } = await api.start()
    const token = readFileSync(tokenFilePath, 'utf8').trim()
    const resp = await fetch(`http://127.0.0.1:${port}/v1/memory/list?dir=sub`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(resp.status).toBe(200)
    const body = await resp.json() as { files: string[] }
    expect(body.files).toBeDefined()
  })

  // ─── POST /v1/a2a/send route ───────────────────────────────────────────────

  describe('POST /v1/a2a/send', () => {
    interface RecordedEvent {
      direction: 'in' | 'out'
      agent_id: string
      text: string
      status: string
      http_status?: number
    }

    function makeA2ADeps(opts: {
      agents?: Array<{ id: string; url: string; outbound_api_key: string; paused?: boolean }>
      sendResult?: SendResult
      cardResult?: AgentCard | Error
      serverEnabled?: boolean
      baseUrl?: string | null
    } = {}) {
      const agentsList = opts.agents ?? []
      const events: RecordedEvent[] = []
      // In-memory events store backed by a simple array
      const eventRows: EventRow[] = []

      const registry: A2ARegistry = {
        list: () => agentsList.map(a => ({
          id: a.id,
          name: a.id,
          url: a.url,
          outbound_api_key: a.outbound_api_key,
          inbound_api_key: 'unused-inbound',
          capabilities: [] as string[],
          paused: a.paused ?? false,
          transport: 'push' as const,
        })),
        get: (id) => {
          const a = agentsList.find(x => x.id === id)
          if (!a) return null
          return { id: a.id, name: a.id, url: a.url, outbound_api_key: a.outbound_api_key, inbound_api_key: 'unused-inbound', capabilities: [] as string[], paused: a.paused ?? false, transport: 'push' as const }
        },
        verifyBearer: () => null,
        add: () => { /* send tests don't exercise add */ },
        remove: () => {},
        setPaused: () => {},
        update: (id, _patch) => ({
          id, name: id, url: '', inbound_api_key: 'unused-inbound', outbound_api_key: '',
          capabilities: [] as string[], paused: false, transport: 'push' as const,
        }),
      }

      const defaultSendResult: SendResult = opts.sendResult ?? { ok: true, http_status: 200, response: { received: true } }
      const cardResult = opts.cardResult

      const client: A2AClient = {
        fetchAgentCard: async () => {
          if (cardResult instanceof Error) throw cardResult
          return cardResult ?? { name: 'test-agent' }
        },
        send: async () => defaultSendResult,
      }

      const recordEvent = (event: RecordedEvent) => { events.push(event) }

      const eventsStore: A2AEventsStore = {
        append: (input: AppendInput) => {
          eventRows.push({
            id: crypto.randomUUID(),
            ts: new Date().toISOString(),
            direction: input.direction,
            agent_id: input.agent_id,
            text: input.text,
            urgency: input.urgency ?? null,
            status: input.status,
            http_status: input.http_status ?? null,
          })
        },
        recentForAgent: (agentId: string, limit: number) =>
          eventRows.filter(r => r.agent_id === agentId).slice(-limit).reverse(),
        counts: (agentId: string) => {
          const rows = eventRows.filter(r => r.agent_id === agentId)
          return {
            inbound: rows.filter(r => r.direction === 'in').length,
            outbound: rows.filter(r => r.direction === 'out').length,
          }
        },
      }

      return {
        registry,
        client,
        recordEvent,
        eventsStore,
        serverEnabled: opts.serverEnabled ?? false,
        baseUrl: opts.baseUrl !== undefined ? opts.baseUrl : null,
        events,
        eventRows,
      }
    }

    it('returns 503 when a2a deps not wired', async () => {
      api = createInternalApi({ stateDir, daemonPid: 1 })
      const { port, tokenFilePath } = await api.start()
      const token = readFileSync(tokenFilePath, 'utf8').trim()
      const resp = await fetch(`http://127.0.0.1:${port}/v1/a2a/send`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ agent_id: 'x', text: 'hi' }),
      })
      expect(resp.status).toBe(503)
      expect(await resp.json()).toMatchObject({ error: 'a2a_not_wired' })
    })

    it('returns ok=false + registered list when agent_id unknown', async () => {
      const a2aD = makeA2ADeps({ agents: [{ id: 'bot-a', url: 'http://a', outbound_api_key: 'k1' }] })
      api = createInternalApi({ stateDir, daemonPid: 1, a2a: a2aD })
      const { port, tokenFilePath } = await api.start()
      const token = readFileSync(tokenFilePath, 'utf8').trim()
      const resp = await fetch(`http://127.0.0.1:${port}/v1/a2a/send`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ agent_id: 'no-such', text: 'hi' }),
      })
      expect(resp.status).toBe(200)
      const body = await resp.json() as { ok: boolean; error: string; registered: string[] }
      expect(body.ok).toBe(false)
      expect(body.error).toBe('unknown_agent')
      expect(body.registered).toEqual(['bot-a'])
    })

    it('returns ok=false agent_paused + records event with status=agent_paused', async () => {
      const a2aDeps = makeA2ADeps({ agents: [{ id: 'bot-p', url: 'http://p', outbound_api_key: 'k2', paused: true }] })
      api = createInternalApi({ stateDir, daemonPid: 1, a2a: a2aDeps })
      const { port, tokenFilePath } = await api.start()
      const token = readFileSync(tokenFilePath, 'utf8').trim()
      const resp = await fetch(`http://127.0.0.1:${port}/v1/a2a/send`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ agent_id: 'bot-p', text: 'hello' }),
      })
      expect(resp.status).toBe(200)
      const body = await resp.json() as { ok: boolean; error: string }
      expect(body.ok).toBe(false)
      expect(body.error).toBe('agent_paused')
      expect(a2aDeps.events).toHaveLength(1)
      expect(a2aDeps.events[0]).toMatchObject({ direction: 'out', agent_id: 'bot-p', text: 'hello', status: 'agent_paused' })
    })

    it('successful send returns ok=true + http_status + records event with status=ok', async () => {
      const a2aDeps = makeA2ADeps({
        agents: [{ id: 'bot-ok', url: 'http://ok', outbound_api_key: 'k3' }],
        sendResult: { ok: true, http_status: 200, response: { received: true } },
      })
      api = createInternalApi({ stateDir, daemonPid: 1, a2a: a2aDeps })
      const { port, tokenFilePath } = await api.start()
      const token = readFileSync(tokenFilePath, 'utf8').trim()
      const resp = await fetch(`http://127.0.0.1:${port}/v1/a2a/send`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ agent_id: 'bot-ok', text: 'ping' }),
      })
      expect(resp.status).toBe(200)
      const body = await resp.json() as { ok: boolean; http_status: number; response: unknown }
      expect(body.ok).toBe(true)
      expect(body.http_status).toBe(200)
      expect(a2aDeps.events).toHaveLength(1)
      expect(a2aDeps.events[0]).toMatchObject({ direction: 'out', agent_id: 'bot-ok', text: 'ping', status: 'ok', http_status: 200 })
    })

    it('http_error from client returns ok=false + http_status + records event with status=http_error', async () => {
      const a2aDeps = makeA2ADeps({
        agents: [{ id: 'bot-err', url: 'http://err', outbound_api_key: 'k4' }],
        sendResult: { ok: false, http_status: 500, error: 'http_500' },
      })
      api = createInternalApi({ stateDir, daemonPid: 1, a2a: a2aDeps })
      const { port, tokenFilePath } = await api.start()
      const token = readFileSync(tokenFilePath, 'utf8').trim()
      const resp = await fetch(`http://127.0.0.1:${port}/v1/a2a/send`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ agent_id: 'bot-err', text: 'test' }),
      })
      expect(resp.status).toBe(200)
      const body = await resp.json() as { ok: boolean; error: string; http_status: number }
      expect(body.ok).toBe(false)
      expect(body.error).toBe('http_500')
      expect(body.http_status).toBe(500)
      expect(a2aDeps.events).toHaveLength(1)
      expect(a2aDeps.events[0]).toMatchObject({ direction: 'out', agent_id: 'bot-err', status: 'http_error', http_status: 500 })
    })

    it('timeout from client records event with status=timeout', async () => {
      const a2aDeps = makeA2ADeps({
        agents: [{ id: 'bot-slow', url: 'http://slow', outbound_api_key: 'k5' }],
        sendResult: { ok: false, error: 'timeout after 10000ms' },
      })
      api = createInternalApi({ stateDir, daemonPid: 1, a2a: a2aDeps })
      const { port, tokenFilePath } = await api.start()
      const token = readFileSync(tokenFilePath, 'utf8').trim()
      const resp = await fetch(`http://127.0.0.1:${port}/v1/a2a/send`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ agent_id: 'bot-slow', text: 'slow' }),
      })
      expect(resp.status).toBe(200)
      const body = await resp.json() as { ok: boolean; error: string }
      expect(body.ok).toBe(false)
      expect(a2aDeps.events).toHaveLength(1)
      expect(a2aDeps.events[0]).toMatchObject({ direction: 'out', agent_id: 'bot-slow', status: 'timeout' })
    })

    it('returns 400 when agent_id is empty string (schema validation)', async () => {
      const a2aDeps = makeA2ADeps()
      api = createInternalApi({ stateDir, daemonPid: 1, a2a: a2aDeps })
      const { port, tokenFilePath } = await api.start()
      const token = readFileSync(tokenFilePath, 'utf8').trim()
      const resp = await fetch(`http://127.0.0.1:${port}/v1/a2a/send`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ agent_id: '', text: 'hi' }),
      })
      expect(resp.status).toBe(400)
      expect(await resp.json()).toMatchObject({ error: 'invalid_request' })
    })
  })

  // ─── A2A dashboard routes ──────────────────────────────────────────────────

  describe('internal-api A2A routes', () => {
    // Shared helper to start with a2a deps wired
    async function startWithA2A(
      a2aDeps: ReturnType<typeof buildA2ADeps>,
    ): Promise<{ port: number; token: string }> {
      api = createInternalApi({ stateDir, daemonPid: 1, a2a: a2aDeps })
      const { port, tokenFilePath } = await api.start()
      const token = readFileSync(tokenFilePath, 'utf8').trim()
      return { port, token }
    }

    interface RecordedEventDash {
      direction: 'in' | 'out'
      agent_id: string
      text: string
      status: string
      http_status?: number
    }

    function buildA2ADeps(opts: {
      agents?: Array<{ id: string; name?: string; url: string; outbound_api_key: string; paused?: boolean }>
      sendResult?: SendResult
      cardResult?: AgentCard | Error
      serverEnabled?: boolean
      baseUrl?: string | null
    } = {}) {
      type AgentEntry = { id: string; name: string; url: string; outbound_api_key: string; inbound_api_key: string; capabilities: string[]; paused: boolean; transport: 'push' | 'ws' }
      const agentsList: AgentEntry[] = (opts.agents ?? []).map(a => ({
        id: a.id, name: a.name ?? a.id, url: a.url,
        outbound_api_key: a.outbound_api_key, inbound_api_key: 'unused-inbound',
        capabilities: [], paused: a.paused ?? false, transport: 'push',
      }))
      const eventRows: EventRow[] = []

      const registry: A2ARegistry = {
        list: () => agentsList,
        get: (id) => agentsList.find(x => x.id === id) ?? null,
        verifyBearer: () => null,
        add: (rec) => {
          if (agentsList.some(a => a.id === rec.id)) throw new Error(`a2a agent '${rec.id}' already exists`)
          agentsList.push({
            id: rec.id, name: rec.name, url: rec.url,
            outbound_api_key: rec.outbound_api_key ?? '',
            inbound_api_key: rec.inbound_api_key,
            capabilities: rec.capabilities ?? [],
            paused: rec.paused ?? false,
            transport: rec.transport ?? 'push',
          })
        },
        remove: (id) => {
          const ix = agentsList.findIndex(a => a.id === id)
          if (ix < 0) throw new Error(`a2a agent '${id}' not found`)
          agentsList.splice(ix, 1)
        },
        setPaused: (id, paused) => {
          const a = agentsList.find(x => x.id === id)
          if (!a) throw new Error(`a2a agent '${id}' not found`)
          a.paused = paused
        },
        update: (id, patch) => {
          const a = agentsList.find(x => x.id === id)
          if (!a) throw new Error(`a2a agent '${id}' not found`)
          if (patch.name !== undefined) a.name = patch.name
          if (patch.url !== undefined) a.url = patch.url
          if (patch.inbound_api_key !== undefined) a.inbound_api_key = patch.inbound_api_key
          if (patch.outbound_api_key !== undefined) a.outbound_api_key = patch.outbound_api_key
          return a
        },
      }

      const cardResult = opts.cardResult
      const client: A2AClient = {
        fetchAgentCard: async () => {
          if (cardResult instanceof Error) throw cardResult
          return cardResult ?? { name: 'test-agent', description: 'A test agent' }
        },
        send: async () => opts.sendResult ?? { ok: true, http_status: 200 },
      }

      const recordEvent = (event: RecordedEventDash) => {
        eventRows.push({
          id: crypto.randomUUID(),
          ts: new Date().toISOString(),
          direction: event.direction,
          agent_id: event.agent_id,
          text: event.text,
          urgency: null,
          status: event.status as EventRow['status'],
          http_status: event.http_status ?? null,
        })
      }

      const eventsStore: A2AEventsStore = {
        append: (input: AppendInput) => {
          eventRows.push({
            id: crypto.randomUUID(),
            ts: new Date().toISOString(),
            direction: input.direction,
            agent_id: input.agent_id,
            text: input.text,
            urgency: input.urgency ?? null,
            status: input.status,
            http_status: input.http_status ?? null,
          })
        },
        recentForAgent: (agentId: string, limit: number) =>
          [...eventRows].filter(r => r.agent_id === agentId).slice(0, limit),
        counts: (agentId: string) => {
          const rows = eventRows.filter(r => r.agent_id === agentId)
          return {
            inbound: rows.filter(r => r.direction === 'in').length,
            outbound: rows.filter(r => r.direction === 'out').length,
          }
        },
      }

      return {
        registry,
        client,
        recordEvent,
        eventsStore,
        serverEnabled: opts.serverEnabled ?? false,
        baseUrl: opts.baseUrl !== undefined ? opts.baseUrl : null,
        eventRows,
      }
    }

    it('GET /v1/a2a/list returns registered agents with counts', async () => {
      const a2aDeps = buildA2ADeps({
        agents: [
          { id: 'agent-1', url: 'http://agent1.test', outbound_api_key: 'k1' },
          { id: 'agent-2', url: 'http://agent2.test', outbound_api_key: 'k2', paused: true },
        ],
      })
      // Seed two inbound events for agent-1
      a2aDeps.eventsStore.append({ direction: 'in', agent_id: 'agent-1', text: 'hello', status: 'ok' })
      a2aDeps.eventsStore.append({ direction: 'out', agent_id: 'agent-1', text: 'reply', status: 'ok' })
      const { port, token } = await startWithA2A(a2aDeps)
      const resp = await fetch(`http://127.0.0.1:${port}/v1/a2a/list`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(resp.status).toBe(200)
      const body = await resp.json() as { agents: Array<{ id: string; name: string; url: string; paused: boolean; counts: { inbound: number; outbound: number } }> }
      expect(body.agents).toHaveLength(2)
      const a1 = body.agents.find(a => a.id === 'agent-1')
      expect(a1).toBeDefined()
      expect(a1!.paused).toBe(false)
      expect(a1!.counts).toEqual({ inbound: 1, outbound: 1 })
      const a2 = body.agents.find(a => a.id === 'agent-2')
      expect(a2!.paused).toBe(true)
      expect(a2!.counts).toEqual({ inbound: 0, outbound: 0 })
    })

    it('GET /v1/a2a/list returns empty array when no agents registered', async () => {
      const a2aDeps = buildA2ADeps()
      const { port, token } = await startWithA2A(a2aDeps)
      const resp = await fetch(`http://127.0.0.1:${port}/v1/a2a/list`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(resp.status).toBe(200)
      const body = await resp.json() as { agents: unknown[] }
      expect(body.agents).toEqual([])
    })

    it('POST /v1/a2a/preview returns Agent Card metadata', async () => {
      // Use a Bun.serve fake to expose /.well-known/agent.json
      const card: AgentCard = {
        name: 'My Agent',
        description: 'Does stuff',
        version: '1.0.0',
        capabilities: [{ name: 'chat', endpoint: '/v1/chat', method: 'POST' }],
      }
      const fake = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch(req) {
          const url = new URL(req.url)
          if (url.pathname === '/.well-known/agent.json') {
            return Response.json(card)
          }
          return new Response('not found', { status: 404 })
        },
      })
      try {
        const baseUrl = `http://127.0.0.1:${fake.port}`
        const a2aDeps = buildA2ADeps({ cardResult: card })
        // Use a custom client that actually hits the fake server
        const { createA2AClient } = await import('../core/a2a-client')
        const realClient = createA2AClient({ timeoutMs: 2000 })
        a2aDeps.client.fetchAgentCard = (url: string) => realClient.fetchAgentCard(url)

        const { port, token } = await startWithA2A(a2aDeps)
        const resp = await fetch(`http://127.0.0.1:${port}/v1/a2a/preview`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ url: baseUrl }),
        })
        expect(resp.status).toBe(200)
        const body = await resp.json() as AgentCard
        expect(body.name).toBe('My Agent')
        expect(body.description).toBe('Does stuff')
      } finally {
        await fake.stop()
      }
    })

    it('POST /v1/a2a/preview returns { error } on fetch failure', async () => {
      const a2aDeps = buildA2ADeps({ cardResult: new Error('ECONNREFUSED') })
      const { port, token } = await startWithA2A(a2aDeps)
      const resp = await fetch(`http://127.0.0.1:${port}/v1/a2a/preview`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'http://127.0.0.1:19999' }),
      })
      expect(resp.status).toBe(200)
      const body = await resp.json() as { error: string }
      expect(body.error).toBeDefined()
      expect(typeof body.error).toBe('string')
    })

    it('POST /v1/a2a/install generates inbound_api_key and persists', async () => {
      const a2aDeps = buildA2ADeps()
      const { port, token } = await startWithA2A(a2aDeps)
      const resp = await fetch(`http://127.0.0.1:${port}/v1/a2a/install`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'new-agent', name: 'New Agent', url: 'http://new.test', outbound_api_key: 'outkey' }),
      })
      expect(resp.status).toBe(200)
      const body = await resp.json() as { ok: boolean; inbound_api_key: string }
      expect(body.ok).toBe(true)
      expect(body.inbound_api_key).toMatch(/^wc_[0-9a-f]{32}$/)
      // Verify registry now has the agent
      expect(a2aDeps.registry.get('new-agent')).not.toBeNull()
      expect(a2aDeps.registry.get('new-agent')!.name).toBe('New Agent')
      expect(a2aDeps.registry.get('new-agent')!.inbound_api_key).toBe(body.inbound_api_key)
    })

    it('POST /v1/a2a/install fails on duplicate id', async () => {
      const a2aDeps = buildA2ADeps({ agents: [{ id: 'dup-agent', url: 'http://dup.test', outbound_api_key: 'k' }] })
      const { port, token } = await startWithA2A(a2aDeps)
      const resp = await fetch(`http://127.0.0.1:${port}/v1/a2a/install`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'dup-agent', name: 'Dup', url: 'http://dup2.test', outbound_api_key: 'k' }),
      })
      expect(resp.status).toBe(200)
      const body = await resp.json() as { ok: boolean; error: string }
      expect(body.ok).toBe(false)
      expect(body.error).toMatch(/exists/)
    })

    it('POST /v1/a2a/install rejects empty outbound_api_key', async () => {
      // Regression: pre-fix the route fell back to '(none)' which then
      // went out as `Authorization: Bearer (none)` and 401'd silently.
      // Reject up front with a clear error.
      const a2aDeps = buildA2ADeps()
      const { port, token } = await startWithA2A(a2aDeps)
      const resp = await fetch(`http://127.0.0.1:${port}/v1/a2a/install`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'new-agent', name: 'New', url: 'http://new.test' }),
      })
      expect(resp.status).toBe(200)
      const body = await resp.json() as { ok: boolean; error: string }
      expect(body.ok).toBe(false)
      expect(body.error).toMatch(/outbound_api_key/)
    })

    it('POST /v1/a2a/install returns 400 on invalid id format', async () => {
      const a2aDeps = buildA2ADeps()
      const { port, token } = await startWithA2A(a2aDeps)
      const resp = await fetch(`http://127.0.0.1:${port}/v1/a2a/install`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'INVALID ID', name: 'X', url: 'http://x.test' }),
      })
      expect(resp.status).toBe(400)
      expect(await resp.json()).toMatchObject({ error: 'invalid_request' })
    })

    it('POST /v1/a2a/remove drops an agent', async () => {
      const a2aDeps = buildA2ADeps({ agents: [{ id: 'rm-agent', url: 'http://rm.test', outbound_api_key: 'k' }] })
      const { port, token } = await startWithA2A(a2aDeps)
      const resp = await fetch(`http://127.0.0.1:${port}/v1/a2a/remove`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'rm-agent' }),
      })
      expect(resp.status).toBe(200)
      const body = await resp.json() as { ok: boolean }
      expect(body.ok).toBe(true)
      expect(a2aDeps.registry.get('rm-agent')).toBeNull()
    })

    it('POST /v1/a2a/remove returns ok=false for unknown agent', async () => {
      const a2aDeps = buildA2ADeps()
      const { port, token } = await startWithA2A(a2aDeps)
      const resp = await fetch(`http://127.0.0.1:${port}/v1/a2a/remove`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'no-such' }),
      })
      expect(resp.status).toBe(200)
      const body = await resp.json() as { ok: boolean; error: string }
      expect(body.ok).toBe(false)
      expect(body.error).toMatch(/not found/)
    })

    it('POST /v1/a2a/pause flips the paused flag', async () => {
      const a2aDeps = buildA2ADeps({ agents: [{ id: 'pausable', url: 'http://p.test', outbound_api_key: 'k', paused: false }] })
      const { port, token } = await startWithA2A(a2aDeps)
      // Pause it
      const r1 = await fetch(`http://127.0.0.1:${port}/v1/a2a/pause`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'pausable', paused: true }),
      })
      expect(r1.status).toBe(200)
      expect((await r1.json() as { ok: boolean }).ok).toBe(true)
      expect(a2aDeps.registry.get('pausable')!.paused).toBe(true)
      // Unpause it
      const r2 = await fetch(`http://127.0.0.1:${port}/v1/a2a/pause`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'pausable', paused: false }),
      })
      expect(r2.status).toBe(200)
      expect((await r2.json() as { ok: boolean }).ok).toBe(true)
      expect(a2aDeps.registry.get('pausable')!.paused).toBe(false)
    })

    it('POST /v1/a2a/pause returns ok=false for unknown agent', async () => {
      const a2aDeps = buildA2ADeps()
      const { port, token } = await startWithA2A(a2aDeps)
      const resp = await fetch(`http://127.0.0.1:${port}/v1/a2a/pause`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'ghost', paused: true }),
      })
      expect(resp.status).toBe(200)
      const body = await resp.json() as { ok: boolean; error: string }
      expect(body.ok).toBe(false)
    })

    it('GET /v1/a2a/activity returns recent events for agent', async () => {
      const a2aDeps = buildA2ADeps({ agents: [{ id: 'ev-agent', url: 'http://ev.test', outbound_api_key: 'k' }] })
      a2aDeps.eventsStore.append({ direction: 'in', agent_id: 'ev-agent', text: 'msg1', status: 'ok' })
      a2aDeps.eventsStore.append({ direction: 'out', agent_id: 'ev-agent', text: 'msg2', status: 'ok' })
      // event for different agent — should not appear
      a2aDeps.eventsStore.append({ direction: 'in', agent_id: 'other-agent', text: 'other', status: 'ok' })
      const { port, token } = await startWithA2A(a2aDeps)
      const resp = await fetch(`http://127.0.0.1:${port}/v1/a2a/activity?agent_id=ev-agent&limit=10`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(resp.status).toBe(200)
      const body = await resp.json() as { events: EventRow[] }
      expect(body.events).toHaveLength(2)
      expect(body.events.every(e => e.agent_id === 'ev-agent')).toBe(true)
    })

    it('GET /v1/a2a/activity returns 400 when agent_id missing', async () => {
      const a2aDeps = buildA2ADeps()
      const { port, token } = await startWithA2A(a2aDeps)
      const resp = await fetch(`http://127.0.0.1:${port}/v1/a2a/activity`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(resp.status).toBe(400)
      expect(await resp.json()).toMatchObject({ error: 'agent_id required' })
    })

    it('GET /v1/a2a/info returns server status when enabled', async () => {
      const a2aDeps = buildA2ADeps({ serverEnabled: true, baseUrl: 'http://127.0.0.1:9876' })
      const { port, token } = await startWithA2A(a2aDeps)
      const resp = await fetch(`http://127.0.0.1:${port}/v1/a2a/info`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(resp.status).toBe(200)
      const body = await resp.json() as { enabled: boolean; base_url: string | null }
      expect(body.enabled).toBe(true)
      expect(body.base_url).toBe('http://127.0.0.1:9876')
    })

    it('GET /v1/a2a/info returns enabled=false when server disabled', async () => {
      const a2aDeps = buildA2ADeps({ serverEnabled: false, baseUrl: null })
      const { port, token } = await startWithA2A(a2aDeps)
      const resp = await fetch(`http://127.0.0.1:${port}/v1/a2a/info`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(resp.status).toBe(200)
      const body = await resp.json() as { enabled: boolean; base_url: string | null }
      expect(body.enabled).toBe(false)
      expect(body.base_url).toBeNull()
    })

    it('GET /v1/turns?chatId returns that chat\'s turns newest-first', async () => {
      const db = openTestDb()
      const store = makeTurnRecordStore(db)
      const base: TurnRecord = {
        chatId: 'chat-1', provider: 'claude', alias: 'a', mode: 'solo',
        startedAt: 0, endedAt: 0, durationMs: 0, outcome: 'completed',
        replyToolCalled: true, textChunks: 1,
      }
      store.append({ ...base, endedAt: 100 })
      store.append({ ...base, endedAt: 300, outcome: 'timeout', error: 'stalled' })
      store.append({ ...base, chatId: 'chat-2', endedAt: 200 }) // other chat — excluded
      api = createInternalApi({ stateDir, daemonPid: 1, turns: store })
      const { port, tokenFilePath } = await api.start()
      const token = api.mintSessionToken('admin', 'test')
      const resp = await fetch(`http://127.0.0.1:${port}/v1/turns?chatId=chat-1&limit=10`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(resp.status).toBe(200)
      const body = await resp.json() as { turns: Array<TurnRecord & { id: string }> }
      expect(body.turns.map(t => t.endedAt)).toEqual([300, 100])
      expect(body.turns.every(t => t.chatId === 'chat-1')).toBe(true)
      expect(body.turns[0]).toMatchObject({ outcome: 'timeout', error: 'stalled', replyToolCalled: true })
    })

    it('GET /v1/turns without chatId returns recent turns across all chats', async () => {
      const db = openTestDb()
      const store = makeTurnRecordStore(db)
      const base: TurnRecord = {
        chatId: 'x', provider: 'codex', alias: 'a', mode: 'parallel',
        startedAt: 0, endedAt: 0, durationMs: 0, outcome: 'completed',
        replyToolCalled: false, textChunks: 0,
      }
      store.append({ ...base, chatId: 'chat-A', endedAt: 100 })
      store.append({ ...base, chatId: 'chat-B', endedAt: 300 })
      api = createInternalApi({ stateDir, daemonPid: 1, turns: store })
      const { port, tokenFilePath } = await api.start()
      const token = api.mintSessionToken('admin', 'test')
      const resp = await fetch(`http://127.0.0.1:${port}/v1/turns`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(resp.status).toBe(200)
      const body = await resp.json() as { turns: Array<{ chatId: string }> }
      expect(body.turns.map(t => t.chatId)).toEqual(['chat-B', 'chat-A'])
    })

    it('file token is trusted: 403 on an admin route, not-403 on a trusted route', async () => {
      const db = openTestDb()
      api = createInternalApi({ stateDir, daemonPid: 1, turns: makeTurnRecordStore(db), listSessions: () => [] })
      const { port, tokenFilePath } = await api.start()
      const fileToken = readFileSync(tokenFilePath, 'utf8').trim()
      const r1 = await fetch(`http://127.0.0.1:${port}/v1/daemon/restart`, {
        method: 'POST', headers: { Authorization: `Bearer ${fileToken}`, 'content-type': 'application/json' }, body: '{}',
      })
      expect(r1.status).toBe(403)
      expect(await r1.json()).toMatchObject({ error: 'forbidden', required: 'admin' })
      const r2 = await fetch(`http://127.0.0.1:${port}/v1/health`, { headers: { Authorization: `Bearer ${fileToken}` } })
      expect(r2.status).not.toBe(403)
    })

    it('a minted admin session token reaches an admin route; invalidate revokes it', async () => {
      api = createInternalApi({ stateDir, daemonPid: 1, requestRestart: () => {} })
      const { port } = await api.start()
      const adminTok = api.mintSessionToken('admin', 'claude/a/chat-1')
      const ok = await fetch(`http://127.0.0.1:${port}/v1/daemon/restart`, {
        method: 'POST', headers: { Authorization: `Bearer ${adminTok}`, 'content-type': 'application/json' }, body: '{}',
      })
      expect(ok.status).toBe(200)
      api.invalidateSession('claude/a/chat-1')
      const revoked = await fetch(`http://127.0.0.1:${port}/v1/daemon/restart`, {
        method: 'POST', headers: { Authorization: `Bearer ${adminTok}`, 'content-type': 'application/json' }, body: '{}',
      })
      expect(revoked.status).toBe(401)
    })

    it('GET /v1/sessions lists live sessions when wired', async () => {
      const sessions = [
        { alias: 'a', path: '/p', providerId: 'claude', chatId: 'chat-1', lastUsedAt: 111 },
        { alias: 'b', path: '/q', providerId: 'codex', chatId: 'chat-2', lastUsedAt: 222 },
      ]
      api = createInternalApi({ stateDir, daemonPid: 1, listSessions: () => sessions })
      const { port, tokenFilePath } = await api.start()
      const token = api.mintSessionToken('admin', 'test')
      const resp = await fetch(`http://127.0.0.1:${port}/v1/sessions`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(resp.status).toBe(200)
      const body = await resp.json() as { sessions: typeof sessions }
      expect(body.sessions).toEqual(sessions)
    })

    it('GET /v1/sessions returns 503 when the session manager is not wired', async () => {
      api = createInternalApi({ stateDir, daemonPid: 1, listSessions: () => null })
      const { port, tokenFilePath } = await api.start()
      const token = api.mintSessionToken('admin', 'test')
      const resp = await fetch(`http://127.0.0.1:${port}/v1/sessions`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(resp.status).toBe(503)
      expect(await resp.json()).toMatchObject({ error: 'sessions_not_wired' })
    })

    it('GET /v1/health reports ops fields (turns wired, live session count, heartbeat)', async () => {
      const db = openTestDb()
      const store = makeTurnRecordStore(db)
      api = createInternalApi({
        stateDir, daemonPid: 7, turns: store,
        listSessions: () => [{ alias: 'a', path: '/p', providerId: 'claude', chatId: 'c', lastUsedAt: 1 }],
        heartbeatFresh: () => true,
      })
      const { port, tokenFilePath } = await api.start()
      const token = api.mintSessionToken('admin', 'test')
      const resp = await fetch(`http://127.0.0.1:${port}/v1/health`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(resp.status).toBe(200)
      const body = await resp.json() as { ok: boolean; daemon_pid: number; turns_store_wired: boolean; sessions_live: number; heartbeat_fresh: boolean }
      expect(body).toMatchObject({ ok: true, daemon_pid: 7, turns_store_wired: true, sessions_live: 1, heartbeat_fresh: true })
    })

    it('POST /v1/sessions/release calls the releaser and returns the post-release session list', async () => {
      const released: Array<{ alias: string; providerId: string; chatId: string }> = []
      let live = [{ alias: 'a', path: '/p', providerId: 'claude', chatId: 'c', lastUsedAt: 1 }]
      api = createInternalApi({
        stateDir, daemonPid: 1,
        releaseSession: async (k) => { released.push(k); live = [] },
        listSessions: () => live,
      })
      const { port, tokenFilePath } = await api.start()
      const token = api.mintSessionToken('admin', 'test')
      const resp = await fetch(`http://127.0.0.1:${port}/v1/sessions/release`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ alias: 'a', providerId: 'claude', chatId: 'c' }),
      })
      expect(resp.status).toBe(200)
      const body = await resp.json() as { ok: boolean; released: boolean; sessions: unknown[] }
      expect(body.ok).toBe(true)
      expect(body.released).toBe(true) // the session was actually live
      expect(released).toEqual([{ alias: 'a', providerId: 'claude', chatId: 'c' }])
      expect(body.sessions).toEqual([]) // read-back confirms it's gone
    })

    it('POST /v1/sessions/release reports released:false for a no-op (nothing matched)', async () => {
      api = createInternalApi({
        stateDir, daemonPid: 1,
        releaseSession: async () => {}, // no-op
        listSessions: () => [{ alias: 'a', path: '/p', providerId: 'claude', chatId: 'other', lastUsedAt: 1 }],
      })
      const { port } = await api.start()
      const token = api.mintSessionToken('admin', 'test')
      const resp = await fetch(`http://127.0.0.1:${port}/v1/sessions/release`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ alias: 'a', providerId: 'claude', chatId: 'nonexistent' }),
      })
      expect(resp.status).toBe(200)
      expect(await resp.json()).toMatchObject({ ok: true, released: false })
    })

    it('POST /v1/sessions/release 400 on missing fields, 503 when unwired', async () => {
      api = createInternalApi({ stateDir, daemonPid: 1 })
      const { port, tokenFilePath } = await api.start()
      const token = api.mintSessionToken('admin', 'test')
      const r503 = await fetch(`http://127.0.0.1:${port}/v1/sessions/release`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ alias: 'a', providerId: 'claude', chatId: 'c' }),
      })
      expect(r503.status).toBe(503)

      const api2 = createInternalApi({ stateDir, daemonPid: 1, releaseSession: async () => {} })
      try {
        const s2 = await api2.start()
        const t2 = api2.mintSessionToken('admin', 'test')
        const r400 = await fetch(`http://127.0.0.1:${s2.port}/v1/sessions/release`, {
          method: 'POST', headers: { Authorization: `Bearer ${t2}`, 'content-type': 'application/json' },
          body: JSON.stringify({ alias: 'a' }),
        })
        expect(r400.status).toBe(400)
      } finally { await api2.stop() }
    })

    it('GET /v1/model reads and POST /v1/model persists the pinned model (read-back)', async () => {
      saveAgentConfig(stateDir, { provider: 'claude', model: 'claude-opus-4-8', dangerouslySkipPermissions: true, autoStart: true, closeStopsDaemon: false })
      api = createInternalApi({ stateDir, daemonPid: 1 })
      const { port, tokenFilePath } = await api.start()
      const token = api.mintSessionToken('admin', 'test')
      const got = await (await fetch(`http://127.0.0.1:${port}/v1/model`, { headers: { Authorization: `Bearer ${token}` } })).json() as { model: string }
      expect(got.model).toBe('claude-opus-4-8')
      const set = await fetch(`http://127.0.0.1:${port}/v1/model`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude-sonnet-4-6' }),
      })
      expect(set.status).toBe(200)
      expect((await set.json() as { model: string }).model).toBe('claude-sonnet-4-6')
      // persisted on disk
      expect(loadAgentConfig(stateDir).model).toBe('claude-sonnet-4-6')

      // Bare aliases / fast-mode tags are rejected (the 404-every-turn footgun)
      // and must NOT overwrite the good pinned model.
      for (const bad of ['opus', 'opus[1m]', 'sonnet', 'claude opus']) {
        const r = await fetch(`http://127.0.0.1:${port}/v1/model`, {
          method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ model: bad }),
        })
        expect(r.status).toBe(400)
      }
      expect(loadAgentConfig(stateDir).model).toBe('claude-sonnet-4-6') // unchanged
    })

    it('POST /v1/daemon/restart triggers the restart hook; 503 when unwired', async () => {
      let restarts = 0
      api = createInternalApi({ stateDir, daemonPid: 1, requestRestart: () => { restarts++ } })
      const { port, tokenFilePath } = await api.start()
      const token = api.mintSessionToken('admin', 'test')
      const resp = await fetch(`http://127.0.0.1:${port}/v1/daemon/restart`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}',
      })
      expect(resp.status).toBe(200)
      expect(await resp.json()).toMatchObject({ ok: true, restarting: true })
      expect(restarts).toBe(1)

      const api2 = createInternalApi({ stateDir, daemonPid: 1 })
      try {
        const s2 = await api2.start()
        const t2 = api2.mintSessionToken('admin', 'test')
        const r503 = await fetch(`http://127.0.0.1:${s2.port}/v1/daemon/restart`, {
          method: 'POST', headers: { Authorization: `Bearer ${t2}`, 'content-type': 'application/json' }, body: '{}',
        })
        expect(r503.status).toBe(503)
      } finally { await api2.stop() }
    })

    it('GET /v1/turns returns 503 when the turns store is not wired', async () => {
      api = createInternalApi({ stateDir, daemonPid: 1 })
      const { port, tokenFilePath } = await api.start()
      const token = api.mintSessionToken('admin', 'test')
      const resp = await fetch(`http://127.0.0.1:${port}/v1/turns`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(resp.status).toBe(503)
      expect(await resp.json()).toMatchObject({ error: 'turns_not_wired' })
    })

    it('All A2A routes return 503 when deps.a2a is undefined', async () => {
      api = createInternalApi({ stateDir, daemonPid: 1 })
      const { port, tokenFilePath } = await api.start()
      const token = readFileSync(tokenFilePath, 'utf8').trim()

      const routes: Array<{ method: string; path: string; body?: unknown }> = [
        { method: 'GET', path: '/v1/a2a/list' },
        { method: 'POST', path: '/v1/a2a/preview', body: { url: 'http://x.test' } },
        { method: 'POST', path: '/v1/a2a/install', body: { id: 'x', name: 'X', url: 'http://x.test' } },
        { method: 'POST', path: '/v1/a2a/remove', body: { id: 'x' } },
        { method: 'POST', path: '/v1/a2a/pause', body: { id: 'x', paused: true } },
        { method: 'GET', path: '/v1/a2a/activity?agent_id=x' },
        { method: 'GET', path: '/v1/a2a/info' },
      ]

      for (const route of routes) {
        const fetchOpts: RequestInit = {
          method: route.method,
          headers: {
            Authorization: `Bearer ${token}`,
            ...(route.body ? { 'content-type': 'application/json' } : {}),
          },
          ...(route.body ? { body: JSON.stringify(route.body) } : {}),
        }
        const resp = await fetch(`http://127.0.0.1:${port}${route.path}`, fetchOpts)
        expect(resp.status).toBe(503)
        const body = await resp.json() as { error: string }
        expect(body.error).toBe('a2a_not_wired')
      }
    })
  })
})
