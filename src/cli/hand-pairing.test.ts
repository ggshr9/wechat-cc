import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createA2ARegistry } from '../core/a2a-registry'
import { createA2AServer } from '../core/a2a-server'
import { mintInvite, verifyAndConsumeInvite } from './a2a-pairing'
import { acceptBrain, addHand, joinHand, listPairings, pingHands } from './hand-pairing'

let stateDir: string
const TOKEN = 'shared-secret-0123456789'  // ≥16

beforeEach(() => { stateDir = mkdtempSync(join(tmpdir(), 'hand-pair-')) })
afterEach(() => { rmSync(stateDir, { recursive: true, force: true }) })

describe('addHand (brain side)', () => {
  it('registers a hand the brain can call (outbound_api_key=token, exec capability)', () => {
    addHand(stateDir, { id: 'home', url: 'http://home.ts.net:7000/a2a', name: '家里', token: TOKEN })
    const rec = createA2ARegistry({ stateDir }).get('home')!
    expect(rec.name).toBe('家里')
    expect(rec.url).toBe('http://home.ts.net:7000/a2a')
    expect(rec.outbound_api_key).toBe(TOKEN)
    expect(rec.capabilities).toContain('exec')
    expect(rec.inbound_api_key.length).toBeGreaterThanOrEqual(16)
  })

  it('rejects a non-slug id and a short token', () => {
    expect(() => addHand(stateDir, { id: '家里', url: 'http://x/a2a', token: TOKEN })).toThrow(/slug/)
    expect(() => addHand(stateDir, { id: 'home', url: 'http://x/a2a', token: 'short' })).toThrow(/at least 16/)
  })
})

describe('listPairings (role classification)', () => {
  it('classifies hands (exec), brains (unused sentinel), and other agents', () => {
    addHand(stateDir, { id: 'home', url: 'http://home/a2a', name: '家里', token: TOKEN })   // hand
    acceptBrain(stateDir, { brainId: 'office-brain', token: TOKEN })                         // brain
    // a plain notify-only agent
    createA2ARegistry({ stateDir }).add({
      id: 'pager', name: 'pager', url: 'https://pager/a2a',
      inbound_api_key: TOKEN, outbound_api_key: 'real-key', capabilities: ['notify'], paused: false,
      transport: 'push',
    })
    const p = listPairings(stateDir)
    expect(p.hands.map(h => h.id)).toEqual(['home'])
    expect(p.hands[0]!.name).toBe('家里')
    expect(p.brains.map(b => b.id)).toEqual(['office-brain'])
    expect(p.others.map(o => o.id)).toEqual(['pager'])
  })

  it('returns empty groups for an empty registry', () => {
    const p = listPairings(stateDir)
    expect(p).toEqual({ hands: [], brains: [], others: [] })
  })
})

describe('acceptBrain (hand side)', () => {
  it('registers the brain so the hand verifies its exec calls', () => {
    acceptBrain(stateDir, { brainId: 'wechat-cc', token: TOKEN })
    const reg = createA2ARegistry({ stateDir })
    // This is exactly the check /a2a/exec runs on an inbound brain call:
    expect(reg.verifyBearer('wechat-cc', TOKEN)).not.toBeNull()
    expect(reg.verifyBearer('wechat-cc', 'wrong-token-0123456789')).toBeNull()
  })

  it('rejects a short token', () => {
    expect(() => acceptBrain(stateDir, { brainId: 'wechat-cc', token: 'short' })).toThrow(/at least 16/)
  })
})

describe('end-to-end record match', () => {
  it('the brain token (outbound) matches what the hand verifies (inbound)', () => {
    // Brain machine:
    const brainDir = mkdtempSync(join(tmpdir(), 'brain-'))
    // Hand machine:
    const handDir = mkdtempSync(join(tmpdir(), 'hand-'))
    try {
      addHand(brainDir, { id: 'home', url: 'http://home/a2a', token: TOKEN })
      acceptBrain(handDir, { brainId: 'wechat-cc', token: TOKEN })
      const brainSendsBearer = createA2ARegistry({ stateDir: brainDir }).get('home')!.outbound_api_key
      // The hand verifies the brain's call with id='wechat-cc' + that bearer:
      expect(createA2ARegistry({ stateDir: handDir }).verifyBearer('wechat-cc', brainSendsBearer)).not.toBeNull()
    } finally {
      rmSync(brainDir, { recursive: true, force: true })
      rmSync(handDir, { recursive: true, force: true })
    }
  })
})

