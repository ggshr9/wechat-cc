/**
 * Tests for wechat-cc agent CLI handlers.
 *
 * Tests exercise the handler functions (cmdAgentInspect, cmdAgentAdd, etc.)
 * directly — same pattern as memory.test.ts, account-remove.test.ts, etc.
 * For cmdAgentInspect / cmdAgentAdd we spin up a Bun.serve fake to serve
 * a mock /.well-known/agent.json (same approach as a2a-client.test.ts).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../lib/db'
import {
  cmdAgentAdd,
  cmdAgentActivity,
  cmdAgentInspect,
  cmdAgentList,
  cmdAgentPause,
  cmdAgentRemove,
  cmdAgentInfo,
  cmdAgentTest,
  cmdAgentEdit,
  cmdDaemonA2AEnable,
  cmdDaemonA2ADisable,
  cmdDaemonA2AStatus,
  readA2AInfo,
  slugify,
} from './agent'
import { createA2ARegistry } from '../core/a2a-registry'
import { makeA2AEventsStore } from '../core/a2a-events-store'
import type { A2AAgentRecord } from '../lib/agent-config'

// ── helpers ──────────────────────────────────────────────────────────────────

function tempState(): string {
  return mkdtempSync(join(tmpdir(), 'wechat-cc-cli-agent-test-'))
}

function writeConfig(stateDir: string, agents: A2AAgentRecord[]): void {
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(
    join(stateDir, 'agent-config.json'),
    JSON.stringify({ provider: 'claude', a2a_agents: agents }, null, 2),
  )
}

function agentRec(id: string, overrides: Partial<A2AAgentRecord> = {}): A2AAgentRecord {
  return {
    id,
    name: id,
    url: `https://${id}.example.com/a2a`,
    inbound_api_key: `wc_${'0'.repeat(32)}`.slice(0, 36),
    outbound_api_key: `out_${id}`,
    capabilities: ['notify'],
    paused: false,
    ...overrides,
    transport: overrides.transport ?? 'push',
  }
}

// Capture console.log calls during a block.
function captureLog(fn: () => unknown | Promise<unknown>): Promise<string[]> {
  const out: string[] = []
  const stub = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    out.push(args.map(String).join(' '))
  })
  const result = fn()
  if (result instanceof Promise) {
    return result.then(() => { stub.mockRestore(); return out })
      .catch(err => { stub.mockRestore(); throw err })
  }
  stub.mockRestore()
  return Promise.resolve(out)
}

// ── fake HTTP server for inspect / add ───────────────────────────────────────

let fakeServer: ReturnType<typeof Bun.serve> | null = null

const FAKE_CARD = {
  name: 'deploy-bot',
  description: 'Handles deployments',
  version: '2',
  auth: { type: 'bearer', required: true },
  capabilities: [
    { name: 'deploy', description: 'Trigger a deploy' },
    { name: 'rollback' },
  ],
}

beforeAll(() => {
  fakeServer = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === '/.well-known/agent.json') {
        return new Response(JSON.stringify(FAKE_CARD), {
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response('not found', { status: 404 })
    },
  })
})

afterAll(() => {
  fakeServer?.stop()
})

function fakeBaseUrl(): string {
  return `http://127.0.0.1:${fakeServer!.port}`
}

// ── slugify ───────────────────────────────────────────────────────────────────

describe('slugify', () => {
  it('converts ASCII name to lowercase slug', () => {
    expect(slugify('Deploy Bot')).toBe('deploy-bot')
  })

  it('collapses multiple non-alnum chars to single hyphen', () => {
    expect(slugify('My--Deploy  Bot!')).toBe('my-deploy-bot')
  })

  it('trims leading/trailing hyphens', () => {
    expect(slugify('  hello world  ')).toBe('hello-world')
  })

  it('truncates to 64 chars', () => {
    const long = 'a'.repeat(80)
    expect(slugify(long).length).toBe(64)
  })

  it('returns empty string for purely CJK input', () => {
    // Chinese chars are stripped; caller must enforce --id in this case
    expect(slugify('部署机器人')).toBe('')
  })

  it('handles mixed ASCII + CJK', () => {
    expect(slugify('deploy-部署')).toBe('deploy')
  })
})

// ── cmdAgentInspect ───────────────────────────────────────────────────────────

describe('cmdAgentInspect', () => {
  it('prints agent card metadata', async () => {
    const out = await captureLog(() => cmdAgentInspect(fakeBaseUrl()))
    expect(out.some(l => l.includes('deploy-bot'))).toBe(true)
    expect(out.some(l => l.includes('Handles deployments'))).toBe(true)
    expect(out.some(l => l.includes('Version: 2'))).toBe(true)
    expect(out.some(l => l.includes('bearer'))).toBe(true)
    expect(out.some(l => l.includes('deploy'))).toBe(true)
  })

  it('throws on non-existent endpoint', async () => {
    await expect(cmdAgentInspect('http://127.0.0.1:1/never')).rejects.toThrow()
  })

  it('throws when server returns 4xx (path that returns 404)', async () => {
    await expect(
      cmdAgentInspect(`${fakeBaseUrl()}/not-a-well-known-path`),
    ).rejects.toThrow()
  })
})

// ── cmdAgentList ──────────────────────────────────────────────────────────────

describe('cmdAgentList', () => {
  let stateDir: string

  beforeEach(() => {
    stateDir = tempState()
  })

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true })
  })

  it('prints "no agents registered" when empty', async () => {
    writeConfig(stateDir, [])
    const out = await captureLog(() => cmdAgentList(stateDir))
    expect(out.some(l => /no agents registered/i.test(l))).toBe(true)
  })

  it('prints "no agents registered" when config file does not exist (fresh install)', async () => {
    // no writeConfig — config file absent
    const out = await captureLog(() => cmdAgentList(stateDir))
    expect(out.some(l => /no agents registered/i.test(l))).toBe(true)
  })

  it('prints one line per agent with id + url', async () => {
    writeConfig(stateDir, [agentRec('alpha'), agentRec('beta')])
    const out = await captureLog(() => cmdAgentList(stateDir))
    expect(out.some(l => l.includes('alpha') && l.includes('alpha.example.com'))).toBe(true)
    expect(out.some(l => l.includes('beta'))).toBe(true)
  })

  it('marks paused agents in output', async () => {
    writeConfig(stateDir, [agentRec('alpha', { paused: true })])
    const out = await captureLog(() => cmdAgentList(stateDir))
    expect(out.some(l => l.includes('paused'))).toBe(true)
  })
})

// ── cmdAgentAdd ───────────────────────────────────────────────────────────────

describe('cmdAgentAdd', () => {
  let stateDir: string

  beforeEach(() => {
    stateDir = tempState()
    writeConfig(stateDir, [])
  })

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true })
  })

  it('fetches Agent Card, generates inbound_api_key, persists to registry', async () => {
    await captureLog(() => cmdAgentAdd(stateDir, fakeBaseUrl()))
    // Reload from disk to confirm persistence
    const reg = createA2ARegistry({ stateDir })
    const agents = reg.list()
    expect(agents).toHaveLength(1)
    const agent = agents[0]!
    expect(agent.id).toBe('deploy-bot')
    expect(agent.name).toBe('deploy-bot')
    expect(agent.inbound_api_key).toMatch(/^wc_[0-9a-f]{32}$/)
    expect(agent.paused).toBe(false)
  })

  it('prints inbound API key in output', async () => {
    const out = await captureLog(() => cmdAgentAdd(stateDir, fakeBaseUrl()))
    expect(out.some(l => l.includes('inbound API key'))).toBe(true)
  })

  it('respects --id override', async () => {
    await captureLog(() => cmdAgentAdd(stateDir, fakeBaseUrl(), { id: 'my-custom-id' }))
    const reg = createA2ARegistry({ stateDir })
    expect(reg.get('my-custom-id')).not.toBeNull()
  })

  it('respects --name-override', async () => {
    await captureLog(() => cmdAgentAdd(stateDir, fakeBaseUrl(), { nameOverride: 'Custom Name' }))
    const reg = createA2ARegistry({ stateDir })
    const agent = reg.list()[0]!
    expect(agent.name).toBe('Custom Name')
  })

  it('stores outbound key when provided', async () => {
    await captureLog(() => cmdAgentAdd(stateDir, fakeBaseUrl(), { outboundKey: 'my-secret-outbound-key' }))
    const reg = createA2ARegistry({ stateDir })
    expect(reg.list()[0]!.outbound_api_key).toBe('my-secret-outbound-key')
  })

  it('uses placeholder outbound key when not provided', async () => {
    await captureLog(() => cmdAgentAdd(stateDir, fakeBaseUrl()))
    const reg = createA2ARegistry({ stateDir })
    expect(reg.list()[0]!.outbound_api_key).toBe('(none)')
  })

  it('throws when agent name slugifies to empty (e.g. Chinese-only name)', async () => {
    // Serve a card with a CJK-only name
    const cjkServer = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(req) {
        const url = new URL(req.url)
        if (url.pathname === '/.well-known/agent.json') {
          return new Response(JSON.stringify({ name: '部署机器人' }), {
            headers: { 'content-type': 'application/json' },
          })
        }
        return new Response('not found', { status: 404 })
      },
    })
    try {
      await expect(
        captureLog(() => cmdAgentAdd(stateDir, `http://127.0.0.1:${cjkServer.port}`)),
      ).rejects.toThrow(/--id/)
    } finally {
      cjkServer.stop()
    }
  })

  it('throws when agent already exists (duplicate id)', async () => {
    await captureLog(() => cmdAgentAdd(stateDir, fakeBaseUrl()))
    await expect(
      captureLog(() => cmdAgentAdd(stateDir, fakeBaseUrl())),
    ).rejects.toThrow(/already exists/)
  })
})

// ── cmdAgentPause / cmdAgentRemove ───────────────────────────────────────────

describe('cmdAgentPause + cmdAgentRemove', () => {
  let stateDir: string

  beforeEach(() => {
    stateDir = tempState()
    writeConfig(stateDir, [agentRec('alpha'), agentRec('beta')])
  })

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true })
  })

  it('pause flips paused=true', async () => {
    await captureLog(() => cmdAgentPause(stateDir, 'alpha', true))
    const reg = createA2ARegistry({ stateDir })
    expect(reg.get('alpha')?.paused).toBe(true)
  })

  it('resume flips paused=false', async () => {
    // First pause it
    writeConfig(stateDir, [agentRec('alpha', { paused: true })])
    await captureLog(() => cmdAgentPause(stateDir, 'alpha', false))
    const reg = createA2ARegistry({ stateDir })
    expect(reg.get('alpha')?.paused).toBe(false)
  })

  it('pause prints confirmation message', async () => {
    const out = await captureLog(() => cmdAgentPause(stateDir, 'alpha', true))
    expect(out.some(l => l.includes('alpha') && l.includes('paused'))).toBe(true)
  })

  it('resume prints confirmation message', async () => {
    const out = await captureLog(() => cmdAgentPause(stateDir, 'alpha', false))
    expect(out.some(l => l.includes('alpha') && l.includes('resumed'))).toBe(true)
  })

  it('remove drops the agent from registry', async () => {
    await captureLog(() => cmdAgentRemove(stateDir, 'alpha'))
    const reg = createA2ARegistry({ stateDir })
    expect(reg.get('alpha')).toBeNull()
    expect(reg.get('beta')).not.toBeNull()
  })

  it('remove prints confirmation message', async () => {
    const out = await captureLog(() => cmdAgentRemove(stateDir, 'alpha'))
    expect(out.some(l => l.includes('alpha') && l.includes('removed'))).toBe(true)
  })

  it('remove with unknown id surfaces error', () => {
    expect(() => cmdAgentRemove(stateDir, 'nonexistent')).toThrow(/not found/)
  })

  it('pause with unknown id surfaces error', () => {
    expect(() => cmdAgentPause(stateDir, 'nonexistent', true)).toThrow(/not found/)
  })
})

// ── cmdAgentActivity ──────────────────────────────────────────────────────────

describe('cmdAgentActivity', () => {
  let stateDir: string

  // Open the db, seed events, and CLOSE it before returning. A leaked SQLite
  // handle blocks rmSync on Windows (EBUSY) — see the same guard in
  // cmdAgentActivity itself.
  function seed(fn: (store: ReturnType<typeof makeA2AEventsStore>) => void): void {
    const db = openDb({ path: join(stateDir, 'wechat-cc.db') })
    try {
      fn(makeA2AEventsStore(db))
    } finally {
      db.close()
    }
  }

  beforeEach(() => {
    stateDir = tempState()
    writeConfig(stateDir, [agentRec('alpha')])
  })

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true })
  })

  it('prints "no activity" when there are no events', async () => {
    const out = await captureLog(() => cmdAgentActivity(stateDir, 'alpha', 20))
    expect(out.some(l => /no activity/i.test(l))).toBe(true)
  })

  it('prints recent events newest-first', async () => {
    seed(store => {
      store.append({ direction: 'in', agent_id: 'alpha', text: 'first message', status: 'ok' })
      store.append({ direction: 'in', agent_id: 'alpha', text: 'second message', status: 'ok' })
      store.append({ direction: 'out', agent_id: 'alpha', text: 'outbound reply', status: 'ok' })
    })

    const out = await captureLog(() => cmdAgentActivity(stateDir, 'alpha', 20))
    expect(out.length).toBeGreaterThanOrEqual(3)
    // Most recent first (outbound reply was inserted last)
    expect(out[0]).toContain('outbound reply')
    expect(out[0]).toContain('->')
  })

  it('respects the limit parameter', async () => {
    seed(store => {
      for (let i = 0; i < 10; i++) {
        store.append({ direction: 'in', agent_id: 'alpha', text: `msg-${i}`, status: 'ok' })
      }
    })
    const out = await captureLog(() => cmdAgentActivity(stateDir, 'alpha', 3))
    expect(out).toHaveLength(3)
  })

  it('shows error status in brackets when status != ok', async () => {
    seed(store => {
      store.append({ direction: 'out', agent_id: 'alpha', text: 'failed call', status: 'http_error', http_status: 502 })
    })
    const out = await captureLog(() => cmdAgentActivity(stateDir, 'alpha', 10))
    expect(out.some(l => l.includes('[http_error') && l.includes('502'))).toBe(true)
  })

  it('truncates long text to 80 chars + ellipsis', async () => {
    seed(store => {
      store.append({ direction: 'in', agent_id: 'alpha', text: 'x'.repeat(200), status: 'ok' })
    })
    const out = await captureLog(() => cmdAgentActivity(stateDir, 'alpha', 10))
    expect(out[0]).toContain('...')
    // The text part should be at most 80 chars + '...'
    const line = out[0]!
    expect(line.length).toBeLessThan(200)
  })

  it('prints inbound arrow <- for direction=in', async () => {
    seed(store => {
      store.append({ direction: 'in', agent_id: 'alpha', text: 'inbound', status: 'ok' })
    })
    const out = await captureLog(() => cmdAgentActivity(stateDir, 'alpha', 10))
    expect(out.some(l => l.includes('<-'))).toBe(true)
  })
})

// ── readA2AInfo / cmdAgentInfo ─────────────────────────────────────────

describe('readA2AInfo', () => {
  let stateDir: string
  beforeEach(() => { stateDir = tempState() })
  afterEach(() => { rmSync(stateDir, { recursive: true, force: true }) })

  it('returns null when a2a-info.json missing', () => {
    expect(readA2AInfo(stateDir)).toBeNull()
  })

  it('parses a daemon-written a2a-info.json', () => {
    writeFileSync(
      join(stateDir, 'a2a-info.json'),
      JSON.stringify({ enabled: true, base_url: 'http://127.0.0.1:8717', host: '127.0.0.1', port: 8717, pid: 42, ts: 1000 }),
    )
    const info = readA2AInfo(stateDir)
    expect(info?.enabled).toBe(true)
    expect(info?.base_url).toBe('http://127.0.0.1:8717')
    expect(info?.port).toBe(8717)
  })

  it('returns null on corrupt JSON', () => {
    writeFileSync(join(stateDir, 'a2a-info.json'), 'not-json')
    expect(readA2AInfo(stateDir)).toBeNull()
  })
})

describe('cmdAgentInfo', () => {
  let stateDir: string
  beforeEach(() => { stateDir = tempState() })
  afterEach(() => { rmSync(stateDir, { recursive: true, force: true }) })

  it('reports daemon-not-running when a2a-info.json missing', async () => {
    writeConfig(stateDir, [])
    const out = await captureLog(() => cmdAgentInfo(stateDir))
    expect(out.some(l => /daemon not running/i.test(l))).toBe(true)
    expect(out.some(l => l.includes('Registered agents: 0'))).toBe(true)
  })

  it('reports server-disabled when enabled=false', async () => {
    writeConfig(stateDir, [agentRec('alpha')])
    writeFileSync(
      join(stateDir, 'a2a-info.json'),
      JSON.stringify({ enabled: false, base_url: null, host: null, port: null, pid: 1, ts: 0 }),
    )
    const out = await captureLog(() => cmdAgentInfo(stateDir))
    expect(out.some(l => /inbound server is disabled/i.test(l))).toBe(true)
    expect(out.some(l => l.includes('a2a_listen'))).toBe(true)
    expect(out.some(l => l.includes('Registered agents: 1'))).toBe(true)
    expect(out.some(l => l.includes('alpha'))).toBe(true)
  })

  it('reports server-running with base URL when enabled=true', async () => {
    writeConfig(stateDir, [agentRec('alpha'), agentRec('beta', { paused: true })])
    writeFileSync(
      join(stateDir, 'a2a-info.json'),
      JSON.stringify({ enabled: true, base_url: 'http://127.0.0.1:8717', host: '127.0.0.1', port: 8717, pid: 42, ts: 0 }),
    )
    const out = await captureLog(() => cmdAgentInfo(stateDir))
    expect(out.some(l => l.includes('http://127.0.0.1:8717'))).toBe(true)
    expect(out.some(l => l.includes('PID:'))).toBe(true)
    expect(out.some(l => l.includes('Registered agents: 2'))).toBe(true)
    expect(out.some(l => l.includes('beta') && l.includes('(paused)'))).toBe(true)
  })
})

// ── cmdAgentTest ────────────────────────────────────────────────────────

describe('cmdAgentTest', () => {
  let stateDir: string
  let echoServer: ReturnType<typeof Bun.serve> | null = null
  const received: Array<{ headers: Record<string, string>; body: string }> = []

  beforeEach(() => {
    stateDir = tempState()
    received.length = 0
    echoServer = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(req) {
        const body = await req.text()
        received.push({
          headers: Object.fromEntries(req.headers.entries()),
          body,
        })
        const url = new URL(req.url)
        if (url.pathname === '/a2a/notify') {
          // Accept whatever the agent's bearer was — the test agent we register
          // uses 'wc_test_key', and we echo OK so the CLI sees success.
          return new Response(JSON.stringify({ ok: true }), { status: 200 })
        }
        return new Response('not found', { status: 404 })
      },
    })
  })
  afterEach(() => {
    echoServer?.stop()
    rmSync(stateDir, { recursive: true, force: true })
  })

  function writeRunningInfo(): void {
    writeFileSync(
      join(stateDir, 'a2a-info.json'),
      JSON.stringify({
        enabled: true,
        base_url: `http://127.0.0.1:${echoServer!.port}`,
        host: '127.0.0.1',
        port: echoServer!.port,
        pid: process.pid,
        ts: Date.now(),
      }),
    )
  }

  it('throws when daemon not running (no a2a-info.json)', async () => {
    writeConfig(stateDir, [agentRec('alpha')])
    await expect(cmdAgentTest(stateDir, 'alpha', 'hi')).rejects.toThrow(/not running/i)
  })

  it('throws when A2A inbound server is disabled', async () => {
    writeConfig(stateDir, [agentRec('alpha')])
    writeFileSync(
      join(stateDir, 'a2a-info.json'),
      JSON.stringify({ enabled: false, base_url: null, host: null, port: null, pid: 1, ts: 0 }),
    )
    await expect(cmdAgentTest(stateDir, 'alpha', 'hi')).rejects.toThrow(/disabled/i)
  })

  it('throws when agent is not registered', async () => {
    writeConfig(stateDir, [])
    writeRunningInfo()
    await expect(cmdAgentTest(stateDir, 'missing', 'hi')).rejects.toThrow(/not registered/i)
  })

  it('sends Bearer + body to /a2a/notify and reports success', async () => {
    const testKey = `wc_${'a'.repeat(32)}`
    writeConfig(stateDir, [agentRec('alpha', { inbound_api_key: testKey })])
    writeRunningInfo()
    const out = await captureLog(() => cmdAgentTest(stateDir, 'alpha', 'hello smoke test'))
    expect(out.some(l => l.includes('delivered'))).toBe(true)
    expect(received).toHaveLength(1)
    expect(received[0]?.headers.authorization).toBe(`Bearer ${testKey}`)
    const sent = JSON.parse(received[0]!.body)
    expect(sent).toEqual({ agent_id: 'alpha', text: 'hello smoke test' })
  })
})

// ── cmdAgentTest --outbound ──────────────────────────────────────────────

describe('cmdAgentTest --outbound', () => {
  let stateDir: string
  let internalApi: ReturnType<typeof Bun.serve> | null = null
  const apiReceived: Array<{ headers: Record<string, string>; body: string }> = []
  let nextResponse: { status: number; body: string } = { status: 200, body: '{"ok":true,"http_status":200,"response":{"ack":true}}' }

  beforeEach(() => {
    stateDir = tempState()
    apiReceived.length = 0
    nextResponse = { status: 200, body: '{"ok":true,"http_status":200,"response":{"ack":true}}' }
    internalApi = Bun.serve({
      hostname: '127.0.0.1', port: 0,
      async fetch(req) {
        const body = await req.text()
        apiReceived.push({
          headers: Object.fromEntries(req.headers.entries()),
          body,
        })
        return new Response(nextResponse.body, {
          status: nextResponse.status,
          headers: { 'content-type': 'application/json' },
        })
      },
    })
    // Write internal-api-info.json + a token file pointing at the fake server.
    const tokenFilePath = join(stateDir, 'internal-api-token')
    writeFileSync(tokenFilePath, 'fake-token-deadbeef')
    writeFileSync(
      join(stateDir, 'internal-api-info.json'),
      JSON.stringify({
        baseUrl: `http://127.0.0.1:${internalApi.port}`,
        tokenFilePath,
        pid: process.pid,
        ts: Date.now(),
      }),
    )
  })
  afterEach(() => {
    internalApi?.stop()
    rmSync(stateDir, { recursive: true, force: true })
  })

  it('throws when agent not registered', async () => {
    writeConfig(stateDir, [])
    await expect(cmdAgentTest(stateDir, 'missing', 'hi', { outbound: true }))
      .rejects.toThrow(/not registered/i)
  })

  it('throws when internal-api-info.json missing', async () => {
    writeConfig(stateDir, [agentRec('alpha')])
    rmSync(join(stateDir, 'internal-api-info.json'))
    await expect(cmdAgentTest(stateDir, 'alpha', 'hi', { outbound: true }))
      .rejects.toThrow(/daemon not running/i)
  })

  it('POSTs to /v1/a2a/send with the internal-api token and prints success', async () => {
    writeConfig(stateDir, [agentRec('alpha')])
    const out = await captureLog(() => cmdAgentTest(stateDir, 'alpha', 'hello out', { outbound: true }))
    expect(apiReceived).toHaveLength(1)
    expect(apiReceived[0]?.headers.authorization).toBe('Bearer fake-token-deadbeef')
    const sent = JSON.parse(apiReceived[0]!.body)
    expect(sent).toEqual({ agent_id: 'alpha', text: 'hello out' })
    // Output mentions success + external HTTP status
    expect(out.some(l => l.includes('outbound delivered'))).toBe(true)
    expect(out.some(l => l.includes('HTTP 200'))).toBe(true)
  })

  it('reports failure with http_status when external agent returns non-2xx', async () => {
    writeConfig(stateDir, [agentRec('alpha')])
    nextResponse = { status: 200, body: '{"ok":false,"error":"http_403","http_status":403}' }
    const out = await captureLog(() => cmdAgentTest(stateDir, 'alpha', 'hi', { outbound: true }))
    expect(out.some(l => l.includes('outbound failed'))).toBe(true)
    expect(out.some(l => l.includes('http_403'))).toBe(true)
    expect(out.some(l => l.includes('HTTP 403'))).toBe(true)
  })

  it('reports failure on network error from internal-api', async () => {
    writeConfig(stateDir, [agentRec('alpha')])
    nextResponse = { status: 200, body: '{"ok":false,"error":"connection refused"}' }
    const out = await captureLog(() => cmdAgentTest(stateDir, 'alpha', 'hi', { outbound: true }))
    expect(out.some(l => l.includes('outbound failed'))).toBe(true)
    expect(out.some(l => l.includes('connection refused'))).toBe(true)
  })
})

// ── cmdAgentAdd URL substitution ─────────────────────────────────────────

describe('cmdAgentAdd with a2a-info.json present', () => {
  let stateDir: string
  beforeEach(() => { stateDir = tempState() })
  afterEach(() => { rmSync(stateDir, { recursive: true, force: true }) })

  it('substitutes actual base URL when daemon running + A2A enabled', async () => {
    writeFileSync(
      join(stateDir, 'a2a-info.json'),
      JSON.stringify({ enabled: true, base_url: 'http://127.0.0.1:8717', host: '127.0.0.1', port: 8717, pid: 1, ts: 0 }),
    )
    const out = await captureLog(() => cmdAgentAdd(stateDir, fakeBaseUrl(), { id: 'alpha' }))
    const curlLine = out.find(l => l.includes('curl -X POST '))
    expect(curlLine).toContain('http://127.0.0.1:8717/a2a/notify')
    // The placeholder should NOT appear in any line of the output.
    expect(out.every(l => !l.includes('<wechat-cc-base-url>'))).toBe(true)
  })

  it('keeps placeholder + warns when daemon not running', async () => {
    const out = await captureLog(() => cmdAgentAdd(stateDir, fakeBaseUrl(), { id: 'alpha' }))
    expect(out.some(l => l.includes('<wechat-cc-base-url>'))).toBe(true)
    expect(out.some(l => /daemon not running/i.test(l))).toBe(true)
  })

  it('keeps placeholder + warns when A2A server disabled', async () => {
    writeFileSync(
      join(stateDir, 'a2a-info.json'),
      JSON.stringify({ enabled: false, base_url: null, host: null, port: null, pid: 1, ts: 0 }),
    )
    const out = await captureLog(() => cmdAgentAdd(stateDir, fakeBaseUrl(), { id: 'alpha' }))
    expect(out.some(l => l.includes('<wechat-cc-base-url>'))).toBe(true)
    expect(out.some(l => /server disabled/i.test(l))).toBe(true)
  })
})

// ── cmdAgentEdit ────────────────────────────────────────────────────────

describe('cmdAgentEdit', () => {
  let stateDir: string
  beforeEach(() => { stateDir = tempState() })
  afterEach(() => { rmSync(stateDir, { recursive: true, force: true }) })

  it('throws when agent not registered', () => {
    writeConfig(stateDir, [])
    expect(() => cmdAgentEdit(stateDir, 'missing', { name: 'X' })).toThrow(/not registered/i)
  })

  it('throws when no fields to update', () => {
    writeConfig(stateDir, [agentRec('alpha')])
    expect(() => cmdAgentEdit(stateDir, 'alpha', {})).toThrow(/no fields to update/i)
  })

  it('updates name and persists', async () => {
    writeConfig(stateDir, [agentRec('alpha')])
    const out = await captureLog(() => cmdAgentEdit(stateDir, 'alpha', { name: 'New Name' }))
    expect(out.some(l => l.includes('updated'))).toBe(true)
    expect(out.some(l => l.includes('New Name'))).toBe(true)
    // Round-trip: reload registry
    const reg = createA2ARegistry({ stateDir })
    expect(reg.get('alpha')?.name).toBe('New Name')
  })

  it('rotates outbound_api_key', async () => {
    writeConfig(stateDir, [agentRec('alpha')])
    const newKey = 'new-outbound-key-rotated'
    await captureLog(() => cmdAgentEdit(stateDir, 'alpha', { outboundKey: newKey }))
    const reg = createA2ARegistry({ stateDir })
    expect(reg.get('alpha')?.outbound_api_key).toBe(newKey)
  })

  it('rotates inbound_api_key with --rotate-inbound-key and prints the new key', async () => {
    writeConfig(stateDir, [agentRec('alpha')])
    const before = createA2ARegistry({ stateDir }).get('alpha')!.inbound_api_key
    const out = await captureLog(() => cmdAgentEdit(stateDir, 'alpha', { rotateInboundKey: true }))
    const after = createA2ARegistry({ stateDir }).get('alpha')!.inbound_api_key
    expect(after).not.toBe(before)
    expect(after).toMatch(/^wc_[0-9a-f]{32}$/)
    expect(out.some(l => l.includes(after))).toBe(true)
    expect(out.some(l => /share.*new key/i.test(l))).toBe(true)
  })

  it('updates url and preserves other fields', async () => {
    writeConfig(stateDir, [agentRec('alpha')])
    const original = createA2ARegistry({ stateDir }).get('alpha')!
    await captureLog(() => cmdAgentEdit(stateDir, 'alpha', { url: 'https://moved.example.com/a2a' }))
    const after = createA2ARegistry({ stateDir }).get('alpha')!
    expect(after.url).toBe('https://moved.example.com/a2a')
    expect(after.name).toBe(original.name)
    expect(after.inbound_api_key).toBe(original.inbound_api_key)
    expect(after.outbound_api_key).toBe(original.outbound_api_key)
  })

  it('combines multiple field updates in one call', async () => {
    writeConfig(stateDir, [agentRec('alpha')])
    await captureLog(() => cmdAgentEdit(stateDir, 'alpha', {
      name: 'Renamed',
      url: 'https://new.example.com/a2a',
      outboundKey: 'rotated-key',
    }))
    const after = createA2ARegistry({ stateDir }).get('alpha')!
    expect(after.name).toBe('Renamed')
    expect(after.url).toBe('https://new.example.com/a2a')
    expect(after.outbound_api_key).toBe('rotated-key')
  })
})

// ── daemon a2a enable / disable / status ────────────────────────────────

describe('cmdDaemonA2AEnable', () => {
  let stateDir: string
  beforeEach(() => { stateDir = tempState() })
  afterEach(() => { rmSync(stateDir, { recursive: true, force: true }) })

  it('writes a2a_listen to agent-config.json with defaults', async () => {
    writeFileSync(join(stateDir, 'agent-config.json'), JSON.stringify({ provider: 'claude' }))
    const out = await captureLog(() => cmdDaemonA2AEnable(stateDir))
    const cfg = JSON.parse(readFileSync(join(stateDir, 'agent-config.json'), 'utf8'))
    expect(cfg.a2a_listen).toEqual({ host: '127.0.0.1', port: 8717 })
    expect(cfg.provider).toBe('claude')
    expect(out.some(l => l.includes('enabled at 127.0.0.1:8717'))).toBe(true)
    expect(out.some(l => /restart/i.test(l))).toBe(true)
  })

  it('honors --host and --port options', async () => {
    writeFileSync(join(stateDir, 'agent-config.json'), JSON.stringify({ provider: 'claude' }))
    await captureLog(() => cmdDaemonA2AEnable(stateDir, { host: '0.0.0.0', port: 9000 }))
    const cfg = JSON.parse(readFileSync(join(stateDir, 'agent-config.json'), 'utf8'))
    expect(cfg.a2a_listen).toEqual({ host: '0.0.0.0', port: 9000 })
  })

  it('warns when host is not loopback', async () => {
    writeFileSync(join(stateDir, 'agent-config.json'), JSON.stringify({ provider: 'claude' }))
    const out = await captureLog(() => cmdDaemonA2AEnable(stateDir, { host: '0.0.0.0', port: 9000 }))
    expect(out.some(l => /not loopback/i.test(l) || /threat model/i.test(l))).toBe(true)
  })

  it('reports prev → new when updating an existing config', async () => {
    writeFileSync(
      join(stateDir, 'agent-config.json'),
      JSON.stringify({ provider: 'claude', a2a_listen: { host: '127.0.0.1', port: 8000 } }),
    )
    const out = await captureLog(() => cmdDaemonA2AEnable(stateDir, { port: 9000 }))
    expect(out.some(l => l.includes('8000') && l.includes('9000'))).toBe(true)
  })

  it('rejects out-of-range port', () => {
    writeFileSync(join(stateDir, 'agent-config.json'), JSON.stringify({ provider: 'claude' }))
    expect(() => cmdDaemonA2AEnable(stateDir, { port: 0 })).toThrow(/port/i)
    expect(() => cmdDaemonA2AEnable(stateDir, { port: 70000 })).toThrow(/port/i)
  })

  it('creates agent-config.json if missing (operator first run)', async () => {
    await captureLog(() => cmdDaemonA2AEnable(stateDir, { port: 8717 }))
    const cfg = JSON.parse(readFileSync(join(stateDir, 'agent-config.json'), 'utf8'))
    expect(cfg.a2a_listen).toEqual({ host: '127.0.0.1', port: 8717 })
  })
})

describe('cmdDaemonA2ADisable', () => {
  let stateDir: string
  beforeEach(() => { stateDir = tempState() })
  afterEach(() => { rmSync(stateDir, { recursive: true, force: true }) })

  it('removes a2a_listen from agent-config.json', async () => {
    writeFileSync(
      join(stateDir, 'agent-config.json'),
      JSON.stringify({ provider: 'claude', a2a_listen: { host: '127.0.0.1', port: 8717 } }),
    )
    const out = await captureLog(() => cmdDaemonA2ADisable(stateDir))
    const cfg = JSON.parse(readFileSync(join(stateDir, 'agent-config.json'), 'utf8'))
    expect('a2a_listen' in cfg).toBe(false)
    expect(cfg.provider).toBe('claude')
    expect(out.some(l => /disabled/i.test(l))).toBe(true)
  })

  it('idempotent: works when already disabled', async () => {
    writeFileSync(join(stateDir, 'agent-config.json'), JSON.stringify({ provider: 'claude' }))
    const out = await captureLog(() => cmdDaemonA2ADisable(stateDir))
    expect(out.some(l => /already disabled/i.test(l))).toBe(true)
  })
})

describe('cmdDaemonA2AStatus', () => {
  let stateDir: string
  beforeEach(() => { stateDir = tempState() })
  afterEach(() => { rmSync(stateDir, { recursive: true, force: true }) })

  it('shows disabled config + daemon-not-running', async () => {
    writeFileSync(join(stateDir, 'agent-config.json'), JSON.stringify({ provider: 'claude' }))
    const out = await captureLog(() => cmdDaemonA2AStatus(stateDir))
    expect(out.some(l => /disabled.*no a2a_listen/i.test(l))).toBe(true)
    expect(out.some(l => /daemon not running/i.test(l))).toBe(true)
  })

  it('shows config + running runtime', async () => {
    writeFileSync(
      join(stateDir, 'agent-config.json'),
      JSON.stringify({ provider: 'claude', a2a_listen: { host: '127.0.0.1', port: 8717 } }),
    )
    writeFileSync(
      join(stateDir, 'a2a-info.json'),
      JSON.stringify({ enabled: true, base_url: 'http://127.0.0.1:8717', host: '127.0.0.1', port: 8717, pid: 42, ts: 0 }),
    )
    const out = await captureLog(() => cmdDaemonA2AStatus(stateDir))
    expect(out.some(l => l.includes('127.0.0.1') && l.includes('8717'))).toBe(true)
    expect(out.some(l => l.includes('pid 42'))).toBe(true)
    // No drift warning when config matches runtime
    expect(out.every(l => !/differs|drift|restart needed/i.test(l))).toBe(true)
  })

  it('flags drift when config differs from runtime', async () => {
    writeFileSync(
      join(stateDir, 'agent-config.json'),
      JSON.stringify({ provider: 'claude', a2a_listen: { host: '127.0.0.1', port: 9000 } }),
    )
    writeFileSync(
      join(stateDir, 'a2a-info.json'),
      JSON.stringify({ enabled: true, base_url: 'http://127.0.0.1:8717', host: '127.0.0.1', port: 8717, pid: 42, ts: 0 }),
    )
    const out = await captureLog(() => cmdDaemonA2AStatus(stateDir))
    expect(out.some(l => /restart.*daemon/i.test(l))).toBe(true)
  })

  it('flags drift when config has a2a_listen but runtime does not', async () => {
    writeFileSync(
      join(stateDir, 'agent-config.json'),
      JSON.stringify({ provider: 'claude', a2a_listen: { host: '127.0.0.1', port: 8717 } }),
    )
    writeFileSync(
      join(stateDir, 'a2a-info.json'),
      JSON.stringify({ enabled: false, base_url: null, host: null, port: null, pid: 42, ts: 0 }),
    )
    const out = await captureLog(() => cmdDaemonA2AStatus(stateDir))
    expect(out.some(l => /restart needed/i.test(l))).toBe(true)
  })
})
