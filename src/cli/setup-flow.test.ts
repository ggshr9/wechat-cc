import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { determineScenario, pollSetupQrStatus, requestSetupQrCode } from './setup-flow'

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
        scenario: 'first',
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

// Filesystem helper: write a synthetic accounts/<botDir>/account.json so
// determineScenario sees it as an existing active account.
function seedAccount(accountsDir: string, botDirName: string, userId: string): void {
  const acctDir = join(accountsDir, botDirName)
  mkdirSync(acctDir, { recursive: true })
  writeFileSync(join(acctDir, 'account.json'), JSON.stringify({
    botId: botDirName,
    userId,
    baseUrl: 'https://ilink.example',
  }))
}

describe('determineScenario', () => {
  it('first: empty accounts dir → first', () => {
    const accountsDir = mkdtempSync(join(tmpdir(), 'scenario-first-'))
    try {
      const s = determineScenario(accountsDir, 'user-1', 'bot-new')
      expect(s).toBe('first')
    } finally {
      rmSync(accountsDir, { recursive: true, force: true })
    }
  })

  it('first: accounts dir exists but only contains the just-written scan dir → first', () => {
    const accountsDir = mkdtempSync(join(tmpdir(), 'scenario-first-only-self-'))
    try {
      seedAccount(accountsDir, 'bot-new', 'user-1')
      const s = determineScenario(accountsDir, 'user-1', 'bot-new')
      expect(s).toBe('first')
    } finally {
      rmSync(accountsDir, { recursive: true, force: true })
    }
  })

  it('reconnect: same userId exists, isExpired returns true → reconnect', () => {
    const accountsDir = mkdtempSync(join(tmpdir(), 'scenario-reconnect-'))
    try {
      seedAccount(accountsDir, 'bot-old', 'user-1')
      seedAccount(accountsDir, 'bot-new', 'user-1')  // pretend this one was just written
      const s = determineScenario(accountsDir, 'user-1', 'bot-new', {
        isExpired: (id) => id === 'bot-old',
      })
      expect(s).toBe('reconnect')
    } finally {
      rmSync(accountsDir, { recursive: true, force: true })
    }
  })

  it('redundant: same userId exists, isExpired returns false → redundant', () => {
    const accountsDir = mkdtempSync(join(tmpdir(), 'scenario-redundant-'))
    try {
      seedAccount(accountsDir, 'bot-old', 'user-1')
      seedAccount(accountsDir, 'bot-new', 'user-1')
      const s = determineScenario(accountsDir, 'user-1', 'bot-new', {
        isExpired: () => false,
      })
      expect(s).toBe('redundant')
    } finally {
      rmSync(accountsDir, { recursive: true, force: true })
    }
  })

  it('new_account: only different userId active → new_account', () => {
    const accountsDir = mkdtempSync(join(tmpdir(), 'scenario-new-'))
    try {
      seedAccount(accountsDir, 'bot-old', 'user-old')
      seedAccount(accountsDir, 'bot-new', 'user-new')
      const s = determineScenario(accountsDir, 'user-new', 'bot-new')
      expect(s).toBe('new_account')
    } finally {
      rmSync(accountsDir, { recursive: true, force: true })
    }
  })

  it('superseded dirs are ignored regardless of userId match', () => {
    const accountsDir = mkdtempSync(join(tmpdir(), 'scenario-superseded-'))
    try {
      seedAccount(accountsDir, 'bot-old.superseded.2026-05-01T00-00-00-000Z', 'user-1')
      seedAccount(accountsDir, 'bot-new', 'user-1')
      // Even though same userId exists in the superseded dir, the active
      // landscape is empty (post-self exclusion), so this should be 'first'.
      const s = determineScenario(accountsDir, 'user-1', 'bot-new')
      expect(s).toBe('first')
    } finally {
      rmSync(accountsDir, { recursive: true, force: true })
    }
  })

  it('isExpired defaults to always-false (reconnect collapses into redundant)', () => {
    const accountsDir = mkdtempSync(join(tmpdir(), 'scenario-default-isexpired-'))
    try {
      seedAccount(accountsDir, 'bot-old', 'user-1')
      seedAccount(accountsDir, 'bot-new', 'user-1')
      const s = determineScenario(accountsDir, 'user-1', 'bot-new')  // no deps
      expect(s).toBe('redundant')
    } finally {
      rmSync(accountsDir, { recursive: true, force: true })
    }
  })
})
