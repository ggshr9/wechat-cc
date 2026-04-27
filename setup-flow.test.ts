import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pollSetupQrStatus, requestSetupQrCode } from './setup-flow'

describe('setup-flow', () => {
  it('returns QR payload for desktop installers without printing terminal UI', async () => {
    const fetchText = vi.fn().mockResolvedValue(JSON.stringify({
      qrcode: 'qr-token',
      qrcode_img_content: 'weixin://qr-code',
    }))

    const qr = await requestSetupQrCode({ fetchText })

    expect(fetchText).toHaveBeenCalledWith(
      'https://ilinkai.weixin.qq.com',
      'ilink/bot/get_bot_qrcode?bot_type=3',
    )
    expect(qr).toEqual({
      qrcode: 'qr-token',
      qrcode_img_content: 'weixin://qr-code',
      expires_in_ms: 480_000,
    })
  })

  it('throws a human-readable error when ilink response lacks QR fields', async () => {
    await expect(requestSetupQrCode({
      fetchText: async () => JSON.stringify({}),
    })).rejects.toThrow(/无法获取二维码/)
  })

  it('pollSetupQrStatus returns wait without writing account state', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'setup-poll-'))
    try {
      const result = await pollSetupQrStatus({
        stateDir,
        qrcode: 'qr-token',
        fetchText: async () => JSON.stringify({ status: 'wait' }),
      })

      expect(result).toEqual({ status: 'wait' })
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('pollSetupQrStatus translates AbortError into wait (long-poll timeout = no news)', async () => {
    const result = await pollSetupQrStatus({
      qrcode: 'qr-token',
      fetchText: async () => {
        const err = new Error('aborted')
        err.name = 'AbortError'
        throw err
      },
    })
    expect(result).toEqual({ status: 'wait' })
  })

  it('pollSetupQrStatus still propagates non-Abort errors', async () => {
    await expect(pollSetupQrStatus({
      qrcode: 'qr-token',
      fetchText: async () => { throw new Error('500 internal') },
    })).rejects.toThrow(/500 internal/)
  })

  it('pollSetupQrStatus persists account and allowlist when confirmed', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'setup-poll-'))
    try {
      const result = await pollSetupQrStatus({
        stateDir,
        qrcode: 'qr-token',
        fetchText: async () => JSON.stringify({
          status: 'confirmed',
          bot_token: 'secret-token',
          ilink_bot_id: 'bot:1/im-bot',
          ilink_user_id: 'user-1',
          baseurl: 'https://redirected',
        }),
      })

      expect(result).toEqual({
        status: 'confirmed',
        accountId: 'bot-1-im-bot',
        userId: 'user-1',
      })
      expect(readFileSync(join(stateDir, 'accounts', 'bot-1-im-bot', 'token'), 'utf8')).toBe('secret-token')
      const access = JSON.parse(readFileSync(join(stateDir, 'access.json'), 'utf8')) as { allowFrom: string[] }
      expect(access.allowFrom).toContain('user-1')
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('pollSetupQrStatus returns redirected base URL without persisting', async () => {
    const result = await pollSetupQrStatus({
      qrcode: 'qr-token',
      fetchText: async () => JSON.stringify({ status: 'scaned_but_redirect', redirect_host: 'next.example' }),
    })

    expect(result).toEqual({ status: 'scaned_but_redirect', baseUrl: 'https://next.example' })
  })
})
