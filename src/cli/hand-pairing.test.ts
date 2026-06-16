import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createA2ARegistry } from '../core/a2a-registry'
import { acceptBrain, addHand } from './hand-pairing'

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
