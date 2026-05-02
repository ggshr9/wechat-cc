import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ILINK_APP_ID, ILINK_BASE_URL, ILINK_BOT_TYPE } from '../lib/config'

const ILINK_CLIENT_VERSION = '131335'
const SETUP_QR_EXPIRES_MS = 480_000

export interface SetupQrPayload {
  qrcode: string
  qrcode_img_content: string
  expires_in_ms: number
}

export type SetupPollResult =
  | { status: 'wait' | 'scaned' | 'expired' }
  | { status: 'scaned_but_redirect'; baseUrl: string }
  | { status: 'confirmed'; accountId: string; userId: string }

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
    })
    return { status: 'confirmed', accountId: saved.accountId, userId: saved.userId }
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
}): { accountId: string; userId: string } {
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

  return { accountId, userId: status.ilink_user_id ?? '' }
}
