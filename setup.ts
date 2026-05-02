#!/usr/bin/env bun
/**
 * WeChat channel setup — run this separately to do QR login.
 * Saves credentials to ~/.claude/channels/wechat/
 */

import { readFileSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import { ILINK_BASE_URL, LONG_POLL_TIMEOUT_MS } from './src/lib/config'
import { ilinkGet, persistConfirmedAccount, requestSetupQrCode } from './src/cli/setup-flow'

const STATE_DIR = join(homedir(), '.claude', 'channels', 'wechat')

console.log('WeChat Channel Setup — 微信扫码登录\n')
console.log('正在获取二维码...')
const qrData = await requestSetupQrCode()

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

const deadline = Date.now() + qrData.expires_in_ms
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
          console.log('已扫码，在微信继续操作...')
          scannedPrinted = true
        }
        break
      case 'scaned_but_redirect':
        if (status.redirect_host) currentBaseUrl = `https://${status.redirect_host}`
        break
      case 'expired':
        console.error('二维码已过期，请重新运行 setup。')
        process.exit(1)
      case 'confirmed': {
        const saved = persistConfirmedAccount({
          stateDir: STATE_DIR,
          currentBaseUrl,
          status: { ...status, status: 'confirmed' },
        })

        console.log('\n与微信连接成功！\n')
        console.log(`账号已保存: ${saved.accountId}`)
        if (saved.userId) console.log(`已将 ${saved.userId} 加入 allowlist`)

        try {
          const pidPath = join(STATE_DIR, 'server.pid')
          const pid = parseInt(readFileSync(pidPath, 'utf8').trim(), 10)
          if (pid > 0) {
            // SIGUSR1 isn't deliverable on Windows — process.kill silently
            // throws EINVAL there. Tell the user to restart the service so
            // the new account actually gets picked up; on POSIX we hot-
            // reload via signal as before.
            if (platform() === 'win32') {
              console.log(`检测到运行中的 daemon (pid ${pid})。请重启服务以加载新账号:`)
              console.log('  schtasks /End /TN wechat-cc && schtasks /Run /TN wechat-cc')
            } else {
              process.kill(pid, 'SIGUSR1')
              console.log(`已通知运行中的 daemon (pid ${pid}) 热加载新账号`)
            }
          }
        } catch {}

        console.log('')
        console.log('下一步:')
        console.log('  wechat-cc run')
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
