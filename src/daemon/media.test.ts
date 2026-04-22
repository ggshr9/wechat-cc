import { describe, it, expect } from 'vitest'
import { parseAesKey, decryptAesEcb, encryptAesEcbForTestOnly, saveToInbox, buildInboundFilePreview } from './media'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Buffer } from 'node:buffer'

describe('parseAesKey', () => {
  it('accepts 16 raw bytes (base64-encoded)', () => {
    const raw = Buffer.alloc(16, 0xab)
    const b64 = raw.toString('base64')
    const k = parseAesKey(b64)
    expect(k.length).toBe(16)
    expect(k.equals(raw)).toBe(true)
  })

  it('accepts 32 hex chars (base64-encoded as ascii hex)', () => {
    const rawHex = 'aabbccddeeff00112233445566778899'
    const b64 = Buffer.from(rawHex, 'ascii').toString('base64')
    const k = parseAesKey(b64)
    expect(k.length).toBe(16)
    expect(k.toString('hex')).toBe(rawHex)
  })

  it('rejects other lengths', () => {
    expect(() => parseAesKey(Buffer.alloc(8).toString('base64'))).toThrow(/invalid aes_key/)
  })
})

describe('AES ECB round trip', () => {
  it('encrypt then decrypt recovers the plaintext', () => {
    const key = Buffer.alloc(16, 0x42)
    const plain = Buffer.from('Hello, WeChat! This is a test message — 中文')
    const cipher = encryptAesEcbForTestOnly(plain, key)
    const decoded = decryptAesEcb(cipher, key)
    expect(decoded.equals(plain)).toBe(true)
  })
})

describe('saveToInbox', () => {
  it('writes buffer to inboxDir/userId/TS-filename', async () => {
    const inbox = mkdtempSync(join(tmpdir(), 'wcc-inbox-'))
    const buf = Buffer.from('hello')
    const p = await saveToInbox(buf, 'photo.jpg', 'user42', inbox)
    expect(existsSync(p)).toBe(true)
    expect(p).toContain(inbox)
    expect(p).toContain('user42')
    expect(p).toMatch(/\d+-photo\.jpg$/)
    expect(readFileSync(p).equals(buf)).toBe(true)
  })

  it('sanitizes path separators + nulls in filename (preserves Chinese)', async () => {
    const inbox = mkdtempSync(join(tmpdir(), 'wcc-inbox-'))
    const buf = Buffer.from('x')
    const p = await saveToInbox(buf, '../ev\0il/中文.txt', 'u', inbox)
    const basename = p.split(/[/\\]/).pop() ?? ''
    expect(basename).not.toContain('/')
    expect(basename).not.toContain('\\')
    expect(basename).not.toContain('\0')
    expect(basename).toContain('中文')
  })

  it('writes to inboxDir root when userId omitted', async () => {
    const inbox = mkdtempSync(join(tmpdir(), 'wcc-inbox-'))
    const p = await saveToInbox(Buffer.from('x'), 'a.txt', undefined, inbox)
    const userDir = p.slice(inbox.length).split(/[/\\]/).filter(Boolean)
    expect(userDir.length).toBe(1)  // just the filename, no userId subdir
  })
})

describe('buildInboundFilePreview', () => {
  it('returns base-only line for binary files', () => {
    const out = buildInboundFilePreview('/abs/x.bin', 'x.bin', Buffer.from([0xff, 0xfe, 0x00, 0x01]))
    expect(out).toMatch(/\[文件已下载: \/abs\/x\.bin\] \(x\.bin, 0\.0KB\)$/)
    expect(out).not.toContain('前')
  })

  it('previews small text files with first 5 lines', () => {
    const body = 'line1\nline2\nline3\nline4\nline5\nline6\nline7'
    const out = buildInboundFilePreview('/abs/x.txt', 'x.txt', Buffer.from(body))
    expect(out).toContain('前 5 行预览')
    expect(out).toContain('line1')
    expect(out).toContain('line5')
    expect(out).not.toContain('line6')
    expect(out).toContain('共 7 行')
  })

  it('returns base-only for oversized files (>10KB)', () => {
    const big = Buffer.alloc(11 * 1024, 0x41)  // 11KB of 'A'
    const out = buildInboundFilePreview('/a/big.txt', 'big.txt', big)
    expect(out).not.toContain('前')
  })

  it('returns base-only for unknown extensions', () => {
    const out = buildInboundFilePreview('/a/x.xyz', 'x.xyz', Buffer.from('short text'))
    expect(out).not.toContain('前')
  })
})
