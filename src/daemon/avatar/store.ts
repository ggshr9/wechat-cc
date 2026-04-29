/**
 * Per-contact / Claude avatar store.
 *
 * Files live at <stateDir>/avatars/<safe-filename>.png where:
 *   - "claude" is the literal filename `_claude.png` (single global avatar)
 *   - any other key (chat_id) is sha256-hashed to a 16-hex-char filename
 *     so chat_ids with `@` / `:` / etc. don't break the filesystem
 *
 * The frontend canvas-resizes images to 80x80 PNG before sending bytes
 * here, so this layer just validates the PNG magic and writes.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
const MAX_BYTES = 1024 * 1024  // 1 MB cap; resized 80×80 PNG is typically <30 KB

export interface AvatarInfo {
  exists: boolean
  path: string
}

function avatarFilename(key: string): string {
  if (key === 'claude') return '_claude.png'
  // sha256 → first 16 hex chars: enough entropy to avoid collisions
  // among any plausible chat-id set, but short enough to be readable
  // in the filesystem.
  return createHash('sha256').update(key).digest('hex').slice(0, 16) + '.png'
}

export function avatarPath(stateDir: string, key: string): string {
  return join(stateDir, 'avatars', avatarFilename(key))
}

export function avatarInfo(stateDir: string, key: string): AvatarInfo {
  const path = avatarPath(stateDir, key)
  return { exists: existsSync(path), path }
}

export function setAvatar(
  stateDir: string,
  key: string,
  base64Png: string,
): { ok: true; path: string } {
  // Strip data-URI prefix if the caller passed one (frontend canvas
  // returns "data:image/png;base64,..."); accept both forms.
  const m = base64Png.match(/^data:image\/[a-z]+;base64,(.*)$/i)
  const data = (m ? m[1] : base64Png).trim()
  const buf = Buffer.from(data, 'base64')

  if (buf.length === 0) throw new Error('avatar bytes are empty')
  if (buf.length > MAX_BYTES) throw new Error(`avatar exceeds ${MAX_BYTES} byte cap`)
  if (buf.subarray(0, 8).compare(PNG_MAGIC) !== 0) {
    throw new Error('avatar is not a PNG (magic bytes missing)')
  }

  const dir = join(stateDir, 'avatars')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = avatarPath(stateDir, key)
  writeFileSync(path, buf, { mode: 0o600 })
  return { ok: true, path }
}

export function removeAvatar(stateDir: string, key: string): { ok: true; path: string } {
  const path = avatarPath(stateDir, key)
  if (existsSync(path)) rmSync(path)
  return { ok: true, path }
}
