import { createDecipheriv, createCipheriv, createHash, randomBytes } from 'node:crypto'
import { readdirSync, rmSync, statSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
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

export function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
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

// NTFS rejects \ / : * ? " < > | and the C0 control range. macOS also
// chokes on `:` (HFS legacy). Linux only blocks NUL and `/`. Sanitize
// for the strictest target so a WeChat-supplied filename like
// `report:2026.docx` or `x<y>.txt` doesn't crash attachment download
// on Windows users. The Date.now() prefix already neutralizes the
// reserved-name family (CON, NUL, COM1, etc.) by ensuring the basename
// starts with digits, but we still strip the trailing `.` / ` ` that
// Windows silently truncates.
const ILLEGAL_FILENAME_CHARS = /[\x00-\x1f<>:"/\\|?*]/g

export async function saveToInbox(
  buf: Buffer,
  filename: string,
  userId: string | undefined,
  inboxDir: string,
): Promise<string> {
  const dir = userId ? join(inboxDir, userId) : inboxDir
  mkdirSync(dir, { recursive: true })
  const cleaned = filename.replace(ILLEGAL_FILENAME_CHARS, '_').replace(/[. ]+$/, '')
  const safeName = `${Date.now()}-${cleaned || 'file'}`
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

// ── Inbound materialization ───────────────────────────────────────────────
// parseUpdates emits attachments with `path: '<pending-cdn-ref>'` and the CDN
// metadata serialized into `caption`. materializeAttachments downloads each
// pending ref to inbox/<userId>/ and rewrites path. On per-attachment failure
// we keep the pending placeholder and log, so one bad CDN fetch doesn't sink
// the whole inbound message.

export const PENDING_CDN_REF = '<pending-cdn-ref>'

import type { InboundMsg } from '../core/prompt-format'

interface PendingCaption {
  media?: CDNMedia
  file_name?: string
  // poll-loop for image/voice/video serializes the media object directly
  // (no wrapper), so the caption JSON may be either { media, file_name } (file)
  // or { encrypt_query_param, aes_key, ... } (image/voice/video).
  encrypt_query_param?: string
  aes_key?: string
  full_url?: string
  encrypt_type?: number
}

function filenameFor(kind: 'image' | 'file' | 'voice', parsed: PendingCaption, ts: number): string {
  if (kind === 'file') return parsed.file_name ?? `file-${ts}.bin`
  if (kind === 'image') return `image-${ts}.jpg`
  // voice: WeChat typical format is AMR; Claude reads ASR transcript instead
  // when available, so the file rarely matters.
  return `voice-${ts}.amr`
}

export async function materializeAttachments(
  msg: InboundMsg,
  inboxDir: string,
  log: (tag: string, line: string) => void = () => {},
): Promise<void> {
  if (!msg.attachments || msg.attachments.length === 0) return

  for (const att of msg.attachments) {
    if (att.path !== PENDING_CDN_REF) continue

    let parsed: PendingCaption
    try { parsed = JSON.parse(att.caption ?? '{}') }
    catch (err) {
      log('MEDIA', `parse caption failed (kind=${att.kind}, user=${msg.userId}): ${err}`)
      continue
    }

    const media: CDNMedia | undefined = parsed.media ?? (
      parsed.encrypt_query_param || parsed.full_url
        ? { encrypt_query_param: parsed.encrypt_query_param, aes_key: parsed.aes_key, full_url: parsed.full_url, encrypt_type: parsed.encrypt_type }
        : undefined
    )
    if (!media || (!media.full_url && !media.encrypt_query_param)) {
      log('MEDIA', `skip attachment with no CDN ref (kind=${att.kind}, user=${msg.userId})`)
      continue
    }

    try {
      const buf = await downloadCdnMedia(media)
      const filename = filenameFor(att.kind, parsed, msg.createTimeMs || Date.now())
      att.path = await saveToInbox(buf, filename, msg.userId, inboxDir)
      att.caption = undefined
      log('MEDIA', `materialized ${att.kind} → ${att.path} (${(buf.length / 1024).toFixed(1)}KB)`)
    } catch (err) {
      log('MEDIA', `download failed (kind=${att.kind}, user=${msg.userId}): ${err}`)
      // Keep path as PENDING_CDN_REF + caption intact — caller still sees the
      // pending ref and can decide what to do (currently: shown to Claude as-is).
    }
  }
}

// ── Outbound helpers ──────────────────────────────────────────────────────
import type { MessageItem } from '../../ilink.ts'
import { ILINK_BASE_INFO, ilinkPost } from '../../ilink.ts'
import { log } from '../../log.ts'

export const UPLOAD_MEDIA_TYPE = { IMAGE: 1, VIDEO: 2, FILE: 3, VOICE: 4 } as const
export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024 // ilink hard cap is higher; 50MB is safe + avoids slow uploads

export const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'])
export const VIDEO_EXTS = new Set(['mp4', 'mov', 'avi', 'webm'])

export function aesEcbPaddedSize(size: number): number {
  return Math.ceil((size + 1) / 16) * 16
}

export function assertSendable(filePath: string): void {
  let st: ReturnType<typeof statSync>
  try { st = statSync(filePath) } catch { throw new Error(`file not found: ${filePath}`) }
  if (!st.isFile()) throw new Error(`not a regular file: ${filePath}`)
  if (st.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(`file too large: ${filePath} (${(st.size / 1024 / 1024).toFixed(1)}MB, max 50MB)`)
  }
}

/** Upload a file to CDN + build the MessageItem ready for item_list. */
export async function buildMediaItemFromFile(
  filePath: string, chat_id: string, baseUrl: string, token: string,
): Promise<MessageItem> {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
  const mediaType = IMAGE_EXTS.has(ext) ? UPLOAD_MEDIA_TYPE.IMAGE
    : VIDEO_EXTS.has(ext) ? UPLOAD_MEDIA_TYPE.VIDEO
    : UPLOAD_MEDIA_TYPE.FILE

  const uploaded = await uploadToCdn({ filePath, toUserId: chat_id, baseUrl, token, mediaType })
  // See cc8f282: aes_key must be base64 of the 32-char hex string, not raw 16 bytes.
  const aesKeyBase64 = Buffer.from(uploaded.aeskey).toString('base64')
  const mediaRef: CDNMedia = { encrypt_query_param: uploaded.downloadParam, aes_key: aesKeyBase64, encrypt_type: 1 }

  if (mediaType === UPLOAD_MEDIA_TYPE.IMAGE) {
    return { type: 2, image_item: { media: mediaRef, mid_size: uploaded.fileSizeCiphertext } }
  }
  if (mediaType === UPLOAD_MEDIA_TYPE.VIDEO) {
    return { type: 5, video_item: { media: mediaRef, video_size: uploaded.fileSizeCiphertext } }
  }
  const fileName = filePath.split('/').pop() ?? 'file'
  return { type: 4, file_item: { media: mediaRef, file_name: fileName, len: String(uploaded.fileSize) } }
}

/** Parse a standard RIFF/WAVE header (PCM only). Returns audio parameters
 *  needed to populate ilink's voice_item. Assumes canonical fmt @ 12, data
 *  chunk immediately after (which is what VoxCPM2 / soundfile produce). */
export function parseWavHeader(buf: Buffer): {
  sampleRate: number; bitsPerSample: number; channels: number; durationMs: number
} {
  const channels = buf.readUInt16LE(22)
  const sampleRate = buf.readUInt32LE(24)
  const bitsPerSample = buf.readUInt16LE(34)
  // Data chunk size at offset 40 in canonical WAV. If non-canonical layout,
  // fall back to (file - header) as an estimate.
  let dataSize = buf.readUInt32LE(40)
  if (dataSize <= 0 || dataSize > buf.length) dataSize = Math.max(0, buf.length - 44)
  const bytesPerSec = sampleRate * channels * (bitsPerSample / 8)
  const durationMs = bytesPerSec > 0 ? Math.round((dataSize / bytesPerSec) * 1000) : 0
  return { sampleRate, bitsPerSample, channels, durationMs }
}

/** Upload a WAV + build a voice_item MessageItem so WeChat renders it as a
 *  voice bubble (tap-to-play) instead of a generic file attachment.
 *
 *  First cut tried raw PCM WAV and WeChat silently dropped it. Per the
 *  epiral/weixin-bot spec, voice_item expects a known codec via encode_type
 *  (1=PCM, 2=ADPCM, 3=FEATURE, 4=SPEEX, 5=AMR, 6=SILK, 7=MP3, 8=OGG-SPEEX)
 *  and incoming messages use encode_type=6 at sample_rate=24000.
 *
 *  SILK needs the Skype codec (not in standard ffmpeg). MP3 is a widely-
 *  supported alternative — transcode WAV→MP3 via libmp3lame, declare
 *  encode_type=7, sample_rate=24000. If WeChat client still won't render a
 *  bubble for MP3, fall back to SILK in a follow-up. */
export async function buildVoiceItemFromWav(
  filePath: string, chat_id: string, baseUrl: string, token: string,
  transcript?: string,
): Promise<MessageItem> {
  const plaintext = Buffer.from(await Bun.file(filePath).arrayBuffer())
  const { durationMs } = parseWavHeader(plaintext)

  // Transcode WAV → MP3 24kHz mono 32kbps to match WeChat voice expectations.
  const mp3Path = filePath.replace(/\.wav$/i, '') + '.mp3'
  const r = spawnSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', filePath,
    '-ar', '24000',
    '-ac', '1',
    '-b:a', '32k',
    '-codec:a', 'libmp3lame',
    mp3Path,
  ], { stdio: ['ignore', 'pipe', 'pipe'] })
  if (r.status !== 0) {
    const stderr = r.stderr?.toString().slice(0, 300) ?? '(no stderr)'
    throw new Error(`ffmpeg WAV→MP3 transcode failed (exit ${r.status}): ${stderr}`)
  }

  try {
    const uploaded = await uploadToCdn({
      filePath: mp3Path, toUserId: chat_id, baseUrl, token,
      mediaType: UPLOAD_MEDIA_TYPE.VOICE,
    })
    const aesKeyBase64 = Buffer.from(uploaded.aeskey).toString('base64')
    const mediaRef: CDNMedia = { encrypt_query_param: uploaded.downloadParam, aes_key: aesKeyBase64, encrypt_type: 1 }

    return {
      type: 3,
      voice_item: {
        media: mediaRef,
        encode_type: 7,       // MP3
        sample_rate: 24000,
        bits_per_sample: 16,
        playtime: durationMs,
        ...(transcript ? { text: transcript } : {}),
      },
    }
  } finally {
    try { unlinkSync(mp3Path) } catch { /* best-effort */ }
  }
}

export async function uploadToCdnOnce(params: {
  filePath: string; toUserId: string; baseUrl: string; token: string; mediaType: number
}): Promise<{ downloadParam: string; aeskey: string; fileSize: number; fileSizeCiphertext: number }> {
  const plaintext = Buffer.from(await Bun.file(params.filePath).arrayBuffer())
  const rawsize = plaintext.length
  const rawfilemd5 = createHash('md5').update(plaintext).digest('hex')
  const filesize = aesEcbPaddedSize(rawsize)
  const filekey = randomBytes(16).toString('hex')
  const aeskey = randomBytes(16)

  const uploadResp = JSON.parse(await ilinkPost(params.baseUrl, 'ilink/bot/getuploadurl', {
    filekey, media_type: params.mediaType, to_user_id: params.toUserId,
    rawsize, rawfilemd5, filesize, no_need_thumb: true, aeskey: aeskey.toString('hex'),
    base_info: ILINK_BASE_INFO,
  }, params.token)) as { upload_full_url?: string; upload_param?: string }

  const uploadUrl = uploadResp.upload_full_url?.trim()
    || (uploadResp.upload_param
      ? `${CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(uploadResp.upload_param)}&filekey=${encodeURIComponent(filekey)}`
      : null)
  if (!uploadUrl) throw new Error('getuploadurl returned no upload URL')

  const ciphertext = encryptAesEcb(plaintext, aeskey)
  // NOTE: do NOT attach AbortSignal to this fetch. Bun appears to switch
  // the body encoding path when a signal is present, which the ilink CDN
  // stores in a form the WeChat client can't decrypt. getuploadurl above
  // already has API_TIMEOUT_MS (30s) via ilinkPost, and the retry wrapper
  // below bounds total wall time, so a signal here is redundant anyway.
  const cdnRes = await fetch(uploadUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: new Uint8Array(ciphertext),
  })
  if (!cdnRes.ok) throw new Error(`CDN upload ${cdnRes.status}: ${await cdnRes.text()}`)

  const downloadParam = cdnRes.headers.get('x-encrypted-param')
  if (!downloadParam) throw new Error('CDN response missing x-encrypted-param header')

  return { downloadParam, aeskey: aeskey.toString('hex'), fileSize: rawsize, fileSizeCiphertext: filesize }
}

// 对齐 ilinkSendMessage 的重试策略：AbortError（getuploadurl 超时）或
// ilink/CDN 5xx 视为瞬时失败，最多 3 次，线性退避。ilink CDN 偶发 500，
// 不重试会导致一次 flaky 就彻底发不出图。
export async function uploadToCdn(params: {
  filePath: string; toUserId: string; baseUrl: string; token: string; mediaType: number
}): Promise<{ downloadParam: string; aeskey: string; fileSize: number; fileSizeCiphertext: number }> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await uploadToCdnOnce(params)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const name = err instanceof Error ? err.name : ''
      const isRetryable = name === 'AbortError'
        || /CDN upload 5\d\d/.test(msg)
        || /^ilink.*5\d\d/.test(msg)
        || /operation was aborted/i.test(msg)
      if (!isRetryable || attempt === 3) throw err
      log('RETRY', `uploadToCdn attempt ${attempt} failed, retrying in ${attempt}s: ${msg}`)
      await new Promise(r => setTimeout(r, attempt * 1000))
    }
  }
  throw new Error('uploadToCdn: exhausted retries') // unreachable
}

// ── Inbox cleanup ─────────────────────────────────────────────────────────
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
