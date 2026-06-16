import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MULTIDEVICE_MARKER, decryptBundle, exportAccount, importAccount, markMultiDevice, resolveAccountId } from './account-transfer'

let src: string
let dst: string

function seedAccount(stateDir: string, id: string, opts: { token?: string; syncBuf?: boolean } = {}): void {
  const dir = join(stateDir, 'accounts', id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'account.json'), JSON.stringify({ botId: `${id}@im.bot`, userId: 'u@im.wechat', baseUrl: 'https://x' }))
  writeFileSync(join(dir, 'token'), opts.token ?? 'secret-token')
  if (opts.syncBuf) writeFileSync(join(dir, 'sync_buf'), 'cursor-123')
}

beforeEach(() => {
  src = mkdtempSync(join(tmpdir(), 'acct-src-'))
  dst = mkdtempSync(join(tmpdir(), 'acct-dst-'))
})
afterEach(() => {
  rmSync(src, { recursive: true, force: true })
  rmSync(dst, { recursive: true, force: true })
})

describe('resolveAccountId', () => {
  it('returns the sole account', () => {
    seedAccount(src, 'a-im-bot')
    expect(resolveAccountId(src)).toBe('a-im-bot')
  })
  it('matches by prefix and skips superseded dirs', () => {
    seedAccount(src, 'home-im-bot')
    mkdirSync(join(src, 'accounts', 'old.superseded.2026'), { recursive: true })
    expect(resolveAccountId(src, 'home')).toBe('home-im-bot')
  })
  it('throws on multiple without a hint', () => {
    seedAccount(src, 'a-im-bot')
    seedAccount(src, 'b-im-bot')
    expect(() => resolveAccountId(src)).toThrow(/multiple/)
  })
  it('throws when none bound', () => {
    expect(() => resolveAccountId(src)).toThrow(/no bound accounts/)
  })
})

describe('export → import roundtrip', () => {
  it('moves account.json + token to another machine, identical', () => {
    seedAccount(src, 'home-im-bot', { token: 'tok-xyz', syncBuf: true })
    const blob = exportAccount(src, 'home-im-bot', 'pw')
    const res = importAccount(dst, blob, 'pw')
    expect(res.botId).toBe('home-im-bot')
    expect(res.overwritten).toBe(false)
    expect(readFileSync(join(dst, 'accounts', 'home-im-bot', 'token'), 'utf8')).toBe('tok-xyz')
    expect(readFileSync(join(dst, 'accounts', 'home-im-bot', 'account.json'), 'utf8'))
      .toBe(readFileSync(join(src, 'accounts', 'home-im-bot', 'account.json'), 'utf8'))
  })

  it('does NOT carry sync_buf across (receiving machine starts its own cursor)', () => {
    seedAccount(src, 'a-im-bot', { syncBuf: true })
    importAccount(dst, exportAccount(src, 'a-im-bot', 'pw'), 'pw')
    expect(existsSync(join(dst, 'accounts', 'a-im-bot', 'sync_buf'))).toBe(false)
  })

  it('reports overwritten when re-importing the same bot', () => {
    seedAccount(src, 'a-im-bot')
    const blob = exportAccount(src, 'a-im-bot', 'pw')
    importAccount(dst, blob, 'pw')
    expect(importAccount(dst, blob, 'pw').overwritten).toBe(true)
  })

  it('import marks the account multi-device (so the daemon stands by on takeover)', () => {
    seedAccount(src, 'a-im-bot')
    importAccount(dst, exportAccount(src, 'a-im-bot', 'pw'), 'pw')
    expect(existsSync(join(dst, 'accounts', 'a-im-bot', MULTIDEVICE_MARKER))).toBe(true)
  })

  it('markMultiDevice is idempotent and a no-op for a missing account', () => {
    seedAccount(src, 'a-im-bot')
    markMultiDevice(src, 'a-im-bot')
    markMultiDevice(src, 'a-im-bot')
    expect(existsSync(join(src, 'accounts', 'a-im-bot', MULTIDEVICE_MARKER))).toBe(true)
    expect(() => markMultiDevice(src, 'nonexistent')).not.toThrow()
  })
})

describe('encryption guards', () => {
  it('wrong passphrase fails loudly', () => {
    seedAccount(src, 'a-im-bot')
    const blob = exportAccount(src, 'a-im-bot', 'right')
    expect(() => importAccount(dst, blob, 'wrong')).toThrow(/wrong passphrase or corrupt/)
  })
  it('tampered ciphertext fails (GCM auth)', () => {
    seedAccount(src, 'a-im-bot')
    const blob = exportAccount(src, 'a-im-bot', 'pw')
    blob[blob.length - 1] ^= 0xff
    expect(() => decryptBundle(blob, 'pw')).toThrow(/wrong passphrase or corrupt/)
  })
  it('rejects a non-bundle blob', () => {
    expect(() => decryptBundle(Buffer.from('not a bundle at all'), 'pw')).toThrow(/not a wechat-cc account bundle/)
  })
  it('token never appears in plaintext in the bundle', () => {
    seedAccount(src, 'a-im-bot', { token: 'SUPER-SECRET-TOKEN' })
    const blob = exportAccount(src, 'a-im-bot', 'pw')
    expect(blob.toString('latin1')).not.toContain('SUPER-SECRET-TOKEN')
  })
})
