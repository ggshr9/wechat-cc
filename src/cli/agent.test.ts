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
    const db = openDb({ path: join(stateDir, 'wechat-cc.db') })
    const store = makeA2AEventsStore(db)
    store.append({ direction: 'in', agent_id: 'alpha', text: 'first message', status: 'ok' })
    store.append({ direction: 'in', agent_id: 'alpha', text: 'second message', status: 'ok' })
    store.append({ direction: 'out', agent_id: 'alpha', text: 'outbound reply', status: 'ok' })

    const out = await captureLog(() => cmdAgentActivity(stateDir, 'alpha', 20))
    expect(out.length).toBeGreaterThanOrEqual(3)
    // Most recent first (outbound reply was inserted last)
    expect(out[0]).toContain('outbound reply')
    expect(out[0]).toContain('->')
  })

  it('respects the limit parameter', async () => {
    const db = openDb({ path: join(stateDir, 'wechat-cc.db') })
    const store = makeA2AEventsStore(db)
    for (let i = 0; i < 10; i++) {
      store.append({ direction: 'in', agent_id: 'alpha', text: `msg-${i}`, status: 'ok' })
    }
    const out = await captureLog(() => cmdAgentActivity(stateDir, 'alpha', 3))
    expect(out).toHaveLength(3)
  })

  it('shows error status in brackets when status != ok', async () => {
    const db = openDb({ path: join(stateDir, 'wechat-cc.db') })
    const store = makeA2AEventsStore(db)
    store.append({ direction: 'out', agent_id: 'alpha', text: 'failed call', status: 'http_error', http_status: 502 })
    const out = await captureLog(() => cmdAgentActivity(stateDir, 'alpha', 10))
    expect(out.some(l => l.includes('[http_error') && l.includes('502'))).toBe(true)
  })

  it('truncates long text to 80 chars + ellipsis', async () => {
    const db = openDb({ path: join(stateDir, 'wechat-cc.db') })
    const store = makeA2AEventsStore(db)
    store.append({ direction: 'in', agent_id: 'alpha', text: 'x'.repeat(200), status: 'ok' })
    const out = await captureLog(() => cmdAgentActivity(stateDir, 'alpha', 10))
    expect(out[0]).toContain('...')
    // The text part should be at most 80 chars + '...'
    const line = out[0]!
    expect(line.length).toBeLessThan(200)
  })

  it('prints inbound arrow <- for direction=in', async () => {
    const db = openDb({ path: join(stateDir, 'wechat-cc.db') })
    const store = makeA2AEventsStore(db)
    store.append({ direction: 'in', agent_id: 'alpha', text: 'inbound', status: 'ok' })
    const out = await captureLog(() => cmdAgentActivity(stateDir, 'alpha', 10))
    expect(out.some(l => l.includes('<-'))).toBe(true)
  })
})
