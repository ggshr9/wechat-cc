import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { triggerStaleSummaryRefresh } from './summarizer-runtime'
import { makeSessionStore } from '../../core/session-store'

describe('triggerStaleSummaryRefresh', () => {
  let stateDir: string
  let projectsRoot: string
  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'sumref-'))
    projectsRoot = join(homedir(), '.claude', 'projects')
  })
  afterEach(() => rmSync(stateDir, { recursive: true, force: true }))

  function seedSessions(records: Record<string, { session_id: string; last_used_at: string; summary?: string; summary_updated_at?: string }>) {
    writeFileSync(join(stateDir, 'sessions.json'), JSON.stringify({ version: 1, sessions: records }))
  }

  function seedJsonl(sessionId: string, turns: unknown[]): string {
    const dir = join(projectsRoot, `-tmp-summarizer-${sessionId.slice(0, 6)}`)
    mkdirSync(dir, { recursive: true })
    const path = join(dir, `${sessionId}.jsonl`)
    writeFileSync(path, turns.map(t => JSON.stringify(t)).join('\n') + '\n')
    return dir  // for cleanup
  }

  it('skips fresh summaries (no SDK call)', async () => {
    const fresh = new Date().toISOString()
    seedSessions({ compass: { session_id: 's_fresh', last_used_at: fresh, summary: 'cached', summary_updated_at: fresh } })
    const sdkEval = vi.fn(async () => 'should-not-be-called')
    await triggerStaleSummaryRefresh({ stateDir, sdkEval, log: vi.fn() })
    expect(sdkEval).not.toHaveBeenCalled()
  })

  it('writes summary on stale entry via injected sdkEval', async () => {
    const stale = new Date(Date.now() - 30 * 86400_000).toISOString()
    const fresh = new Date().toISOString()
    seedSessions({ compass: { session_id: 's_stale_xyz', last_used_at: fresh, summary: 'old', summary_updated_at: stale } })
    const dir = seedJsonl('s_stale_xyz', [
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: '帮我看一下 ilink-glue.ts' }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '我修了 transport 那块' }] } },
    ])
    try {
      const sdkEval = vi.fn(async () => '修了 ilink-glue 的 token bug')
      await triggerStaleSummaryRefresh({ stateDir, sdkEval, log: vi.fn() })
      expect(sdkEval).toHaveBeenCalledOnce()
      const fresh2 = makeSessionStore(join(stateDir, 'sessions.json'), { debounceMs: 0 })
      expect(fresh2.get('compass')?.summary).toBe('修了 ilink-glue 的 token bug')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('failure leaves prior summary untouched', async () => {
    const stale = new Date(Date.now() - 30 * 86400_000).toISOString()
    const fresh = new Date().toISOString()
    seedSessions({ compass: { session_id: 's_err_xyz', last_used_at: fresh, summary: 'old summary', summary_updated_at: stale } })
    const dir = seedJsonl('s_err_xyz', [
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: '帮忙' }] } },
    ])
    try {
      const sdkEval = vi.fn(async () => { throw new Error('SDK timeout') })
      await triggerStaleSummaryRefresh({ stateDir, sdkEval, log: vi.fn() })
      const after = makeSessionStore(join(stateDir, 'sessions.json'), { debounceMs: 0 })
      expect(after.get('compass')?.summary).toBe('old summary')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('strips ASCII / Chinese quotes + caps at 50 chars', async () => {
    const stale = new Date(Date.now() - 30 * 86400_000).toISOString()
    const fresh = new Date().toISOString()
    seedSessions({ compass: { session_id: 's_quote_xyz', last_used_at: fresh, summary_updated_at: stale } })
    const dir = seedJsonl('s_quote_xyz', [
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: '...' }] } },
    ])
    try {
      const longQuoted = '「' + 'x'.repeat(80) + '」'
      const sdkEval = vi.fn(async () => longQuoted)
      await triggerStaleSummaryRefresh({ stateDir, sdkEval, log: vi.fn() })
      const after = makeSessionStore(join(stateDir, 'sessions.json'), { debounceMs: 0 })
      const s = after.get('compass')?.summary
      expect(s).toBeDefined()
      expect(s!.length).toBeLessThanOrEqual(50)
      expect(s!.startsWith('「')).toBe(false)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('passes memorySnapshot to formatSummaryRequest when resolveChatId returns a chat', async () => {
    // Seed: stale entry + a memory file for the resolved chat
    const stale = new Date(Date.now() - 30 * 86400_000).toISOString()
    const fresh = new Date().toISOString()
    seedSessions({ compass: { session_id: 's_mem_xyz', last_used_at: fresh, summary_updated_at: stale } })
    const dir = seedJsonl('s_mem_xyz', [
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: '随便聊点什么' }] } },
    ])
    const memDir = join(stateDir, 'memory', 'chat_test')
    mkdirSync(memDir, { recursive: true })
    writeFileSync(join(memDir, 'preferences.md'), '总结请像朋友说话')

    try {
      let receivedPrompt = ''
      const sdkEval = async (prompt: string) => { receivedPrompt = prompt; return '随便聊了点天' }
      await triggerStaleSummaryRefresh({
        stateDir,
        sdkEval,
        resolveChatId: () => 'chat_test',
        log: vi.fn(),
      })
      expect(receivedPrompt).toContain('用户记忆')
      expect(receivedPrompt).toContain('总结请像朋友说话')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('omits memory section when resolveChatId returns null', async () => {
    const stale = new Date(Date.now() - 30 * 86400_000).toISOString()
    const fresh = new Date().toISOString()
    seedSessions({ compass: { session_id: 's_nomem_xyz', last_used_at: fresh, summary_updated_at: stale } })
    const dir = seedJsonl('s_nomem_xyz', [
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
    ])

    try {
      let receivedPrompt = ''
      const sdkEval = async (prompt: string) => { receivedPrompt = prompt; return 'short' }
      await triggerStaleSummaryRefresh({
        stateDir,
        sdkEval,
        resolveChatId: () => null,
        log: vi.fn(),
      })
      expect(receivedPrompt).not.toContain('用户记忆')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
