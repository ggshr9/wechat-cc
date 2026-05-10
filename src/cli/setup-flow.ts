import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ILINK_APP_ID, ILINK_BASE_URL, ILINK_BOT_TYPE } from '../lib/config'
import { dedupeAccountsByUserId } from '../lib/dedupe-accounts'

const ILINK_CLIENT_VERSION = '131335'
const SETUP_QR_EXPIRES_MS = 480_000

export interface SetupQrPayload {
  qrcode: string
  qrcode_img_content: string
  expires_in_ms: number
}

/**
 * Distinguishes the four flavors of "scan completed" so the wizard can give
 * 小白 users honest feedback instead of always saying "绑定成功" + a fresh
 * accountId (looks like a brand-new binding every time, even on re-scan of
 * the same WeChat account). See docs/specs/2026-05-10-rescan-feedback.md.
 *
 * - first       — no prior account dirs, truly fresh setup
 * - reconnect   — same userId existed but its session was flagged expired
 *                 (errcode=-14): user is fixing a known-broken connection
 * - redundant   — same userId existed and was still alive: user re-scanned
 *                 unnecessarily (likely doesn't realize they're connected)
 * - new_account — different userId existed: user switched WeChat accounts
 */
export type Scenario = 'first' | 'reconnect' | 'redundant' | 'new_account'

export type SetupPollResult =
  | { status: 'wait' | 'scaned' | 'expired' }
  | { status: 'scaned_but_redirect'; baseUrl: string }
  | { status: 'confirmed'; accountId: string; userId: string; scenario: Scenario }

export type FetchText = (baseUrl: string, endpoint: string, timeoutMs?: number) => Promise<string>

export async function requestSetupQrCode(opts: {
  fetchText?: FetchText
  baseUrl?: string
  botType?: string
} = {}): Promise<SetupQrPayload> {
  const baseUrl = opts.baseUrl ?? ILINK_BASE_URL
  const botType = opts.botType ?? ILINK_BOT_TYPE
  const fetchText = opts.fetchText ?? ilinkGet
  const raw = await fetchText(baseUrl, `ilink/bot/get_bot_qrcode?bot_type=${botType}`)
  const qrData = JSON.parse(raw) as { qrcode?: string; qrcode_img_content?: string }
  if (!qrData.qrcode_img_content || !qrData.qrcode) {
    throw new Error('无法获取二维码，请稍后重试。')
  }
  return {
    qrcode: qrData.qrcode,
    qrcode_img_content: qrData.qrcode_img_content,
    expires_in_ms: SETUP_QR_EXPIRES_MS,
  }
}

export async function ilinkGet(baseUrl: string, endpoint: string, timeoutMs = 15_000): Promise<string> {
  const url = new URL(endpoint, baseUrl.endsWith('/') ? baseUrl : baseUrl + '/')
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: { 'iLink-App-Id': ILINK_APP_ID, 'iLink-App-ClientVersion': ILINK_CLIENT_VERSION },
      signal: ctrl.signal,
    })
    if (!res.ok) throw new Error(`${endpoint} ${res.status}: ${await res.text()}`)
    return await res.text()
  } finally { clearTimeout(t) }
}

export async function pollSetupQrStatus(opts: {
  qrcode: string
  baseUrl?: string
  stateDir?: string
  fetchText?: FetchText
  /**
   * Probe whether a previously-bound bot was flagged session-expired. Used
   * only by `determineScenario` to distinguish 'reconnect' from 'redundant'.
   * Defaults to always-false; worst-case mislabels reconnect as redundant
   * (the user-facing copy is still truthful in both cases).
   */
  isExpired?: (botDirName: string) => boolean
}): Promise<SetupPollResult> {
  const baseUrl = opts.baseUrl ?? ILINK_BASE_URL
  const fetchText = opts.fetchText ?? ilinkGet
  let statusRaw: string
  try {
    statusRaw = await fetchText(
      baseUrl,
      `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(opts.qrcode)}`,
    )
  } catch (err) {
    // The WeChat get_qrcode_status endpoint is a long-poll: it holds the
    // request open until either the QR state changes or up to ~25s elapse.
    // Our default 15s ilinkGet timeout fires AbortError in the no-event
    // case — that's not a failure, just "no news, keep polling".
    const name = err instanceof Error ? err.name : ''
    const isAbort = name === 'AbortError' || (err && typeof err === 'object' && 'name' in err && (err as { name?: string }).name === 'AbortError')
    if (isAbort) return { status: 'wait' }
    throw err
  }
  const status = JSON.parse(statusRaw) as {
    status: 'wait' | 'scaned' | 'scaned_but_redirect' | 'expired' | 'confirmed'
    bot_token?: string
    ilink_bot_id?: string
    baseurl?: string
    ilink_user_id?: string
    redirect_host?: string
  }

  if (status.status === 'scaned_but_redirect') {
    return { status: 'scaned_but_redirect', baseUrl: status.redirect_host ? `https://${status.redirect_host}` : baseUrl }
  }
  if (status.status === 'confirmed') {
    const saved = persistConfirmedAccount({
      stateDir: opts.stateDir,
      currentBaseUrl: baseUrl,
      status: { ...status, status: 'confirmed' },
      ...(opts.isExpired ? { isExpired: opts.isExpired } : {}),
    })
    return { status: 'confirmed', accountId: saved.accountId, userId: saved.userId, scenario: saved.scenario }
  }
  return { status: status.status }
}

