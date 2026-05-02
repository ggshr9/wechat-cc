import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { parseAesKey, decryptAesEcb, encryptAesEcb, saveToInbox, buildInboundFilePreview, aesEcbPaddedSize, assertSendable, materializeAttachments, PENDING_CDN_REF } from './media'
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync, truncateSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Buffer } from 'node:buffer'
import type { InboundMsg } from '../core/prompt-format'

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
    const cipher = encryptAesEcb(plain, key)
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

describe('aesEcbPaddedSize', () => {
  it('pads 0 bytes to 16 (PKCS#7 always adds at least 1 padding byte)', () => {
    expect(aesEcbPaddedSize(0)).toBe(16)
  })

  it('pads 15 bytes to 16', () => {
    expect(aesEcbPaddedSize(15)).toBe(16)
  })

  it('pads 16 bytes to 32 (block boundary + mandatory padding block)', () => {
    expect(aesEcbPaddedSize(16)).toBe(32)
  })

  it('pads 17 bytes to 32', () => {
    expect(aesEcbPaddedSize(17)).toBe(32)
  })

  it('pads 31 bytes to 32', () => {
    expect(aesEcbPaddedSize(31)).toBe(32)
  })
})

describe('assertSendable', () => {
  it('accepts an existing regular file within size limit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wcc-assert-'))
    const p = join(dir, 'ok.txt')
    writeFileSync(p, 'hello')
    expect(() => assertSendable(p)).not.toThrow()
  })

  it('throws for a missing path', () => {
    expect(() => assertSendable('/does/not/exist/ever.txt')).toThrow(/file not found/)
  })

  it('throws for a directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wcc-assert-'))
    expect(() => assertSendable(dir)).toThrow(/not a regular file/)
  })

  it('throws for a file exceeding 50MB', () => {
    // Use truncateSync to set file size past the limit without allocating RAM.
    const dir = mkdtempSync(join(tmpdir(), 'wcc-assert-'))
    const p = join(dir, 'big.bin')
    writeFileSync(p, Buffer.alloc(1))
    truncateSync(p, 50 * 1024 * 1024 + 1)
    expect(() => assertSendable(p)).toThrow(/file too large/)
  })
})

describe('materializeAttachments', () => {
  const realFetch = globalThis.fetch
  beforeEach(() => { globalThis.fetch = realFetch })
  afterEach(() => { globalThis.fetch = realFetch; vi.restoreAllMocks() })

  function makeMsg(attachments: InboundMsg['attachments']): InboundMsg {
    return {
      chatId: 'chat-1', userId: 'user-1', text: '', msgType: 'image',
      createTimeMs: 1700000000000, accountId: 'acct-1', attachments,
    }
  }

  it('downloads, decrypts, and rewrites image path; clears caption', async () => {
    const inbox = mkdtempSync(join(tmpdir(), 'wcc-mat-'))
    const key = Buffer.alloc(16, 0x42)
    const plain = Buffer.from('PNG bytes here')
    const cipher = encryptAesEcb(plain, key)
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => cipher.buffer.slice(cipher.byteOffset, cipher.byteOffset + cipher.byteLength),
    })) as unknown as typeof fetch

    const msg = makeMsg([{
      kind: 'image',
      path: PENDING_CDN_REF,
      caption: JSON.stringify({ encrypt_query_param: 'foo', aes_key: key.toString('base64') }),
    }])
    await materializeAttachments(msg, inbox)

    expect(msg.attachments![0]!.path).not.toBe(PENDING_CDN_REF)
    expect(msg.attachments![0]!.path).toContain(inbox)
    expect(msg.attachments![0]!.path).toMatch(/image-\d+\.jpg$/)
    expect(msg.attachments![0]!.caption).toBeUndefined()
    expect(readFileSync(msg.attachments![0]!.path).equals(plain)).toBe(true)
  })

  it('keeps pending placeholder when CDN download fails', async () => {
    const inbox = mkdtempSync(join(tmpdir(), 'wcc-mat-'))
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 500, statusText: 'oops' })) as unknown as typeof fetch
    const captured: string[] = []

    const msg = makeMsg([{
      kind: 'image',
      path: PENDING_CDN_REF,
      caption: JSON.stringify({ full_url: 'http://example/x' }),
    }])
    await materializeAttachments(msg, inbox, (_t, l) => captured.push(l))

    expect(msg.attachments![0]!.path).toBe(PENDING_CDN_REF)
    expect(captured.some(l => /download failed/.test(l))).toBe(true)
  })

  it('uses file_name from caption for files', async () => {
    const inbox = mkdtempSync(join(tmpdir(), 'wcc-mat-'))
    const key = Buffer.alloc(16, 0x10)
    const plain = Buffer.from('hello.csv content')
    const cipher = encryptAesEcb(plain, key)
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => cipher.buffer.slice(cipher.byteOffset, cipher.byteOffset + cipher.byteLength),
    })) as unknown as typeof fetch

    const msg = makeMsg([{
      kind: 'file',
      path: PENDING_CDN_REF,
      caption: JSON.stringify({
        media: { encrypt_query_param: 'q', aes_key: key.toString('base64') },
        file_name: 'report.csv',
      }),
    }])
    await materializeAttachments(msg, inbox)

    expect(msg.attachments![0]!.path).toMatch(/\d+-report\.csv$/)
    expect(readFileSync(msg.attachments![0]!.path).toString('utf8')).toBe('hello.csv content')
  })

  it('skips already-materialized attachments and ones with no CDN ref', async () => {
    const inbox = mkdtempSync(join(tmpdir(), 'wcc-mat-'))
    const fetchSpy = vi.fn()
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    const msg = makeMsg([
      { kind: 'image', path: '/already/here.jpg' },
      { kind: 'voice', path: PENDING_CDN_REF, caption: '{}' },
    ])
    await materializeAttachments(msg, inbox)

    expect(msg.attachments![0]!.path).toBe('/already/here.jpg')
    expect(msg.attachments![1]!.path).toBe(PENDING_CDN_REF)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('is a no-op when message has no attachments', async () => {
    const inbox = mkdtempSync(join(tmpdir(), 'wcc-mat-'))
    const msg: InboundMsg = {
      chatId: 'c', userId: 'u', text: 'hi', msgType: 'text',
      createTimeMs: 0, accountId: 'a',
    }
    await expect(materializeAttachments(msg, inbox)).resolves.toBeUndefined()
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
