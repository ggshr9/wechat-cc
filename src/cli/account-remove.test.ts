import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeAccount } from './account-remove'

let stateDir: string

const BOT = 'abcdef123456-im-bot'
const USER = 'o9cq80abcdef@im.wechat'

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'wechat-cc-rm-'))
  mkdirSync(join(stateDir, 'accounts', BOT), { recursive: true })
  writeFileSync(
    join(stateDir, 'accounts', BOT, 'account.json'),
    JSON.stringify({ baseUrl: 'https://x', userId: USER, botId: 'abcdef123456@im.bot' }),
  )
  writeFileSync(join(stateDir, 'accounts', BOT, 'token'), 'secret-token')
  writeFileSync(join(stateDir, 'context_tokens.json'), JSON.stringify({ [USER]: 'CTX' }))
  writeFileSync(join(stateDir, 'user_account_ids.json'), JSON.stringify({ [USER]: BOT }))
  writeFileSync(join(stateDir, 'session-state.json'), JSON.stringify({
    version: 1,
    bots: { [BOT]: { status: 'expired', first_seen_expired_at: '2026-04-26T00:00:00Z' } },
  }))
  writeFileSync(join(stateDir, 'user_names.json'), JSON.stringify({ [USER]: '丸子' }))
})

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true })
})

describe('removeAccount', () => {
  it('removes the account directory + all per-bot/user references', () => {
    const result = removeAccount({ stateDir }, BOT)
    expect(existsSync(join(stateDir, 'accounts', BOT))).toBe(false)
    expect(JSON.parse(readFileSync(join(stateDir, 'context_tokens.json'), 'utf8'))).toEqual({})
    expect(JSON.parse(readFileSync(join(stateDir, 'user_account_ids.json'), 'utf8'))).toEqual({})
    expect(JSON.parse(readFileSync(join(stateDir, 'session-state.json'), 'utf8')).bots).toEqual({})
    expect(result.removed).toEqual([
      `accounts/${BOT}/`,
      `context_tokens.json[${USER}]`,
      `user_account_ids.json[${USER}]`,
      `session-state.json.bots[${BOT}]`,
    ])
    expect(result.warnings).toEqual([])
  })

  it('preserves user_names.json (kept for re-binding the same wechat user)', () => {
    removeAccount({ stateDir }, BOT)
    expect(JSON.parse(readFileSync(join(stateDir, 'user_names.json'), 'utf8'))).toEqual({ [USER]: '丸子' })
  })

  it('rejects bot ids that do not match the safe shape', () => {
    expect(() => removeAccount({ stateDir }, '../../../etc/passwd')).toThrow(/invalid bot id/)
    expect(() => removeAccount({ stateDir }, 'plain-string')).toThrow(/invalid bot id/)
  })

  it('returns warnings instead of throwing when account dir is already gone', () => {
    rmSync(join(stateDir, 'accounts', BOT), { recursive: true })
    const result = removeAccount({ stateDir }, BOT)
    expect(result.warnings.some(w => w.includes('account dir not found'))).toBe(true)
    // session-state still got cleaned even though dir was gone
    expect(result.removed).toContain(`session-state.json.bots[${BOT}]`)
  })

  it('skips key files cleanly when they do not exist (fresh-ish install)', () => {
    rmSync(join(stateDir, 'context_tokens.json'))
    rmSync(join(stateDir, 'user_account_ids.json'))
    const result = removeAccount({ stateDir }, BOT)
    expect(result.warnings).toEqual([])
    expect(result.removed).toEqual([
      `accounts/${BOT}/`,
      `session-state.json.bots[${BOT}]`,
    ])
  })
})
