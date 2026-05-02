import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createInternalApiClient, InternalApiError } from './client'

type FetchArgs = Parameters<typeof fetch>
type FetchImpl = (...args: FetchArgs) => Promise<Response>
type FetchMock = Mock<FetchImpl>

function makeFetchMock(impl: FetchImpl): FetchMock {
  // vi.fn with explicit generic sets up the call/return tuple types so
  // .mock.calls[i] is properly typed (avoids "tuple of length 0" errors).
  return vi.fn<FetchImpl>(impl)
}

describe('InternalApiClient', () => {
  let dir: string
  let tokenPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-client-'))
    tokenPath = join(dir, 'internal-token')
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  function writeToken(t: string): void {
    writeFileSync(tokenPath, t + '\n', { mode: 0o600 })
  }

  it('reads token from file and sends it as Bearer Authorization', async () => {
    writeToken('aabbccdd')
    const fetchMock = makeFetchMock(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }))
    const client = createInternalApiClient({
      baseUrl: 'http://127.0.0.1:1234',
      tokenFilePath: tokenPath,
      fetchImpl: fetchMock as unknown as typeof fetch,
    })
    await client.request('GET', '/v1/health')
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('http://127.0.0.1:1234/v1/health')
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer aabbccdd' })
  })

  it('parses JSON response when content-type is application/json', async () => {
    writeToken('t')
    const fetchMock = makeFetchMock(async () => new Response(JSON.stringify({ ok: true, daemon_pid: 99 }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }))
    const client = createInternalApiClient({
      baseUrl: 'http://127.0.0.1:1', tokenFilePath: tokenPath, fetchImpl: fetchMock as unknown as typeof fetch,
    })
    const body = await client.request<{ ok: boolean; daemon_pid: number }>('GET', '/v1/health')
    expect(body).toEqual({ ok: true, daemon_pid: 99 })
  })

  it('POST sends JSON body with content-type application/json', async () => {
    writeToken('t')
    const fetchMock = makeFetchMock(async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }))
    const client = createInternalApiClient({
      baseUrl: 'http://127.0.0.1:1', tokenFilePath: tokenPath, fetchImpl: fetchMock as unknown as typeof fetch,
    })
    await client.request('POST', '/v1/reply', { chatId: 'c1', text: 'hi' })
    const init = fetchMock.mock.calls[0]![1] as RequestInit
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json')
    expect(init.body).toBe(JSON.stringify({ chatId: 'c1', text: 'hi' }))
  })

  it('throws InternalApiError on non-2xx (preserves status + body)', async () => {
    writeToken('t')
    const fetchMock = makeFetchMock(async () => new Response(JSON.stringify({ error: 'not_found' }), {
      status: 404, headers: { 'content-type': 'application/json' },
    }))
    const client = createInternalApiClient({
      baseUrl: 'http://127.0.0.1:1', tokenFilePath: tokenPath, fetchImpl: fetchMock as unknown as typeof fetch,
    })
    await expect(client.request('GET', '/v1/missing')).rejects.toMatchObject({
      name: 'InternalApiError',
      status: 404,
      path: '/v1/missing',
      body: { error: 'not_found' },
    })
  })

  it('re-reads token and retries once on 401 (handles daemon restart rotation)', async () => {
    writeToken('old-token')
    let calls = 0
    const fetchMock = makeFetchMock(async (_url, init) => {
      calls++
      const auth = ((init as RequestInit | undefined)?.headers as Record<string, string> | undefined)?.Authorization
      if (calls === 1) {
        // First call primes the cache with 'old-token' (server says ok)
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (auth === 'Bearer old-token') {
        // Second call: cache still has 'old-token', daemon rejects → 401
        return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'content-type': 'application/json' } })
      }
      // Third call: client re-read the file → fresh token → ok
      return new Response(JSON.stringify({ ok: true, after_rotate: true }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const client = createInternalApiClient({
      baseUrl: 'http://127.0.0.1:1', tokenFilePath: tokenPath, fetchImpl: fetchMock as unknown as typeof fetch,
    })
    await client.request('GET', '/v1/health')        // primes cache
    writeToken('new-token')                           // simulate daemon rotation
    const body = await client.request<{ after_rotate: boolean }>('GET', '/v1/health')
    expect(body.after_rotate).toBe(true)
    expect(calls).toBe(3)
  })

  it('strips trailing slashes from baseUrl', async () => {
    writeToken('t')
    const fetchMock = makeFetchMock(async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }))
    const client = createInternalApiClient({
      baseUrl: 'http://127.0.0.1:1234///',
      tokenFilePath: tokenPath,
      fetchImpl: fetchMock as unknown as typeof fetch,
    })
    await client.request('GET', '/v1/x')
    expect(fetchMock.mock.calls[0]![0]).toBe('http://127.0.0.1:1234/v1/x')
  })
})

describe('InternalApiError', () => {
  it('exposes status, path, and body', () => {
    const err = new InternalApiError('boom', 500, '/v1/foo', { detail: 'oops' })
    expect(err.name).toBe('InternalApiError')
    expect(err.status).toBe(500)
    expect(err.path).toBe('/v1/foo')
    expect(err.body).toEqual({ detail: 'oops' })
    expect(err.message).toBe('boom')
  })
})