describe('smooth pairing (invite code) end-to-end', () => {
  let brainDir: string
  let handDir: string
  beforeEach(() => {
    brainDir = mkdtempSync(join(tmpdir(), 'brain-'))
    handDir = mkdtempSync(join(tmpdir(), 'hand-'))
  })
  afterEach(() => {
    rmSync(brainDir, { recursive: true, force: true })
    rmSync(handDir, { recursive: true, force: true })
  })

  /** Spin up a hand's A2A server with /a2a/pair wired exactly like bootstrap. */
  async function startHand() {
    const handRegistry = createA2ARegistry({ stateDir: handDir })
    const server = createA2AServer({
      host: '127.0.0.1', port: 0,
      registry: handRegistry,
      onNotify: vi.fn(async () => {}),
      onPair: async ({ secret, brainId, execKey }) => {
        if (!verifyAndConsumeInvite(handDir, secret, Date.now())) return { ok: false, error: 'invalid_or_expired_invite' }
        const existing = handRegistry.get(brainId)
        if (existing) handRegistry.update(brainId, { inbound_api_key: execKey })
        else handRegistry.add({
          id: brainId, name: brainId, url: 'http://brain.local/a2a',
          inbound_api_key: execKey, outbound_api_key: 'unused', capabilities: [], paused: false,
          transport: 'push',
        })
        return { ok: true }
      },
      daemonInfo: { name: 'wechat-cc', version: 'test' },
    })
    await server.start()
    return { server, handRegistry, handUrl: `${server.baseUrl()}/a2a` }
  }

  it('mint on hand → join on brain auto-registers both sides with the same exec key', async () => {
    const { server, handRegistry, handUrl } = await startHand()
    try {
      const { code } = mintInvite(handDir, { handUrl, nowMs: Date.now() })
      const r = await joinHand(brainDir, { code, id: 'home', name: '家里', selfId: 'wechat-cc' })
      expect(r.ok).toBe(true)

      const brainSide = createA2ARegistry({ stateDir: brainDir }).get('home')
      const handSide = handRegistry.get('wechat-cc')
      expect(brainSide).toBeTruthy()
      expect(handSide).toBeTruthy()
      // The key the brain presents (outbound) === the key the hand verifies (inbound).
      expect(brainSide!.outbound_api_key).toBe(handSide!.inbound_api_key)
      expect(brainSide!.url).toBe(handUrl)
      expect(brainSide!.name).toBe('家里')
      expect(brainSide!.capabilities).toContain('exec')
      // And that key actually authenticates an inbound exec call:
      expect(handRegistry.verifyBearer('wechat-cc', brainSide!.outbound_api_key)).not.toBeNull()
    } finally {
      await server.stop()
    }
  })

  it('rejects a second join with the same code (single-use) and rolls back the brain record', async () => {
    const { server, handUrl } = await startHand()
    try {
      const { code } = mintInvite(handDir, { handUrl, nowMs: Date.now() })
      expect((await joinHand(brainDir, { code, id: 'home', selfId: 'wechat-cc' })).ok).toBe(true)

      const second = await joinHand(brainDir, { code, id: 'home2', selfId: 'wechat-cc' })
      expect(second.ok).toBe(false)
      expect(second.error).toMatch(/invalid_or_expired_invite/)
      expect(createA2ARegistry({ stateDir: brainDir }).get('home2')).toBeNull()  // no half-paired record
    } finally {
      await server.stop()
    }
  })

  it('fails cleanly when the hand is unreachable, leaving no brain record', async () => {
    const { code } = mintInvite(handDir, { handUrl: 'http://127.0.0.1:1/a2a', nowMs: Date.now() })
    const r = await joinHand(brainDir, { code, id: 'home', selfId: 'wechat-cc', timeoutMs: 1000 })
    expect(r.ok).toBe(false)
    expect(createA2ARegistry({ stateDir: brainDir }).get('home')).toBeNull()
  })
})

describe('pingHands (reachability)', () => {
  let brainDir: string
  beforeEach(() => { brainDir = mkdtempSync(join(tmpdir(), 'brain-ping-')) })
  afterEach(() => { rmSync(brainDir, { recursive: true, force: true }) })

  it('reports a reachable, exec-advertising hand as ✅ and a dead one as ❌', async () => {
    // A live hand whose Agent Card advertises exec (onExec wired).
    const server = createA2AServer({
      host: '127.0.0.1', port: 0,
      registry: createA2ARegistry({ stateDir: mkdtempSync(join(tmpdir(), 'h-')) }),
      onNotify: vi.fn(async () => {}),
      onExec: vi.fn(async () => ({ ok: true as const, response: 'ok' })),
      daemonInfo: { name: 'wechat-cc', version: '9.9.9' },
    })
    await server.start()
    try {
      addHand(brainDir, { id: 'home', url: `${server.baseUrl()}/a2a`, name: '家里', token: 'shared-secret-0123456789' })
      addHand(brainDir, { id: 'dead', url: 'http://127.0.0.1:1/a2a', name: '死的', token: 'shared-secret-0123456789' })

      const results = await pingHands(brainDir, { timeoutMs: 1500 })
      const home = results.find(r => r.id === 'home')!
      const dead = results.find(r => r.id === 'dead')!
      expect(home.ok).toBe(true)
      expect(home.detail).toContain('wechat-cc')
      expect(home.detail).toContain('9.9.9')
      expect(dead.ok).toBe(false)
    } finally {
      await server.stop()
    }
  })

  it('filters to a specific hand by name', async () => {
    addHand(brainDir, { id: 'home', url: 'http://127.0.0.1:1/a2a', name: '家里', token: 'shared-secret-0123456789' })
    addHand(brainDir, { id: 'office', url: 'http://127.0.0.1:1/a2a', name: '公司', token: 'shared-secret-0123456789' })
    const results = await pingHands(brainDir, { filter: '公司', timeoutMs: 800 })
    expect(results.map(r => r.id)).toEqual(['office'])
  })
})
