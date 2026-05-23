import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// Override STATE_DIR BEFORE access.ts loads config.ts, so all file
// operations go to a temp directory instead of the real state dir.
const TEST_DIR = join(tmpdir(), `wechat-cc-access-test-${Date.now()}`)
vi.mock('./config.ts', () => ({
  STATE_DIR: TEST_DIR,
  ILINK_BASE_URL: 'https://ilinkai.weixin.qq.com',
  ILINK_APP_ID: 'bot',
  ILINK_BOT_TYPE: '3',
  LONG_POLL_TIMEOUT_MS: 35_000,
}))

mkdirSync(TEST_DIR, { recursive: true })
const ACCESS_FILE = join(TEST_DIR, 'access.json')

function writeAccess(obj: object): void {
  writeFileSync(ACCESS_FILE, JSON.stringify(obj, null, 2))
}

const { gate, isAdmin, loadAccess, saveAccess, _clearCache, setSessionInvalidator, _resetSnapshotForTest } = await import('./access')

beforeEach(() => {
  try { rmSync(ACCESS_FILE) } catch {}
  _clearCache()
  _resetSnapshotForTest()
  setSessionInvalidator(null)
})

afterAll(() => {
  try { rmSync(TEST_DIR, { recursive: true }) } catch {}
})

describe('gate', () => {
  it('delivers to allowlisted user', () => {
    writeAccess({ dmPolicy: 'allowlist', allowFrom: ['alice@im.wechat'] })
    expect(gate('alice@im.wechat')).toEqual({ action: 'deliver' })
  })

  it('drops non-allowlisted user', () => {
    writeAccess({ dmPolicy: 'allowlist', allowFrom: ['alice@im.wechat'] })
    expect(gate('bob@im.wechat')).toEqual({ action: 'drop' })
  })

  it('drops everyone when policy is disabled', () => {
    writeAccess({ dmPolicy: 'disabled', allowFrom: ['alice@im.wechat'] })
    expect(gate('alice@im.wechat')).toEqual({ action: 'drop' })
  })

  it('drops when allowFrom is empty', () => {
    writeAccess({ dmPolicy: 'allowlist', allowFrom: [] })
    expect(gate('anyone@im.wechat')).toEqual({ action: 'drop' })
  })

  it('drops when access.json missing (default)', () => {
    expect(gate('anyone@im.wechat')).toEqual({ action: 'drop' })
  })
})

describe('isAdmin', () => {
  it('treats all allowlisted users as admin when admins not set', () => {
    writeAccess({ dmPolicy: 'allowlist', allowFrom: ['alice@im.wechat', 'bob@im.wechat'] })
    expect(isAdmin('alice@im.wechat')).toBe(true)
    expect(isAdmin('bob@im.wechat')).toBe(true)
  })

  it('returns false for non-allowlisted user when admins not set', () => {
    writeAccess({ dmPolicy: 'allowlist', allowFrom: ['alice@im.wechat'] })
    expect(isAdmin('eve@im.wechat')).toBe(false)
  })

  it('restricts to admins array when present', () => {
    writeAccess({
      dmPolicy: 'allowlist',
      allowFrom: ['alice@im.wechat', 'bob@im.wechat'],
      admins: ['alice@im.wechat'],
    })
    expect(isAdmin('alice@im.wechat')).toBe(true)
    expect(isAdmin('bob@im.wechat')).toBe(false)
  })
})

describe('saveAccess + loadAccess round-trip', () => {
  it('preserves all fields', () => {
    saveAccess({
      dmPolicy: 'allowlist',
      allowFrom: ['alice@im.wechat'],
      admins: ['alice@im.wechat'],
    })
    _clearCache()
    const loaded = loadAccess()
    expect(loaded.dmPolicy).toBe('allowlist')
    expect(loaded.allowFrom).toEqual(['alice@im.wechat'])
    expect(loaded.admins).toEqual(['alice@im.wechat'])
  })
})

