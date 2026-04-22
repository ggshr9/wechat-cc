import { describe, it, expect, vi } from 'vitest'
import { makeIlinkAdapter, loadAllAccounts, type Account } from './ilink-glue'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
    const a = makeIlinkAdapter({ stateDir: newStateDir(), accounts: [acct] })
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
    expect(typeof a.resolveUserName).toBe('function')
    expect(a.projects).toBeDefined()
  })

  it('setUserName persists to user_names.json', async () => {
    const stateDir = newStateDir()
    const a = makeIlinkAdapter({ stateDir, accounts: [acct] })
    await a.setUserName('chat-1', '小白')
    await a.flush()
    // second instance reads the persisted file
    const { readFileSync } = await import('node:fs')
    const names = JSON.parse(readFileSync(join(stateDir, 'user_names.json'), 'utf8'))
    expect(names['chat-1']).toBe('小白')
  })

  it('resolveUserName returns name after setUserName', async () => {
    const a = makeIlinkAdapter({ stateDir: newStateDir(), accounts: [acct] })
    await a.setUserName('chat-2', '测试用户')
    expect(a.resolveUserName('chat-2')).toBe('测试用户')
    expect(a.resolveUserName('chat-unknown')).toBeUndefined()
  })

  it('lastActiveChatId returns null when no activity recorded', () => {
    const a = makeIlinkAdapter({ stateDir: newStateDir(), accounts: [acct] })
    expect(a.lastActiveChatId()).toBeNull()
  })

  it('markChatActive updates lastActiveChatId', () => {
    const a = makeIlinkAdapter({ stateDir: newStateDir(), accounts: [acct] })
    expect(a.lastActiveChatId()).toBeNull()
    a.markChatActive('chat-99')
    expect(a.lastActiveChatId()).toBe('chat-99')
    a.markChatActive('chat-100')
    expect(a.lastActiveChatId()).toBe('chat-100')
  })

  it('loadProjects returns {projects: {}, current: null} when projects.json missing', () => {
    const a = makeIlinkAdapter({ stateDir: newStateDir(), accounts: [acct] })
    const snap = a.loadProjects()
    expect(snap.projects).toEqual({})
    expect(snap.current).toBeNull()
  })

  it('handlePermissionReply returns false for non-permission text', () => {
    const a = makeIlinkAdapter({ stateDir: newStateDir(), accounts: [acct] })
    expect(a.handlePermissionReply('hello world')).toBe(false)
    expect(a.handlePermissionReply('y')).toBe(false)
    expect(a.handlePermissionReply('n abc')).toBe(false)
  })

  it('handlePermissionReply returns false when hash not registered', () => {
    const a = makeIlinkAdapter({ stateDir: newStateDir(), accounts: [acct] })
    // Valid format but no pending entry registered
    expect(a.handlePermissionReply('y abc12')).toBe(false)
  })

  it('handlePermissionReply consumes a registered permission entry', async () => {
    const a = makeIlinkAdapter({ stateDir: newStateDir(), accounts: [acct] })
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
    const a = makeIlinkAdapter({ stateDir: newStateDir(), accounts: [acct] })
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
      const a = makeIlinkAdapter({ stateDir: newStateDir(), accounts: [acct] })
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
    const a = makeIlinkAdapter({ stateDir: newStateDir(), accounts: [acct] })
    expect(a.projects.list()).toEqual([])
  })

  it('voice.configStatus returns configured:false when voice-config.json absent', () => {
    const adapter = makeIlinkAdapter({ stateDir: newStateDir(), accounts: [acct] })
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
    const adapter = makeIlinkAdapter({ stateDir, accounts: [acct] })
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
    const adapter = makeIlinkAdapter({ stateDir: newStateDir(), accounts: [acct] })
    const r = await adapter.voice.saveConfig({ provider: 'http_tts', model: 'm' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/invalid|base_url/i)
  })

  it('voice.saveConfig rejects qwen without api_key', async () => {
    const adapter = makeIlinkAdapter({ stateDir: newStateDir(), accounts: [acct] })
    const r = await adapter.voice.saveConfig({ provider: 'qwen' })
    expect(r.ok).toBe(false)
  })

  it('voice.replyVoice returns not_configured when no config', async () => {
    const adapter = makeIlinkAdapter({ stateDir: newStateDir(), accounts: [acct] })
    const r = await adapter.voice.replyVoice('chat-1', 'hello')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('not_configured')
  })

  it('companion.enable scaffolds files + returns welcome on first call', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'wcc-comp-'))
    const adapter = makeIlinkAdapter({ stateDir, accounts: [acct] })
    const r = await adapter.companion.enable()
    expect(r.ok).toBe(true)
    if (!('already_configured' in r)) {
      expect(r.personas_scaffolded).toContain('assistant')
      expect(r.personas_scaffolded).toContain('companion')
      expect(r.welcome_message).toContain('小助手')
    }
    // files exist
    const fs = await import('node:fs')
    expect(fs.existsSync(join(stateDir, 'companion', 'profile.md'))).toBe(true)
    expect(fs.existsSync(join(stateDir, 'companion', 'personas', 'assistant.md'))).toBe(true)
    expect(fs.existsSync(join(stateDir, 'companion', 'personas', 'companion.md'))).toBe(true)
    expect(fs.existsSync(join(stateDir, 'companion', 'config.json'))).toBe(true)
  })

  it('companion.enable is idempotent', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'wcc-comp-'))
    const adapter = makeIlinkAdapter({ stateDir, accounts: [acct] })
    await adapter.companion.enable()
    const r2 = await adapter.companion.enable()
    expect('already_configured' in r2 ? r2.already_configured : false).toBe(true)
  })

  it('companion.disable flips enabled=false', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'wcc-comp-'))
    const adapter = makeIlinkAdapter({ stateDir, accounts: [acct] })
    await adapter.companion.enable()
    const r = await adapter.companion.disable()
    expect(r).toEqual({ ok: true, enabled: false })
    expect(adapter.companion.status().enabled).toBe(false)
  })

  it('companion.status returns personas + triggers with next_fire_at', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'wcc-comp-'))
    const adapter = makeIlinkAdapter({ stateDir, accounts: [acct] })
    await adapter.companion.enable()
    await adapter.companion.triggerAdd({
      id: 'ci', project: 'wechat-cc', schedule: '*/10 * * * *',
      task: 'check CI', personas: ['assistant'],
    })
    const s = adapter.companion.status()
    expect(s.enabled).toBe(true)
    expect(s.personas_available.map(p => p.name).sort()).toEqual(['assistant', 'companion'])
    expect(s.triggers).toHaveLength(1)
    expect(s.triggers[0]?.next_fire_at).not.toBeNull()
  })

  it('companion.snooze writes snooze_until in future', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'wcc-comp-'))
    const adapter = makeIlinkAdapter({ stateDir, accounts: [acct] })
    await adapter.companion.enable()
    const before = Date.now()
    const r = await adapter.companion.snooze(60)
    const until = new Date(r.until).getTime()
    expect(until).toBeGreaterThan(before + 59 * 60_000)
    expect(until).toBeLessThan(before + 61 * 60_000)
  })

  it('companion.personaSwitch rejects unknown persona', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'wcc-comp-'))
    const adapter = makeIlinkAdapter({ stateDir, accounts: [acct] })
    await adapter.companion.enable()
    const r = await adapter.companion.personaSwitch({ persona: 'ghost', project: 'P' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/unknown persona/i)
  })

  it('companion.personaSwitch persists to config.json', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'wcc-comp-'))
    const adapter = makeIlinkAdapter({ stateDir, accounts: [acct] })
    await adapter.companion.enable()
    const r = await adapter.companion.personaSwitch({ persona: 'companion', project: 'notes' })
    expect(r.ok).toBe(true)
    const s = adapter.companion.status()
    expect(s.per_project_persona.notes).toBe('companion')
  })

  it('companion.triggerAdd rejects duplicate id', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'wcc-comp-'))
    const adapter = makeIlinkAdapter({ stateDir, accounts: [acct] })
    await adapter.companion.enable()
    await adapter.companion.triggerAdd({
      id: 'x', project: 'P', schedule: '* * * * *', task: 't',
    })
    const r = await adapter.companion.triggerAdd({
      id: 'x', project: 'P', schedule: '* * * * *', task: 't',
    })
    expect(r.ok).toBe(false)
  })

  it('companion.triggerAdd rejects invalid cron', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'wcc-comp-'))
    const adapter = makeIlinkAdapter({ stateDir, accounts: [acct] })
    await adapter.companion.enable()
    const r = await adapter.companion.triggerAdd({
      id: 'bad', project: 'P', schedule: 'not-cron', task: 't',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/invalid schedule/i)
  })

  it('companion.triggerRemove returns false for unknown id', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'wcc-comp-'))
    const adapter = makeIlinkAdapter({ stateDir, accounts: [acct] })
    await adapter.companion.enable()
    const r = await adapter.companion.triggerRemove('ghost')
    expect(r.ok).toBe(false)
  })

  it('companion.triggerPause sets paused_until', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'wcc-comp-'))
    const adapter = makeIlinkAdapter({ stateDir, accounts: [acct] })
    await adapter.companion.enable()
    await adapter.companion.triggerAdd({
      id: 't', project: 'P', schedule: '* * * * *', task: 'x',
    })
    const r = await adapter.companion.triggerPause('t', 30)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.paused_until).not.toBeNull()
      const until = new Date(r.paused_until!).getTime()
      expect(until).toBeGreaterThan(Date.now())
    }
  })
})
