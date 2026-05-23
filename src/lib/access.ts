/**
 * access.ts — allowlist-based access control.
 *
 * Reads/writes ~/.claude/channels/wechat/access.json, caches in memory
 * (5s TTL), provides gate() to decide whether an inbound message is
 * allowed through.
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs'
import { join } from 'path'
import { STATE_DIR } from './config.ts'

const ACCESS_FILE = join(STATE_DIR, 'access.json')

/**
 * Thrown by readAccessFile when access.json is present but unparseable.
 * Bootstrap catches and decides whether to refuse boot (production) or
 * fall back to defaults (tests / first-run setup wizards). Replaces
 * the prior `process.exit(1)` in readAccessFile which made tests that
 * exercise the corrupt-config path unloadable in-process.
 */
export class AccessConfigCorruptError extends Error {
  constructor(public readonly originalError: unknown, public readonly movedTo: string) {
    const detail = originalError instanceof Error ? originalError.message : String(originalError)
    super(
      `access.json is corrupt (${detail})\n` +
      `  moved aside to: ${movedTo}\n` +
      `  refusing to start with an empty allowlist (silent lockout).\n` +
      `  recover by restoring a known-good copy, or delete the file and run /wechat:access to rebuild.`,
    )
    this.name = 'AccessConfigCorruptError'
  }
}

export interface Access {
  dmPolicy: 'allowlist' | 'disabled'
  allowFrom: string[]
  admins?: string[]
  /**
   * Trusted users get every capability admin has EXCEPT destructive
   * operations (rm / git reset --hard / memory_delete / etc.) — those
   * trigger a permission prompt to the admin chat. Optional field;
   * missing or empty means no users have trusted tier and the operator
   * must explicitly opt people in.
   */
  trusted?: string[]
}

function defaultAccess(): Access {
  return { dmPolicy: 'allowlist', allowFrom: [] }
}

function readAccessFile(): Access {
  try {
    const raw = readFileSync(ACCESS_FILE, 'utf8')
    const parsed = JSON.parse(raw) as Partial<Access>
    return {
      dmPolicy: parsed.dmPolicy ?? 'allowlist',
      allowFrom: parsed.allowFrom ?? [],
      ...(parsed.admins ? { admins: parsed.admins } : {}),
      ...(parsed.trusted ? { trusted: parsed.trusted } : {}),
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return defaultAccess()
    const corruptPath = `${ACCESS_FILE}.corrupt-${Date.now()}`
    try { renameSync(ACCESS_FILE, corruptPath) } catch {}
    // Throw instead of process.exit so bootstrap can decide policy
    // (production: log + exit; tests: catch and use default access).
    // Move-aside happens before the throw so the next start finds an
    // empty slate either way.
    throw new AccessConfigCorruptError(err, corruptPath)
  }
}

export function saveAccess(a: Access): void {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
  const tmp = ACCESS_FILE + '.tmp'
  writeFileSync(tmp, JSON.stringify(a, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, ACCESS_FILE)
}

// Cache access in memory — re-read from disk every 5s max
let _accessCache: Access | null = null
let _accessCacheTime = 0

// Last snapshot observed on a real disk read (post-TTL). Used to detect
// tier-membership changes across reads; reset to null on _resetSnapshotForTest.
// Note: when the cache is hit (within the 5s TTL), no comparison happens —
// operator edits to access.json take effect on the next disk read after TTL
// expiry. Documented behavior; 5s lag is acceptable for the "operator edits
// access.json mid-conversation" case.
let _lastSnapshot: Access | null = null
let _invalidator: (() => void) | null = null

/**
 * Register a callback to fire when admins / trusted / allowFrom set membership
 * changes between two consecutive disk reads of access.json. Bootstrap wires
 * this to sessionManager.shutdown() so the next acquire respawns with the
 * new tier. One-shot: setSessionInvalidator overwrites any previous callback;
 * pass null to clear.
 *
 * dmPolicy changes do NOT fire the invalidator — only the tier-relevant
 * sets do. Errors thrown by the callback are swallowed so a buggy
 * invalidator can't crash the access reader.
 */
export function setSessionInvalidator(fn: (() => void) | null): void {
  _invalidator = fn
}

function setEq(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const s = new Set(a)
  for (const x of b) if (!s.has(x)) return false
  return true
}

function tierMembershipChanged(prev: Access, next: Access): boolean {
  return !setEq(prev.admins ?? [], next.admins ?? [])
      || !setEq(prev.trusted ?? [], next.trusted ?? [])
      || !setEq(prev.allowFrom, next.allowFrom)
}

export function loadAccess(): Access {
  const now = Date.now()
  if (_accessCache && now - _accessCacheTime < 5000) return _accessCache
  const fresh = readAccessFile()
  if (_lastSnapshot && tierMembershipChanged(_lastSnapshot, fresh)) {
    try { _invalidator?.() } catch { /* invalidator errors must not crash the reader */ }
  }
  _lastSnapshot = fresh
  _accessCache = fresh
  _accessCacheTime = now
  return _accessCache
}

/** @internal — for tests only. Clears the in-memory access cache so the
 * next loadAccess() call re-reads from disk. */
export function _clearCache(): void {
  _accessCache = null
  _accessCacheTime = 0
}

/** @internal — for tests only. Clears the last-snapshot so the next
 * loadAccess() behaves as a first-load (no invalidator fire). Paired with
 * setSessionInvalidator(null) in beforeEach to prevent test bleed-through. */
export function _resetSnapshotForTest(): void {
  _lastSnapshot = null
}

export function assertAllowedChat(chat_id: string): void {
  const access = loadAccess()
  if (!access.allowFrom.includes(chat_id)) {
    throw new Error(`chat ${chat_id} is not allowlisted — add via /wechat:access`)
  }
}

export function isAdmin(userId: string): boolean {
  const access = loadAccess()
  if (access.admins?.length) return access.admins.includes(userId)
  return access.allowFrom.includes(userId)
}

export type GateResult =
  | { action: 'deliver' }
  | { action: 'drop' }

export function gate(fromUserId: string): GateResult {
  const access = loadAccess()
  if (access.dmPolicy === 'disabled') return { action: 'drop' }
  if (access.allowFrom.includes(fromUserId)) return { action: 'deliver' }
  return { action: 'drop' }
}
