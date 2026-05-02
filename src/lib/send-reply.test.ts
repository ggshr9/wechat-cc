import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { chunk, sendReplyOnce } from './send-reply'

describe('chunk', () => {
  it('returns original text if under limit', () => {
    expect(chunk('hello', 100)).toEqual(['hello'])
    expect(chunk('', 100)).toEqual([''])
  })

  it('splits on paragraph boundary when possible', () => {
    const text = 'first paragraph line\n\nsecond paragraph line'
    const parts = chunk(text, 25)
    expect(parts.length).toBeGreaterThanOrEqual(2)
    expect(parts[0]).toBe('first paragraph line')
  })

  it('splits on line boundary when no paragraph in window', () => {
    const text = 'line one here\nline two here\nline three here'
    const parts = chunk(text, 15)
    // 'line one here' is 13 chars, next newline pushes us over — cut at first newline
    expect(parts[0]).toBe('line one here')
  })

  it('falls back to space boundary', () => {
    const text = 'one two three four five six seven'
    const parts = chunk(text, 10)
    // Cut at space before limit
    expect(parts[0]!.length).toBeLessThanOrEqual(10)
    expect(parts.every(p => p.length > 0)).toBe(true)
  })

  it('hard-cuts when no good boundary', () => {
    const text = 'aaaaaaaaaaaaaaaaaaaa' // 20 'a's, no whitespace
    const parts = chunk(text, 5)
    expect(parts.length).toBe(4)
    expect(parts.every(p => p.length === 5)).toBe(true)
  })

  it('strips leading newlines from next chunk', () => {
    const text = 'paragraph one\n\nparagraph two'
    const parts = chunk(text, 15)
    // After the split, 'paragraph two' should not start with \n
    expect(parts[1]!.startsWith('\n')).toBe(false)
  })

  it('preserves non-ASCII (Chinese) text intact', () => {
    const text = '你好世界这是一个测试的消息内容'
    const parts = chunk(text, 6)
    expect(parts.join('')).toBe(text.replace(/\n/g, ''))
  })
})

describe('sendReplyOnce — preflight checks (no network)', () => {
  let tmpDir: string

  beforeAll(() => { tmpDir = mkdtempSync(join(tmpdir(), 'wechat-cc-send-reply-')) })
  afterAll(() => { rmSync(tmpDir, { recursive: true, force: true }) })
  beforeEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
    mkdirSync(tmpDir, { recursive: true })
  })

  it('rejects empty text', async () => {
    const r = await sendReplyOnce('u@chat', '', tmpDir)
    expect(r).toEqual({ ok: false, error: 'empty text' })
  })

  it('rejects when no accounts directory exists', async () => {
    const r = await sendReplyOnce('u@chat', 'hi', tmpDir)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/no accounts configured/)
  })

  function seedOneAccount(stateDir: string): void {
    const acctDir = join(stateDir, 'accounts', 'bot-1')
    mkdirSync(acctDir, { recursive: true })
    writeFileSync(join(acctDir, 'token'), 'fake-token')
    writeFileSync(join(acctDir, 'account.json'), JSON.stringify({ baseUrl: 'https://example.invalid' }))
  }

  it('rejects unknown chat_id (no contextToken AND no account routing)', async () => {
    seedOneAccount(tmpDir)
    const r = await sendReplyOnce('stranger@chat', 'hi', tmpDir)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toMatch(/unknown chat_id stranger@chat/)
      expect(r.error).toMatch(/send a WeChat message to the bot first/)
    }
  })

  it('passes preflight when only userAccountIds is on record (recovers without contextToken)', async () => {
    seedOneAccount(tmpDir)
    writeFileSync(join(tmpDir, 'user_account_ids.json'), JSON.stringify({ 'known@chat': 'bot-1' }))
    // Will fail at the network call but NOT at preflight — error is fetch-related, not preflight.
    const r = await sendReplyOnce('known@chat', 'hi', tmpDir)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).not.toMatch(/unknown chat_id/)
  })
})
