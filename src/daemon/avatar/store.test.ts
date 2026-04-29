import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { avatarPath, avatarInfo, setAvatar, removeAvatar } from './store'

// 1×1 transparent PNG, base64
const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAUAAeImBZsAAAAASUVORK5CYII='

describe('avatar store', () => {
  let stateDir: string
  beforeEach(() => { stateDir = mkdtempSync(join(tmpdir(), 'avatar-')) })
  afterEach(() => rmSync(stateDir, { recursive: true, force: true }))

  describe('avatarPath', () => {
    it('uses literal _claude.png for the "claude" key', () => {
      expect(avatarPath(stateDir, 'claude')).toBe(join(stateDir, 'avatars', '_claude.png'))
    })

    it('hashes arbitrary chat_id to a fs-safe filename', () => {
      const path = avatarPath(stateDir, 'o9cq800sObd3lbrHBgiItB1pooDQ@im.wechat')
      expect(path).toMatch(/avatars\/[0-9a-f]{16}\.png$/)
      // Same input → same path (deterministic)
      expect(avatarPath(stateDir, 'o9cq800sObd3lbrHBgiItB1pooDQ@im.wechat')).toBe(path)
    })

    it('different chat_ids → different filenames', () => {
      expect(avatarPath(stateDir, 'a')).not.toBe(avatarPath(stateDir, 'b'))
    })
  })

  describe('avatarInfo', () => {
    it('returns exists:false when file is absent', () => {
      const info = avatarInfo(stateDir, 'claude')
      expect(info.exists).toBe(false)
      expect(info.path).toBe(join(stateDir, 'avatars', '_claude.png'))
    })

    it('returns exists:true after setAvatar', () => {
      setAvatar(stateDir, 'claude', TINY_PNG_BASE64)
      expect(avatarInfo(stateDir, 'claude').exists).toBe(true)
    })
  })

  describe('setAvatar', () => {
    it('writes the PNG bytes to disk + creates avatars/ dir if missing', () => {
      const { ok, path } = setAvatar(stateDir, 'claude', TINY_PNG_BASE64)
      expect(ok).toBe(true)
      expect(existsSync(path)).toBe(true)
      const written = readFileSync(path)
      expect(written.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4E, 0x47]))
    })

    it('accepts data-URI prefix form', () => {
      setAvatar(stateDir, 'claude', `data:image/png;base64,${TINY_PNG_BASE64}`)
      expect(avatarInfo(stateDir, 'claude').exists).toBe(true)
    })

    it('rejects non-PNG bytes', () => {
      const jpgBase64 = '/9j/4AAQSkZJRg=='
      expect(() => setAvatar(stateDir, 'claude', jpgBase64)).toThrow(/PNG/)
    })

    it('rejects empty input', () => {
      expect(() => setAvatar(stateDir, 'claude', '')).toThrow(/empty/)
    })

    it('overwrites an existing avatar', () => {
      setAvatar(stateDir, 'claude', TINY_PNG_BASE64)
      setAvatar(stateDir, 'claude', TINY_PNG_BASE64)
      // Still exists, no error
      expect(avatarInfo(stateDir, 'claude').exists).toBe(true)
    })
  })

  describe('removeAvatar', () => {
    it('deletes an existing avatar', () => {
      setAvatar(stateDir, 'claude', TINY_PNG_BASE64)
      const { ok } = removeAvatar(stateDir, 'claude')
      expect(ok).toBe(true)
      expect(avatarInfo(stateDir, 'claude').exists).toBe(false)
    })

    it('is a no-op when avatar does not exist', () => {
      const { ok } = removeAvatar(stateDir, 'never-set')
      expect(ok).toBe(true)
    })
  })
})