describe('trusted field', () => {
  it('parses trusted array when present', () => {
    writeAccess({
      dmPolicy: 'allowlist',
      allowFrom: ['u1', 'u2'],
      admins: ['u1'],
      trusted: ['u2'],
    })
    const loaded = loadAccess()
    expect(loaded.trusted).toEqual(['u2'])
  })

  it('parses as undefined when trusted is omitted (not empty array)', () => {
    writeAccess({
      dmPolicy: 'allowlist',
      allowFrom: ['u1'],
      admins: ['u1'],
    })
    const loaded = loadAccess()
    expect(loaded.trusted).toBeUndefined()
  })
})

describe('session invalidator', () => {
  it('emits invalidation when tier membership changes', () => {
    let invalidated = 0
    setSessionInvalidator(() => { invalidated++ })

    // First load — initialises snapshot
    writeAccess({ dmPolicy: 'allowlist', allowFrom: ['x'], admins: ['x'] })
    loadAccess()
    expect(invalidated).toBe(0)

    // Rewrite with no change — no invalidation
    _clearCache()
    writeAccess({ dmPolicy: 'allowlist', allowFrom: ['x'], admins: ['x'] })
    loadAccess()
    expect(invalidated).toBe(0)

    // Rewrite changing admins — invalidates
    _clearCache()
    writeAccess({ dmPolicy: 'allowlist', allowFrom: ['x', 'y'], admins: ['x', 'y'] })
    loadAccess()
    expect(invalidated).toBe(1)
  })

  it('does not invalidate on first load', () => {
    let invalidated = 0
    setSessionInvalidator(() => { invalidated++ })
    writeAccess({ dmPolicy: 'allowlist', allowFrom: ['x'], admins: ['x'] })
    loadAccess()
    expect(invalidated).toBe(0)
  })

  it('treats admins/trusted/allowFrom as sets (order-insensitive)', () => {
    let invalidated = 0
    writeAccess({ dmPolicy: 'allowlist', allowFrom: ['a', 'b'], admins: ['a', 'b'], trusted: ['c', 'd'] })
    loadAccess()
    setSessionInvalidator(() => { invalidated++ })

    _clearCache()
    writeAccess({ dmPolicy: 'allowlist', allowFrom: ['b', 'a'], admins: ['b', 'a'], trusted: ['d', 'c'] })
    loadAccess()
    expect(invalidated).toBe(0)
  })

  it('does not invalidate on dmPolicy-only change', () => {
    let invalidated = 0
    writeAccess({ dmPolicy: 'allowlist', allowFrom: ['x'], admins: ['x'] })
    loadAccess()
    setSessionInvalidator(() => { invalidated++ })

    _clearCache()
    writeAccess({ dmPolicy: 'disabled', allowFrom: ['x'], admins: ['x'] })
    loadAccess()
    expect(invalidated).toBe(0)
  })

  it('invalidates on trusted-only change', () => {
    let invalidated = 0
    writeAccess({ dmPolicy: 'allowlist', allowFrom: ['x'], admins: ['x'], trusted: ['y'] })
    loadAccess()
    setSessionInvalidator(() => { invalidated++ })

    _clearCache()
    writeAccess({ dmPolicy: 'allowlist', allowFrom: ['x'], admins: ['x'], trusted: ['y', 'z'] })
    loadAccess()
    expect(invalidated).toBe(1)
  })

  it('invalidates on allowFrom-only change', () => {
    let invalidated = 0
    writeAccess({ dmPolicy: 'allowlist', allowFrom: ['x'], admins: ['x'] })
    loadAccess()
    setSessionInvalidator(() => { invalidated++ })

    _clearCache()
    writeAccess({ dmPolicy: 'allowlist', allowFrom: ['x', 'y'], admins: ['x'] })
    loadAccess()
    expect(invalidated).toBe(1)
  })

  it('swallows errors thrown by the invalidator', () => {
    writeAccess({ dmPolicy: 'allowlist', allowFrom: ['x'], admins: ['x'] })
    loadAccess()
    setSessionInvalidator(() => { throw new Error('boom') })

    _clearCache()
    writeAccess({ dmPolicy: 'allowlist', allowFrom: ['x', 'y'], admins: ['x', 'y'] })
    expect(() => loadAccess()).not.toThrow()
  })
})
