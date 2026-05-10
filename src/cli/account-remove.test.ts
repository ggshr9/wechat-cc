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

  // ── SQLite session_state cleanup (post-PR7 store) ─────────────────────
  // PR7 migrated session_state from session-state.json to SQLite. The
  // legacy file gets renamed to .migrated and never repopulated, so for
  // any post-migration user the only live store is SQLite. Without the
  // clearSessionStateBot dep, account-remove silently leaks rows.

  it('post-PR7 leak demo: without clearSessionStateBot dep, no SQLite cleanup happens', () => {
    // Simulate a real post-PR7 install: legacy file is gone (.migrated),
    // so dropSessionStateBot is a no-op. SQLite cleanup needs the dep.
    rmSync(join(stateDir, 'session-state.json'))
    const result = removeAccount({ stateDir }, BOT)
    expect(result.removed.some(r => r.startsWith('session_state.sqlite'))).toBe(false)
    expect(result.removed.some(r => r.includes('session-state.json'))).toBe(false)
    // ↑ This is the leak: nothing in `removed` references session_state at
    //   all, even though for a real user the SQLite row may still be there.
  })

  it('clears SQLite session_state row when clearSessionStateBot dep is wired', () => {
    const cleared: string[] = []
    const result = removeAccount({
      stateDir,
      clearSessionStateBot: (botId) => {
        cleared.push(botId)
        return true  // simulate row was present and got cleared
      },
    }, BOT)
    expect(cleared).toEqual([BOT])
    expect(result.removed).toContain(`session_state.sqlite[${BOT}]`)
  })

  it('omits SQLite removed entry when row was not present (clearSessionStateBot returns false)', () => {
    const result = removeAccount({
      stateDir,
      clearSessionStateBot: () => false,  // nothing to clear
    }, BOT)
    expect(result.removed.some(r => r.startsWith('session_state.sqlite'))).toBe(false)
  })

  it('SQLite cleanup runs even when account dir is already gone (admin re-running cleanup)', () => {
    rmSync(join(stateDir, 'accounts', BOT), { recursive: true })
    const result = removeAccount({
      stateDir,
      clearSessionStateBot: () => true,
    }, BOT)
    expect(result.warnings.some(w => w.includes('account dir not found'))).toBe(true)
    // Even with a missing account dir, the SQLite row still gets cleared —
    // important for admin recovery from half-cleaned state.
    expect(result.removed).toContain(`session_state.sqlite[${BOT}]`)
  })
})
