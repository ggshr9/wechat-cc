import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { INVITE_TTL_MS, clearInvite, decodeInvite, mintInvite, verifyAndConsumeInvite } from './a2a-pairing'

let stateDir: string
const NOW = 1_000_000

beforeEach(() => { stateDir = mkdtempSync(join(tmpdir(), 'a2a-pair-')) })
afterEach(() => { rmSync(stateDir, { recursive: true, force: true }) })

describe('mint/decode', () => {
  it('round-trips the hand url + secret through the code', () => {
    const { code } = mintInvite(stateDir, { handUrl: 'http://home.ts.net:8717/a2a', nowMs: NOW })
    const decoded = decodeInvite(code)
    expect(decoded.handUrl).toBe('http://home.ts.net:8717/a2a')
    expect(decoded.secret.length).toBeGreaterThan(20)
  })
  it('rejects a non-pairing / malformed code', () => {
    expect(() => decodeInvite('not-a-code')).toThrow(/not a wechat-cc pairing code/)
    expect(() => decodeInvite('WCCP1@@@notbase64json')).toThrow(/invalid pairing code/)
  })
})

describe('verifyAndConsumeInvite', () => {
  it('accepts the matching secret once, then it is consumed (single-use)', () => {
    const { code } = mintInvite(stateDir, { handUrl: 'http://h/a2a', nowMs: NOW })
    const { secret } = decodeInvite(code)
    expect(verifyAndConsumeInvite(stateDir, secret, NOW)).toBe(true)
    // second use fails — consumed
    expect(verifyAndConsumeInvite(stateDir, secret, NOW)).toBe(false)
  })

  it('rejects an empty stored secret — no constant-time empty-match bypass', () => {
    // A corrupt / hand-edited pending file with an empty secret must NOT
    // authenticate an empty presented secret: constantTimeEquals('','') is true.
    writeFileSync(join(stateDir, 'a2a-pair-pending.json'), JSON.stringify({ secret: '', expiresMs: NOW + INVITE_TTL_MS }))
    expect(verifyAndConsumeInvite(stateDir, '', NOW)).toBe(false)
  })

  it('rejects a wrong secret WITHOUT burning the invite', () => {
    const { code } = mintInvite(stateDir, { handUrl: 'http://h/a2a', nowMs: NOW })
    const { secret } = decodeInvite(code)
    expect(verifyAndConsumeInvite(stateDir, 'wrong-secret', NOW)).toBe(false)
    // the real secret still works
    expect(verifyAndConsumeInvite(stateDir, secret, NOW)).toBe(true)
  })

  it('rejects an expired invite', () => {
    const { code } = mintInvite(stateDir, { handUrl: 'http://h/a2a', nowMs: NOW })
    const { secret } = decodeInvite(code)
    expect(verifyAndConsumeInvite(stateDir, secret, NOW + INVITE_TTL_MS + 1)).toBe(false)
  })

  it('returns false when there is no pending invite', () => {
    expect(verifyAndConsumeInvite(stateDir, 'whatever', NOW)).toBe(false)
  })
})

describe('clearInvite', () => {
  it('removes the pending invite', () => {
    mintInvite(stateDir, { handUrl: 'http://h/a2a', nowMs: NOW })
    expect(existsSync(join(stateDir, 'a2a-pair-pending.json'))).toBe(true)
    clearInvite(stateDir)
    expect(existsSync(join(stateDir, 'a2a-pair-pending.json'))).toBe(false)
  })
})
