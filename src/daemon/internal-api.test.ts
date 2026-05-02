import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
})
