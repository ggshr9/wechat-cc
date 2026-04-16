#!/usr/bin/env bun
/**
 * WeChat channel setup — run this separately to do QR login.
 * Saves credentials to ~/.claude/channels/wechat/
 *
 * Usage: bun setup.ts
 */

import { randomBytes } from 'crypto'
import { readFileSync, writeFileSync, mkdirSync, renameSync, chmodSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { ILINK_BASE_URL, ILINK_APP_ID, ILINK_BOT_TYPE, LONG_POLL_TIMEOUT_MS } from './config.ts'

const STATE_DIR = join(homedir(), '.claude', 'channels', 'wechat')
const ACCOUNTS_DIR = join(STATE_DIR, 'accounts')
const ACCESS_FILE = join(STATE_DIR, 'access.json')

// Per-file constants (see config.ts note on why these differ from server.ts)
const ILINK_CLIENT_VERSION = '65547'
const API_TIMEOUT_MS = 15_000

async function ilinkGet(baseUrl: string, endpoint: string, timeoutMs = API_TIMEOUT_MS): Promise<string> {
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

interface Account {
  baseUrl: string
  userId: string
  botId: string
}

interface Access {
  dmPolicy: 'allowlist' | 'disabled'
  allowFrom: string[]
}

// ── Main ───────────────────────────────────────────────────────────────────

console.log('WeChat Channel Setup — 微信扫码登录\n')

// Step 1: Get QR code
console.log('正在获取二维码...')
const raw = await ilinkGet(ILINK_BASE_URL, `ilink/bot/get_bot_qrcode?bot_type=${ILINK_BOT_TYPE}`)
const qrData = JSON.parse(raw) as { qrcode?: string; qrcode_img_content?: string }

if (!qrData.qrcode_img_content || !qrData.qrcode) {
  console.error('无法获取二维码，请稍后重试。')
  process.exit(1)
}

// Step 2: Display QR
console.log('\n请用微信扫描以下二维码：\n')
try {
  const qrt = await import('qrcode-terminal')
  qrt.default.generate(qrData.qrcode_img_content, { small: true }, (qr: string) => {
    console.log(qr)
  })
} catch {
  console.log(`二维码链接：${qrData.qrcode_img_content}`)
}
console.log('等待扫码...\n')

// Step 3: Poll for login
const deadline = Date.now() + 480_000
let currentBaseUrl = ILINK_BASE_URL
let scannedPrinted = false

while (Date.now() < deadline) {
  try {
    const statusRaw = await ilinkGet(
      currentBaseUrl,
      `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrData.qrcode)}`,
      LONG_POLL_TIMEOUT_MS,
    )
    const status = JSON.parse(statusRaw) as {
      status: string
      bot_token?: string
      ilink_bot_id?: string
      baseurl?: string
      ilink_user_id?: string
      redirect_host?: string
    }

    switch (status.status) {
      case 'wait':
        break
      case 'scaned':
        if (!scannedPrinted) {
          console.log('👀 已扫码，在微信继续操作...')
          scannedPrinted = true
        }
        break
      case 'scaned_but_redirect':
        if (status.redirect_host) {
          currentBaseUrl = `https://${status.redirect_host}`
        }
        break
      case 'expired':
        console.error('二维码已过期，请重新运行 setup。')
        process.exit(1)
      case 'confirmed': {
        if (!status.ilink_bot_id || !status.bot_token) {
          console.error('登录失败：服务器未返回完整信息。')
          process.exit(1)
        }

        console.log('\n✅ 与微信连接成功！\n')

        // Save to accounts/<id>/ directory
        const accountId = status.ilink_bot_id.replace(/[^a-zA-Z0-9_-]/g, '-')
        const accountDir = join(ACCOUNTS_DIR, accountId)
        mkdirSync(accountDir, { recursive: true, mode: 0o700 })

        writeFileSync(join(accountDir, 'token'), status.bot_token, { mode: 0o600 })
        console.log(`Token 已保存到 ${join(accountDir, 'token')}`)

        const account: Account = {
          baseUrl: status.baseurl ?? currentBaseUrl,
          userId: status.ilink_user_id ?? '',
          botId: status.ilink_bot_id,
        }
        const tmpAccount = join(accountDir, 'account.json.tmp')
        writeFileSync(tmpAccount, JSON.stringify(account, null, 2) + '\n', { mode: 0o600 })
        renameSync(tmpAccount, join(accountDir, 'account.json'))
        console.log(`账号信息已保存到 ${join(accountDir, 'account.json')}`)

        // Auto-add to allowlist
        if (status.ilink_user_id) {
          let access: Access = { dmPolicy: 'allowlist', allowFrom: [] }
          try {
            access = JSON.parse(readFileSync(ACCESS_FILE, 'utf8'))
          } catch {}
          if (!access.allowFrom) access.allowFrom = []
          if (!access.allowFrom.includes(status.ilink_user_id)) {
            access.allowFrom.push(status.ilink_user_id)
            const tmpAccess = ACCESS_FILE + '.tmp'
            writeFileSync(tmpAccess, JSON.stringify(access, null, 2) + '\n', { mode: 0o600 })
            renameSync(tmpAccess, ACCESS_FILE)
            console.log(`已将 ${status.ilink_user_id} 加入 allowlist`)
          }
        }

        console.log('\n下一步：')
        console.log('  claude --dangerously-load-development-channels server:wechat')
        console.log('\n（需要在项目目录有 .mcp.json 指向 wechat server）')
        process.exit(0)
      }
    }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') continue
    console.error(`Error: ${err}`)
    process.exit(1)
  }

  await new Promise(r => setTimeout(r, 1000))
}

console.error('登录超时，请重试。')
process.exit(1)
