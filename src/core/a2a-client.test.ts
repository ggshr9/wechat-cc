import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { createA2AClient } from './a2a-client'

let fakeServer: ReturnType<typeof Bun.serve> | null = null
const requests: Array<{ url: string; method: string; headers: Record<string, string>; body: string }> = []

beforeAll(() => {
  fakeServer = Bun.serve({
    hostname: '127.0.0.1',  // memory: 'localhost' is IPv6-only on macOS
    port: 0,
    async fetch(req) {
      const body = req.method === 'POST' ? await req.text() : ''
      requests.push({
        url: req.url,
        method: req.method,
        headers: Object.fromEntries(req.headers.entries()),
        body,
      })
      const url = new URL(req.url)
      if (url.pathname === '/.well-known/agent.json') {
        return new Response(JSON.stringify({
          name: 'fake-agent', description: 'fake', version: '1',
          auth: { type: 'bearer', required: true },
          capabilities: [{ name: 'notify', endpoint: '/notify' }],
        }), { headers: { 'content-type': 'application/json' } })
      }
      if (url.pathname === '/notify' || url.pathname === '/a2a/notify') {
        const auth = req.headers.get('authorization')
        if (!auth?.startsWith('Bearer ')) return new Response('unauthorized', { status: 401 })
        return new Response(JSON.stringify({ ok: true, received: true }), {
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url.pathname === '/error') return new Response('internal', { status: 500 })
      return new Response('not found', { status: 404 })
    },
  })
})

afterAll(() => {
  fakeServer?.stop()
})

function baseUrl(): string {
  return `http://127.0.0.1:${fakeServer!.port}`
}

describe('a2a-client', () => {
  it('fetchAgentCard returns the Agent Card metadata', async () => {
    const client = createA2AClient()
    const card = await client.fetchAgentCard(baseUrl())
    expect(card.name).toBe('fake-agent')
    expect(card.capabilities?.[0]?.name).toBe('notify')
  })

  it('fetchAgentCard rejects on 4xx/5xx', async () => {
    const client = createA2AClient()
    await expect(client.fetchAgentCard(`${baseUrl()}/error`)).rejects.toThrow()
  })

  it('send POSTs with Bearer auth and returns parsed result', async () => {
    requests.length = 0
    const client = createA2AClient()
    const r = await client.send({
      url: `${baseUrl()}/notify`,
      bearer: 'test-key',
      body: { text: 'hello', source: { agent_id: 'wechat-cc' } },
    })
    expect(r.ok).toBe(true)
    expect(r.http_status).toBe(200)
    const lastReq = requests[requests.length - 1]!
    expect(lastReq.headers.authorization).toBe('Bearer test-key')
    expect(JSON.parse(lastReq.body)).toEqual({ text: 'hello', source: { agent_id: 'wechat-cc' } })
  })

  it('send returns ok=false with http_status on 401', async () => {
    const client = createA2AClient()
    const r = await client.send({
      url: `${baseUrl()}/notify-not-real-endpoint-just-using-wrong-bearer`,
      bearer: '',  // no Bearer prefix → 401
      body: { text: 'x' },
    })
    expect(r.ok).toBe(false)
  })

  it('send returns ok=false on network error', async () => {
    const client = createA2AClient()
    const r = await client.send({
      url: 'http://127.0.0.1:1/never-listening',  // port 1 reserved → connection refused
      bearer: 'k',
      body: { text: 'x' },
    })
    expect(r.ok).toBe(false)
    expect(r.error).toBeDefined()
  })

  it('send applies timeout', async () => {
    // Set up a server that delays 200ms; client timeout 50ms.
    const slow = Bun.serve({
      hostname: '127.0.0.1', port: 0,
      async fetch() {
        await new Promise(r => setTimeout(r, 200))
        return new Response('late')
      },
    })
    try {
      const client = createA2AClient({ timeoutMs: 50 })
      const r = await client.send({
        url: `http://127.0.0.1:${slow.port}/anything`,
        bearer: 'k',
        body: { text: 'x' },
      })
      expect(r.ok).toBe(false)
      expect(r.error).toMatch(/timeout|aborted/i)
    } finally {
      slow.stop()
    }
  })
})
