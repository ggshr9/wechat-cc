/**
 * account-transfer — export/import a bound bot account between machines, so
 * you scan ONCE and share the same bot across your devices (no re-scan).
 *
 * Only `account.json` + `token` travel — `sync_buf` (the per-machine poll
 * cursor) is intentionally excluded so the receiving machine starts its own.
 *
 * The `token` is a bearer credential with full control of the WeChat bot, so
 * the bundle is ALWAYS encrypted: AES-256-GCM with a scrypt-derived key from a
 * user passphrase. GCM's auth tag also makes tampering / wrong-passphrase fail
 * loudly rather than silently producing garbage.
 *
 * Bundle layout (bytes): MAGIC(5) | salt(16) | iv(12) | tag(16) | ciphertext
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const MAGIC = 'WCCA1'
const SALT_LEN = 16
const IV_LEN = 12
const TAG_LEN = 16
// Only these files cross machines (sandbox the import write surface).
const PORTABLE_FILES = ['account.json', 'token'] as const
// Presence of this file in an account dir marks it as shared across devices.
// The daemon reads it to treat an errcode=-14 takeover as a graceful standby
// (sibling device took the session) rather than a dead/expired session.
export const MULTIDEVICE_MARKER = '.multidevice'

/** Mark an account as multi-device (shared). Idempotent. */
export function markMultiDevice(stateDir: string, accountId: string): void {
  const dir = join(stateDir, 'accounts', accountId)
  if (!existsSync(dir)) return
  writeFileSync(join(dir, MULTIDEVICE_MARKER), '', { mode: 0o600 })
}

interface AccountBundle {
  v: 1
  /** Account dir name (== the daemon's account id). */
  botId: string
  files: Record<string, string>
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, 32)
}

/**
 * Resolve which account to export: the sole bound one, or the one matching
 * `botIdHint` (exact or prefix). Throws with a helpful message otherwise.
 * Skips `.superseded.` archive dirs.
 */
export function resolveAccountId(stateDir: string, botIdHint?: string): string {
  const dir = join(stateDir, 'accounts')
  const ids = existsSync(dir)
    ? readdirSync(dir).filter(id => !id.includes('.superseded.') && existsSync(join(dir, id, 'account.json')))
    : []
  if (botIdHint) {
    const match = ids.find(id => id === botIdHint) ?? ids.find(id => id.startsWith(botIdHint))
    if (!match) throw new Error(`no account matching "${botIdHint}" (have: ${ids.join(', ') || 'none'})`)
    return match
  }
  if (ids.length === 0) throw new Error('no bound accounts to export')
  if (ids.length > 1) throw new Error(`multiple accounts (${ids.join(', ')}) — pass --bot-id`)
  return ids[0]!
}

/** Build an encrypted, portable bundle of one account. */
export function exportAccount(stateDir: string, accountId: string, passphrase: string): Buffer {
  if (!passphrase) throw new Error('passphrase required')
  const acctDir = join(stateDir, 'accounts', accountId)
  const files: Record<string, string> = {}
  for (const name of PORTABLE_FILES) {
    const p = join(acctDir, name)
    if (!existsSync(p)) throw new Error(`missing ${name} for account ${accountId}`)
    files[name] = readFileSync(p, 'utf8')
  }
  const plain = Buffer.from(JSON.stringify({ v: 1, botId: accountId, files } satisfies AccountBundle), 'utf8')
  const salt = randomBytes(SALT_LEN)
  const iv = randomBytes(IV_LEN)
  const cipher = createCipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv)
  const ct = Buffer.concat([cipher.update(plain), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([Buffer.from(MAGIC, 'utf8'), salt, iv, tag, ct])
}

/** Decrypt + validate a bundle. Throws on wrong passphrase / tamper / bad shape. */
export function decryptBundle(blob: Buffer, passphrase: string): AccountBundle {
  if (!passphrase) throw new Error('passphrase required')
  if (blob.subarray(0, MAGIC.length).toString('utf8') !== MAGIC) {
    throw new Error('not a wechat-cc account bundle')
  }
  // Must hold at least the fixed header (MAGIC + salt + iv + tag) before any
  // ciphertext. Without this, a truncated bundle hands a wrong-length IV/tag to
  // createDecipheriv/setAuthTag (which run outside the try below) and throws a
  // raw crypto error instead of the contracted "corrupt file" message.
  if (blob.length < MAGIC.length + SALT_LEN + IV_LEN + TAG_LEN) {
    throw new Error('decrypt failed — wrong passphrase or corrupt file')
  }
  let off = MAGIC.length
  const salt = blob.subarray(off, (off += SALT_LEN))
  const iv = blob.subarray(off, (off += IV_LEN))
  const tag = blob.subarray(off, (off += TAG_LEN))
  const ct = blob.subarray(off)
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv)
  decipher.setAuthTag(tag)
  let plain: Buffer
  try {
    plain = Buffer.concat([decipher.update(ct), decipher.final()])
  } catch {
    throw new Error('decrypt failed — wrong passphrase or corrupt file')
  }
  const bundle = JSON.parse(plain.toString('utf8')) as AccountBundle
  if (bundle.v !== 1 || !bundle.botId || !bundle.files || typeof bundle.files !== 'object') {
    throw new Error('invalid bundle contents')
  }
  return bundle
}

/**
 * Write a bundle into `accounts/<botId>/`. Only the sandboxed PORTABLE_FILES
 * are written (token 0o600). Returns the id + whether it overwrote an existing
 * account dir (i.e. you re-imported the same bot).
 */
export function importAccount(stateDir: string, blob: Buffer, passphrase: string): { botId: string; overwritten: boolean } {
  const bundle = decryptBundle(blob, passphrase)
  const acctDir = join(stateDir, 'accounts', bundle.botId)
  const overwritten = existsSync(join(acctDir, 'account.json'))
  mkdirSync(acctDir, { recursive: true, mode: 0o700 })
  for (const name of PORTABLE_FILES) {
    const content = bundle.files[name]
    if (typeof content === 'string') writeFileSync(join(acctDir, name), content, { mode: 0o600 })
  }
  // This bot now lives on >1 machine → mark it so the daemon treats a takeover
  // (errcode=-14) as a graceful standby instead of a dead session.
  markMultiDevice(stateDir, bundle.botId)
  return { botId: bundle.botId, overwritten }
}

export interface TakeoverDeps {
  /** Read server.pid, or null if absent. */
  readPid: (path: string) => string | null
  /** process.kill(pid, signal). */
  kill: (pid: number, signal: string) => void
}

/**
 * Tell THIS machine's running daemon to take over the bot session: send it
 * SIGUSR1, which the daemon handles as a reconcile() — it re-reads accounts and
 * (re)starts polling for any account not currently looping, including one that
 * stood by after a sibling device took the session. No daemon restart needed.
 *
 * (Unix only — SIGUSR1 isn't a thing on Windows, same as the daemon's handler.)
 */
export function requestTakeover(deps: TakeoverDeps, stateDir: string): { pid: number } {
  const raw = deps.readPid(join(stateDir, 'server.pid'))
  if (!raw) throw new Error('daemon 没在本机运行(无 server.pid)— 先启动本机 daemon')
  const pid = parseInt(raw.trim(), 10)
  if (!Number.isFinite(pid) || pid <= 0) throw new Error(`server.pid 内容无效: ${raw.trim()}`)
  deps.kill(pid, 'SIGUSR1')
  return { pid }
}
