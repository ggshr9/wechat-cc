import { describe, it, expect, vi } from 'vitest'
import { makeIlinkAdapter, loadAllAccounts, type Account } from './ilink-glue'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openTestDb } from '../lib/db'

describe('loadAllAccounts', () => {
  it('returns empty array when accounts/ dir does not exist', async () => {
    const state = mkdtempSync(join(tmpdir(), 'wcc-state-'))
    const accts = await loadAllAccounts(state)
    expect(accts).toEqual([])
  })

  it('reads each subdir under accounts/ as an account', async () => {
    const state = mkdtempSync(join(tmpdir(), 'wcc-state-'))
    const acct = join(state, 'accounts', 'A1')
    mkdirSync(acct, { recursive: true })
    writeFileSync(join(acct, 'account.json'), JSON.stringify({ botId: 'b', userId: 'u', baseUrl: 'https://x' }))
    writeFileSync(join(acct, 'token'), 'TOKEN\n')
    const accts = await loadAllAccounts(state)
    expect(accts).toHaveLength(1)
    expect(accts[0]!.id).toBe('A1')
    expect(accts[0]!.botId).toBe('b')
    expect(accts[0]!.userId).toBe('u')
    expect(accts[0]!.baseUrl).toBe('https://x')
    expect(accts[0]!.token).toBe('TOKEN')
    expect(accts[0]!.syncBuf).toBe('')
  })

  it('reads sync_buf when present', async () => {
    const state = mkdtempSync(join(tmpdir(), 'wcc-state-'))
    const acct = join(state, 'accounts', 'A2')
    mkdirSync(acct, { recursive: true })
    writeFileSync(join(acct, 'account.json'), JSON.stringify({ botId: 'b', userId: 'u', baseUrl: 'https://x' }))
    writeFileSync(join(acct, 'token'), 'T')
    writeFileSync(join(acct, 'sync_buf'), 'opaque-sync-buf-contents')
    const accts = await loadAllAccounts(state)
    expect(accts[0]!.syncBuf).toBe('opaque-sync-buf-contents')
  })

  it('skips subdirs missing account.json or token', async () => {
    const state = mkdtempSync(join(tmpdir(), 'wcc-state-'))
    const complete = join(state, 'accounts', 'good')
    const partial = join(state, 'accounts', 'bad')
    mkdirSync(complete, { recursive: true })
    mkdirSync(partial, { recursive: true })
    writeFileSync(join(complete, 'account.json'), JSON.stringify({ botId: 'b', userId: 'u', baseUrl: 'https://x' }))
    writeFileSync(join(complete, 'token'), 'T')
    // partial has no files
    const accts = await loadAllAccounts(state)
    expect(accts.map(a => a.id)).toEqual(['good'])
  })
})

