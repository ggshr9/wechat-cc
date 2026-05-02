import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { defaultTerminalChatId } from './send-reply'

let tmpDir: string
let userAccountIdsFile: string
let contextTokensFile: string

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'wechat-cc-test-'))
  userAccountIdsFile = join(tmpDir, 'user_account_ids.json')
  contextTokensFile = join(tmpDir, 'context_tokens.json')
})

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

beforeEach(() => {
  for (const f of [userAccountIdsFile, contextTokensFile]) {
    if (existsSync(f)) rmSync(f)
  }
})

describe('defaultTerminalChatId', () => {
  it('returns null when no state files exist', () => {
    expect(defaultTerminalChatId(tmpDir)).toBe(null)
  })

  it('returns the LAST key of userAccountIds (= most-recently-active)', () => {
    // JSON key order = recency order because server.ts does delete-then-set
    // on each inbound. Last key = most recent.
    writeFileSync(userAccountIdsFile, JSON.stringify({
      'oldest@chat': 'acct1',
      'middle@chat': 'acct1',
      'newest@chat': 'acct2',
    }))
    expect(defaultTerminalChatId(tmpDir)).toBe('newest@chat')
  })

  it('falls back to context_tokens when userAccountIds is missing', () => {
    writeFileSync(contextTokensFile, JSON.stringify({
      'older@chat': 'tok1',
      'newer@chat': 'tok2',
    }))
    expect(defaultTerminalChatId(tmpDir)).toBe('newer@chat')
  })

  it('prefers userAccountIds over context_tokens when both exist', () => {
    writeFileSync(userAccountIdsFile, JSON.stringify({ 'from-accounts@chat': 'acct1' }))
    writeFileSync(contextTokensFile, JSON.stringify({ 'from-context@chat': 'tok1' }))
    expect(defaultTerminalChatId(tmpDir)).toBe('from-accounts@chat')
  })

  it('ignores userAccountIds when it parses to empty object', () => {
    writeFileSync(userAccountIdsFile, '{}')
    writeFileSync(contextTokensFile, JSON.stringify({ 'only-in-context@chat': 'tok1' }))
    expect(defaultTerminalChatId(tmpDir)).toBe('only-in-context@chat')
  })

  it('handles corrupted JSON by falling through', () => {
    writeFileSync(userAccountIdsFile, 'not valid json {')
    writeFileSync(contextTokensFile, JSON.stringify({ 'fallback@chat': 'tok1' }))
    expect(defaultTerminalChatId(tmpDir)).toBe('fallback@chat')
  })
})