export interface ConfirmedSetupStatus {
  status: 'confirmed'
  bot_token?: string
  ilink_bot_id?: string
  baseurl?: string
  ilink_user_id?: string
}

export function persistConfirmedAccount(opts: {
  stateDir?: string
  currentBaseUrl: string
  status: ConfirmedSetupStatus
  isExpired?: (botDirName: string) => boolean
}): { accountId: string; userId: string; scenario: Scenario } {
  const stateDir = opts.stateDir ?? join(homedir(), '.claude', 'channels', 'wechat')
  const accountsDir = join(stateDir, 'accounts')
  const accessFile = join(stateDir, 'access.json')
  const status = opts.status
  if (!status.ilink_bot_id || !status.bot_token) {
    throw new Error('登录失败：服务器未返回完整信息。')
  }

  const accountId = status.ilink_bot_id.replace(/[^a-zA-Z0-9_-]/g, '-')
  const accountDir = join(accountsDir, accountId)
  mkdirSync(accountDir, { recursive: true, mode: 0o700 })
  writeFileSync(join(accountDir, 'token'), status.bot_token, { mode: 0o600 })

  const account = {
    baseUrl: status.baseurl ?? opts.currentBaseUrl,
    userId: status.ilink_user_id ?? '',
    botId: status.ilink_bot_id,
  }
  const tmpAccount = join(accountDir, 'account.json.tmp')
  writeFileSync(tmpAccount, JSON.stringify(account, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmpAccount, join(accountDir, 'account.json'))

  if (status.ilink_user_id) {
    let access: { dmPolicy: 'allowlist' | 'disabled'; allowFrom: string[] } = { dmPolicy: 'allowlist', allowFrom: [] }
    try { access = JSON.parse(readFileSync(accessFile, 'utf8')) } catch {}
    if (!access.allowFrom) access.allowFrom = []
    if (!access.allowFrom.includes(status.ilink_user_id)) {
      access.allowFrom.push(status.ilink_user_id)
      const tmpAccess = `${accessFile}.tmp`
      writeFileSync(tmpAccess, JSON.stringify(access, null, 2) + '\n', { mode: 0o600 })
      renameSync(tmpAccess, accessFile)
    }
  }

  // Determine scenario AFTER writing the new dir but BEFORE dedupe runs.
  // determineScenario excludes the just-written dir by name, so the OTHER
  // active accounts are inspected for same-userId / different-userId / etc.
  // Once dedupe archives them they look superseded and the signal is lost.
  const scenario = determineScenario(
    accountsDir,
    status.ilink_user_id ?? '',
    accountId,
    opts.isExpired ? { isExpired: opts.isExpired } : {},
  )

  // v0.5.6: archive any older bot dirs that share this scan's userId.
  // ilink invalidates the previous bot server-side when a user re-scans, so
  // their local account dirs would otherwise pile up and the daemon would
  // poll dead sessions. We force-keep the just-written `accountId` regardless
  // of mtime ordering (filesystem timestamps may not have advanced enough on
  // fast SSDs to make the new dir provably newest).
  if (status.ilink_user_id) {
    dedupeAccountsByUserId(
      accountsDir,
      { keepUserId: status.ilink_user_id, keepBotId: status.ilink_bot_id },
    )
  }

  return { accountId, userId: status.ilink_user_id ?? '', scenario }
}

export interface ScenarioDeps {
  isExpired?: (botDirName: string) => boolean
}

/**
 * Classify a fresh scan against the existing `accounts/` directory state.
 * Excludes `scanBotDirName` (the just-written dir for THIS scan) so the
 * caller can invoke this AFTER persisting the new dir but BEFORE dedupe.
 *
 * Returns:
 *   - 'first'        — no other active dirs exist (or all are malformed)
 *   - 'new_account'  — other active dirs exist, none with this userId
 *   - 'reconnect'    — other active dir matches userId AND its session is expired
 *   - 'redundant'    — other active dir matches userId AND is still alive
 *
 * `isExpired` defaults to always-false, in which case 'reconnect' collapses
 * into 'redundant' (the user-facing copy stays truthful in either case).
 */
export function determineScenario(
  accountsDir: string,
  scanUserId: string,
  scanBotDirName: string,
  deps: ScenarioDeps = {},
): Scenario {
  if (!existsSync(accountsDir)) return 'first'
  const isExpired = deps.isExpired ?? (() => false)

  const others: { id: string; userId: string }[] = []
  for (const name of readdirSync(accountsDir)) {
    if (name.includes('.superseded.')) continue
    if (name === scanBotDirName) continue
    const metaPath = join(accountsDir, name, 'account.json')
    if (!existsSync(metaPath)) continue
    try {
      const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as { userId?: string }
      if (typeof meta.userId === 'string' && meta.userId) {
        others.push({ id: name, userId: meta.userId })
      }
    } catch { /* skip malformed account.json — same posture as dedupe-accounts */ }
  }

  if (others.length === 0) return 'first'

  const sameUser = others.find(a => a.userId === scanUserId)
  if (!sameUser) return 'new_account'

  return isExpired(sameUser.id) ? 'reconnect' : 'redundant'
}
