import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createInternalApi, type InternalApi } from './internal-api'

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
})
