/**
 * a2a-pairing — the "smooth" pairing layer for one-brain-many-hands (乙).
 *
 * Instead of manually copying a shared token onto both machines (the MVP),
 * the HAND mints a short-lived one-time invite code; the BRAIN joins with it
 * and the two sides auto-register over the tailnet. The hand is the reachable
 * party (it runs the A2A server), so it issues the code and exposes /a2a/pair;
 * the brain calls that endpoint to complete the handshake.
 *
 * This module is the pure core: mint/decode the code + a single-use, TTL'd
 * pending-invite file the hand's /a2a/pair verifies against. No network here.
 */
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const MAGIC = 'WCCP1'
const PENDING_FILE = 'a2a-pair-pending.json'
export const INVITE_TTL_MS = 10 * 60_000

export interface PairCode {
  /** The hand's A2A base url (where the brain POSTs /a2a/pair). */
  handUrl: string
  /** One-time pairing secret, matched against the hand's pending invite. */
  secret: string
}

function pendingPath(stateDir: string): string {
  return join(stateDir, PENDING_FILE)
}

/**
 * On the HAND: mint a one-time invite. Persists the secret + expiry so the
 * hand's /a2a/pair can verify it later, and returns the shareable code.
 */
export function mintInvite(stateDir: string, opts: { handUrl: string; nowMs: number }): { code: string; expiresMs: number } {
  if (!opts.handUrl) throw new Error('handUrl required (enable A2A on a reachable host first)')
  const secret = randomBytes(24).toString('base64url')
  const expiresMs = opts.nowMs + INVITE_TTL_MS
  writeFileSync(pendingPath(stateDir), JSON.stringify({ secret, expiresMs }), { mode: 0o600 })
  const payload: PairCode = { handUrl: opts.handUrl, secret }
  const code = MAGIC + Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  return { code, expiresMs }
}

/** Decode a pairing code (run on the brain). Throws on a malformed code. */
export function decodeInvite(code: string): PairCode {
  if (!code.startsWith(MAGIC)) throw new Error('not a wechat-cc pairing code')
  let p: PairCode
  try {
    p = JSON.parse(Buffer.from(code.slice(MAGIC.length), 'base64url').toString('utf8')) as PairCode
  } catch {
    throw new Error('invalid pairing code')
  }
  if (!p || typeof p.handUrl !== 'string' || typeof p.secret !== 'string' || !p.handUrl || !p.secret) {
    throw new Error('invalid pairing code')
  }
  return p
}

/**
 * On the HAND (from /a2a/pair): verify a presented secret against the pending
 * invite and CONSUME it (single-use) on success. Returns false for no/expired/
 * mismatched invite. Cleared only on success so a wrong guess can't burn a
 * still-valid invite.
 */
export function verifyAndConsumeInvite(stateDir: string, secret: string, nowMs: number): boolean {
  const path = pendingPath(stateDir)
  if (!existsSync(path)) return false
  let pending: { secret?: unknown; expiresMs?: unknown }
  try {
    pending = JSON.parse(readFileSync(path, 'utf8')) as typeof pending
  } catch {
    return false
  }
  const ok = typeof pending.secret === 'string'
    // Never authenticate an empty stored or presented secret —
    // constantTimeEquals('', '') is true, so a corrupt/hand-edited pending file
    // with an empty secret + an empty presented secret would otherwise pass.
    && pending.secret.length > 0
    && secret.length > 0
    && typeof pending.expiresMs === 'number'
    && constantTimeEquals(pending.secret, secret)
    && nowMs <= pending.expiresMs
  if (ok) { try { rmSync(path) } catch { /* best-effort */ } }
  return ok
}

/**
 * Derive a hand's /a2a/pair URL from its base url, tolerating the same shapes
 * as handExecUrl (bare base, `/a2a`, `/a2a/notify`, `/a2a/exec`, `/a2a/pair`).
 */
export function pairUrl(handUrl: string): string {
  const u = handUrl.replace(/\/+$/, '')
  if (u.endsWith('/a2a/pair')) return u
  if (u.endsWith('/a2a/notify')) return u.replace(/\/a2a\/notify$/, '/a2a/pair')
  if (u.endsWith('/a2a/exec')) return u.replace(/\/a2a\/exec$/, '/a2a/pair')
  if (u.endsWith('/a2a')) return `${u}/pair`
  return `${u}/a2a/pair`
}

/** Clear any pending invite (e.g. `hand invite --cancel`). */
export function clearInvite(stateDir: string): void {
  try { rmSync(pendingPath(stateDir)) } catch { /* none */ }
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