describe('makeIlinkAdapter (composed)', () => {
  function newStateDir(): string {
    return mkdtempSync(join(tmpdir(), 'wcc-adapter-'))
  }
  const acct: Account = { id: 'A1', botId: 'b', userId: 'ubot', baseUrl: 'https://x', token: 'T', syncBuf: '' }

  it('exposes all IlinkAdapter methods', () => {
    const a = makeIlinkAdapter({ stateDir: newStateDir(), accounts: [acct], db: openTestDb() })
    expect(typeof a.sendMessage).toBe('function')
    expect(typeof a.sendFile).toBe('function')
    expect(typeof a.editMessage).toBe('function')
    expect(typeof a.broadcast).toBe('function')
    expect(typeof a.sharePage).toBe('function')
    expect(typeof a.resurfacePage).toBe('function')
    expect(typeof a.setUserName).toBe('function')
    expect(typeof a.askUser).toBe('function')
    expect(typeof a.loadProjects).toBe('function')
    expect(typeof a.lastActiveChatId).toBe('function')
    expect(typeof a.flush).toBe('function')
    expect(typeof a.handlePermissionReply).toBe('function')
    expect(typeof a.markChatActive).toBe('function')
    expect(typeof a.captureContextToken).toBe('function')
    expect(typeof a.resolveUserName).toBe('function')
    expect(a.projects).toBeDefined()
  })

  it('setUserName persists to user_names.json', async () => {
    const stateDir = newStateDir()
    const a = makeIlinkAdapter({ stateDir, accounts: [acct], db: openTestDb() })
    await a.setUserName('chat-1', '小白')
    await a.flush()
    // second instance reads the persisted file
    const { readFileSync } = await import('node:fs')
    const names = JSON.parse(readFileSync(join(stateDir, 'user_names.json'), 'utf8'))
    expect(names['chat-1']).toBe('小白')
  })

  it('resolveUserName returns name after setUserName', async () => {
    const a = makeIlinkAdapter({ stateDir: newStateDir(), accounts: [acct], db: openTestDb() })
    await a.setUserName('chat-2', '测试用户')
    expect(a.resolveUserName('chat-2')).toBe('测试用户')
    expect(a.resolveUserName('chat-unknown')).toBeUndefined()
  })

  it('lastActiveChatId returns null when no activity recorded', () => {
    const a = makeIlinkAdapter({ stateDir: newStateDir(), accounts: [acct], db: openTestDb() })
    expect(a.lastActiveChatId()).toBeNull()
  })

  it('markChatActive updates lastActiveChatId', () => {
    const a = makeIlinkAdapter({ stateDir: newStateDir(), accounts: [acct], db: openTestDb() })
    expect(a.lastActiveChatId()).toBeNull()
    a.markChatActive('chat-99')
    expect(a.lastActiveChatId()).toBe('chat-99')
    a.markChatActive('chat-100')
    expect(a.lastActiveChatId()).toBe('chat-100')
  })

  it('captureContextToken persists per-chat ilink context_token', async () => {
    const stateDir = newStateDir()
    const a = makeIlinkAdapter({ stateDir, accounts: [acct], db: openTestDb() })
    a.captureContextToken('chat-7', 'tok-xyz')
    await a.flush()
    const { readFileSync } = await import('node:fs')
    const tokens = JSON.parse(readFileSync(join(stateDir, 'context_tokens.json'), 'utf8'))
    expect(tokens['chat-7']).toBe('tok-xyz')
  })

  it('captureContextToken is a no-op when token is empty/undefined', async () => {
    const stateDir = newStateDir()
    const a = makeIlinkAdapter({ stateDir, accounts: [acct], db: openTestDb() })
    a.captureContextToken('chat-8', undefined)
    a.captureContextToken('chat-8', '')
    await a.flush()
    const { existsSync, readFileSync } = await import('node:fs')
    const path = join(stateDir, 'context_tokens.json')
    if (existsSync(path)) {
      const tokens = JSON.parse(readFileSync(path, 'utf8'))
      expect(tokens['chat-8']).toBeUndefined()
    }
  })

  it('loadProjects returns {projects: {}, current: null} when projects.json missing', () => {
    const a = makeIlinkAdapter({ stateDir: newStateDir(), accounts: [acct], db: openTestDb() })
    const snap = a.loadProjects()
    expect(snap.projects).toEqual({})
    expect(snap.current).toBeNull()
  })

  it('handlePermissionReply returns false for non-permission text', () => {
    const a = makeIlinkAdapter({ stateDir: newStateDir(), accounts: [acct], db: openTestDb() })
    expect(a.handlePermissionReply('hello world')).toBe(false)
    expect(a.handlePermissionReply('y')).toBe(false)
    expect(a.handlePermissionReply('n abc')).toBe(false)
  })

  it('handlePermissionReply returns false when hash not registered', () => {
    const a = makeIlinkAdapter({ stateDir: newStateDir(), accounts: [acct], db: openTestDb() })
    // Valid format but no pending entry registered
    expect(a.handlePermissionReply('y abc12')).toBe(false)
  })

  it('handlePermissionReply consumes a registered permission entry', async () => {
    const a = makeIlinkAdapter({ stateDir: newStateDir(), accounts: [acct], db: openTestDb() })
    // Register a pending hash without the askUser network call
    // We test the internal wiring: askUser registers + handlePermissionReply consumes.
    // Use askUser with very long timeout — manually consume via handlePermissionReply.
    const p = a.askUser('chat-1', 'test prompt', 'ab123', 60_000)
    // Immediately consume it
    const consumed = a.handlePermissionReply('y ab123')
    expect(consumed).toBe(true)
    const decision = await p
    expect(decision).toBe('allow')
    await a.flush()
  })

  it('handlePermissionReply handles deny decision', async () => {
    const a = makeIlinkAdapter({ stateDir: newStateDir(), accounts: [acct], db: openTestDb() })
    const p = a.askUser('chat-1', 'test prompt', 'zz999', 60_000)
    const consumed = a.handlePermissionReply('n zz999')
    expect(consumed).toBe(true)
    const decision = await p
    expect(decision).toBe('deny')
    await a.flush()
  })

  it('askUser times out after given ms and returns timeout', async () => {
    vi.useFakeTimers()
    try {
      const a = makeIlinkAdapter({ stateDir: newStateDir(), accounts: [acct], db: openTestDb() })
      // askUser registers pending + best-effort sends (send will fail silently — no real ilink).
      // We use vi.advanceTimersByTimeAsync which processes all timers+microtasks iteratively,
      // including the send-retry timeouts (1s each, 3 attempts max) and the sweep timer.
      const p = a.askUser('chat-1', 'test', 'abc12', 50)
      // Advance past the timeout + retries (50ms timeout + 1 sweep at 51ms +
      // up to 3s of ilinkSendMessage retries).
      await vi.advanceTimersByTimeAsync(4000)
      await expect(p).resolves.toBe('timeout')
    } finally {
      vi.useRealTimers()
    }
  })

  it('projects.list() returns empty array when projects.json missing', () => {
    const a = makeIlinkAdapter({ stateDir: newStateDir(), accounts: [acct], db: openTestDb() })
    expect(a.projects.list()).toEqual([])
  })

  it('voice.configStatus returns configured:false when voice-config.json absent', () => {
    const adapter = makeIlinkAdapter({ stateDir: newStateDir(), accounts: [acct], db: openTestDb() })
    expect(adapter.voice.configStatus()).toEqual({ configured: false })
  })

  it('voice.configStatus reflects saved config (http_tts, no api_key leak)', async () => {
    const stateDir = newStateDir()
    const { saveVoiceConfig } = await import('./tts/voice-config')
    await saveVoiceConfig(stateDir, {
      provider: 'http_tts',
      base_url: 'http://mac:8000/v1/audio/speech',
      model: 'openbmb/VoxCPM2',
      default_voice: 'default',
      saved_at: '2026-04-22T00:00:00Z',
    })
    const adapter = makeIlinkAdapter({ stateDir, accounts: [acct], db: openTestDb() })
    const status = adapter.voice.configStatus()
    expect(status).toMatchObject({
      configured: true, provider: 'http_tts',
      base_url: 'http://mac:8000/v1/audio/speech',
      model: 'openbmb/VoxCPM2',
    })
    // no api_key ever returned
    expect((status as any).api_key).toBeUndefined()
  })

  it('voice.saveConfig rejects http_tts without base_url', async () => {
    const adapter = makeIlinkAdapter({ stateDir: newStateDir(), accounts: [acct], db: openTestDb() })
    const r = await adapter.voice.saveConfig({ provider: 'http_tts', model: 'm' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/invalid|base_url/i)
  })

  it('voice.saveConfig rejects qwen without api_key', async () => {
    const adapter = makeIlinkAdapter({ stateDir: newStateDir(), accounts: [acct], db: openTestDb() })
    const r = await adapter.voice.saveConfig({ provider: 'qwen' })
    expect(r.ok).toBe(false)
  })

  it('voice.replyVoice returns not_configured when no config', async () => {
    const adapter = makeIlinkAdapter({ stateDir: newStateDir(), accounts: [acct], db: openTestDb() })
    const r = await adapter.voice.replyVoice('chat-1', 'hello')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('not_configured')
  })

  it('voice.replyVoice rejects unknown chat_id with actionable error (no TTS spent)', async () => {
    // Set up voice config so the not_configured branch doesn't short-circuit.
    const stateDir = newStateDir()
    const { saveVoiceConfig } = await import('./tts/voice-config')
    await saveVoiceConfig(stateDir, {
      provider: 'http_tts',
      base_url: 'http://invalid.local/v1',
      model: 'fake',
      default_voice: 'default',
      saved_at: '2026-05-01T00:00:00Z',
    })
    const adapter = makeIlinkAdapter({ stateDir, accounts: [acct], db: openTestDb() })
    const r = await adapter.voice.replyVoice('stranger@chat', 'hello')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toMatch(/unknown chat_id stranger@chat/)
      expect(r.reason).toMatch(/send a WeChat message to the bot first/)
    }
  })

  it('sendFile throws actionable error for unknown chat_id (preflight before CDN upload)', async () => {
    const adapter = makeIlinkAdapter({ stateDir: newStateDir(), accounts: [acct], db: openTestDb() })
    // Use a real tmp file so assertSendable passes — error must come from
    // the routing preflight, not the file-existence check.
    const { mkdtempSync, writeFileSync } = await import('node:fs')
    const dir = mkdtempSync(join(tmpdir(), 'wcc-sendfile-'))
    const tmpFile = join(dir, 'note.txt')
    writeFileSync(tmpFile, 'hi')
    await expect(adapter.sendFile('stranger@chat', tmpFile))
      .rejects.toThrow(/unknown chat_id stranger@chat.*send a WeChat message to the bot first/)
  })

  it('companion.enable creates config + returns welcome on first call (no personas)', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'wcc-comp-'))
    const adapter = makeIlinkAdapter({ stateDir, accounts: [acct], db: openTestDb() })
    const r = await adapter.companion.enable()
    expect(r.ok).toBe(true)
    if (!('already_configured' in r)) {
      expect(r.welcome_message).toContain('主动提醒')
      expect(r.welcome_message).toContain('memory')
    }
    const fs = await import('node:fs')
    expect(fs.existsSync(join(stateDir, 'companion', 'config.json'))).toBe(true)
    // v2 does NOT scaffold personas/profile.md — Claude owns memory/ instead
    expect(fs.existsSync(join(stateDir, 'companion', 'profile.md'))).toBe(false)
    expect(fs.existsSync(join(stateDir, 'companion', 'personas'))).toBe(false)
  })

  it('companion.enable is idempotent', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'wcc-comp-'))
    const adapter = makeIlinkAdapter({ stateDir, accounts: [acct], db: openTestDb() })
    await adapter.companion.enable()
    const r2 = await adapter.companion.enable()
    expect('already_configured' in r2 ? r2.already_configured : false).toBe(true)
  })

  it('companion.disable flips enabled=false', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'wcc-comp-'))
    const adapter = makeIlinkAdapter({ stateDir, accounts: [acct], db: openTestDb() })
    await adapter.companion.enable()
    const r = await adapter.companion.disable()
    expect(r).toEqual({ ok: true, enabled: false })
    expect(adapter.companion.status().enabled).toBe(false)
  })

  it('companion.status returns minimal v2 shape (enabled/tz/chat_id/snooze)', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'wcc-comp-'))
    const adapter = makeIlinkAdapter({ stateDir, accounts: [acct], db: openTestDb() })
    await adapter.companion.enable()
    const s = adapter.companion.status()
    expect(s.enabled).toBe(true)
    expect(typeof s.timezone).toBe('string')
    expect('snooze_until' in s).toBe(true)
    expect('default_chat_id' in s).toBe(true)
    // v2 dropped: per_project_persona, personas_available, triggers, pushes_*
    expect('triggers' in s).toBe(false)
    expect('personas_available' in s).toBe(false)
  })

  it('companion.snooze writes snooze_until in future', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'wcc-comp-'))
    const adapter = makeIlinkAdapter({ stateDir, accounts: [acct], db: openTestDb() })
    await adapter.companion.enable()
    const before = Date.now()
    const r = await adapter.companion.snooze(60)
    const until = new Date(r.until).getTime()
    expect(until).toBeGreaterThan(before + 59 * 60_000)
    expect(until).toBeLessThan(before + 61 * 60_000)
  })
})
