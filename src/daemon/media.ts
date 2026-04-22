import { createDecipheriv, createCipheriv } from 'node:crypto'
import { readdirSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { Buffer } from 'node:buffer'

export const CDN_BASE_URL = 'https://cdn.ilinkai.weixin.qq.com'

export interface CDNMedia {
  full_url?: string
  encrypt_query_param?: string
  aes_key?: string
  encrypt_type?: number
}

export function parseAesKey(aesKeyBase64: string): Buffer {
  const decoded = Buffer.from(aesKeyBase64, 'base64')
  if (decoded.length === 16) return decoded
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString('ascii'))) {
    return Buffer.from(decoded.toString('ascii'), 'hex')
  }
  throw new Error(`invalid aes_key: expected 16 raw or 32 hex bytes, got ${decoded.length}`)
}

export function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer {
  const decipher = createDecipheriv('aes-128-ecb', key, null)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

/**
 * Test-only export — wechat-cc production doesn't encrypt for inbound;
 * outbound upload has its own path (src/daemon/media-outbound.ts, future).
 * Exported here so the AES ECB round-trip test can verify decryptAesEcb.
 */
export function encryptAesEcbForTestOnly(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv('aes-128-ecb', key, null)
  return Buffer.concat([cipher.update(plaintext), cipher.final()])
}

export async function downloadCdnMedia(media: CDNMedia, aesKeyHexOverride?: string): Promise<Buffer> {
  let url: string
  if (media.full_url) {
    url = media.full_url
  } else if (media.encrypt_query_param) {
    url = `${CDN_BASE_URL}/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param)}`
  } else {
    throw new Error('no download URL: need full_url or encrypt_query_param')
  }

  const res = await fetch(url)
  if (!res.ok) throw new Error(`CDN download ${res.status}: ${res.statusText}`)
  const encrypted = Buffer.from(await res.arrayBuffer())

  const key = aesKeyHexOverride
    ? Buffer.from(aesKeyHexOverride, 'hex')
    : media.aes_key ? parseAesKey(media.aes_key) : null

  if (!key) return encrypted
  return decryptAesEcb(encrypted, key)
}

export async function saveToInbox(
  buf: Buffer,
  filename: string,
  userId: string | undefined,
  inboxDir: string,
): Promise<string> {
  const dir = userId ? join(inboxDir, userId) : inboxDir
  mkdirSync(dir, { recursive: true })
  // Sanitize path separators and null bytes, preserve unicode.
  const safeName = `${Date.now()}-${filename.replace(/[\x00/\\]/g, '_')}`
  const filePath = join(dir, safeName)
  writeFileSync(filePath, buf)
  return filePath
}

const PREVIEW_MAX_BYTES = 10 * 1024
const PREVIEW_MAX_LINES = 5
const TEXT_PREVIEW_EXTS = new Set([
  '.csv', '.tsv', '.md', '.txt', '.json', '.yml', '.yaml',
  '.toml', '.ini', '.xml', '.html', '.log',
  '.ts', '.js', '.py', '.sh', '.rb', '.go', '.rs',
])

export function buildInboundFilePreview(path: string, fileName: string, buf: Buffer): string {
  const sizeKb = (buf.length / 1024).toFixed(1)
  const base = `[文件已下载: ${path}] (${fileName}, ${sizeKb}KB)`

  const extMatch = fileName.match(/(\.[^./\\]+)$/)
  const ext = (extMatch?.[1] ?? '').toLowerCase()
  if (buf.length > PREVIEW_MAX_BYTES || !TEXT_PREVIEW_EXTS.has(ext)) {
    return base
  }

  let text: string
  try { text = buf.toString('utf8') }
  catch { return base }

  const ctrlCount = (text.match(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g) ?? []).length
  if (ctrlCount / Math.max(text.length, 1) > 0.1) {
    return base
  }

  const allLines = text.split('\n')
  const shown = allLines.slice(0, PREVIEW_MAX_LINES)
  while (shown.length > 0 && shown[shown.length - 1] === '') shown.pop()
  const preview = shown.join('\n')
  const moreLines = allLines.length > shown.length ? ` (共 ${allLines.length} 行)` : ''
  return `${base}${moreLines}\n--- 前 ${shown.length} 行预览 ---\n${preview}\n---`
}

const INBOX_TTL_MS = 30 * 24 * 60 * 60 * 1000

export function cleanupOldInbox(inboxDir: string, now: number = Date.now()): number {
  let removed = 0
  let chats: string[]
  try { chats = readdirSync(inboxDir) } catch { return 0 }
  for (const chat of chats) {
    const dir = join(inboxDir, chat)
    let files: string[]
    try { files = readdirSync(dir) } catch { continue }
    for (const name of files) {
      const full = join(dir, name)
      try {
        const st = statSync(full)
        if (st.isFile() && now - st.mtimeMs > INBOX_TTL_MS) {
          rmSync(full, { force: true })
          removed++
        }
      } catch {
        // skip unreadable file — don't abort sweep
      }
    }
  }
  return removed
}
