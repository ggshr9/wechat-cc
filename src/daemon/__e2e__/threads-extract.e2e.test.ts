/**
 * e2e: threads extraction fires on the introspect tick (Task 8).
 *
 * Strategy: boot daemon with companion enabled + default_chat_id='chat1',
 * seed messages into the db BEFORE boot (using stateDirOverride so the
 * startup introspect catch-up fires), then call daemon.fireTick('introspect')
 * to explicitly run one introspect+extraction cycle and assert results.
 *
 * The cheap eval (getCheapEval) is the same sdkEval used for both the
 * introspect observation decision AND the threads extraction — they share
 * the fake-sdk's string-prompt path. We distinguish calls by prompt content:
 *   - Introspect prompt contains "write": return `{"write":false,"reasoning":"skip"}`
 *   - Threads prompt contains "新增对话片段": return a create op JSON
 */
import { describe, it, expect } from 'vitest'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { startTestDaemon } from './harness'
import { openWechatDb } from '../../lib/db'
import { makeMessagesStore } from '../../lib/messages-store'
import { makeThreadsStore } from '../../lib/threads-store'
import { makeEventsStore } from '../events/store'

describe('e2e: threads extraction on introspect tick', () => {
  it('fireTick introspect with pre-seeded messages writes a thread + threads_extracted event', { timeout: 30000 }, async () => {
    // ── 1. Pre-create state dir and seed messages BEFORE booting ─────────────
    const stateDir = mkdtempSync(join(tmpdir(), 'wechat-cc-e2e-threads-'))
    mkdirSync(join(stateDir, 'inbox'), { recursive: true })
    mkdirSync(join(stateDir, 'memory'), { recursive: true })
    mkdirSync(join(stateDir, 'accounts'), { recursive: true })
    mkdirSync(join(stateDir, 'memory', 'chat1'), { recursive: true })

    // Open db and seed messages before boot — the introspect tick reads from this db
    const preDb = openWechatDb(stateDir)
    const preMessages = makeMessagesStore(preDb)
    await preMessages.append({
      id: 'seed-msg-1',
      chatId: 'chat1',
      ts: '2026-06-11T01:00:00Z',
      direction: 'in',
      kind: 'text',
      text: '排产系统今天又出问题了',
      source: 'live',
    })
    await preMessages.append({
      id: 'seed-msg-2',
      chatId: 'chat1',
      ts: '2026-06-11T01:01:00Z',
      direction: 'out',
      kind: 'text',
      text: '好的，我来看看',
      source: 'live',
    })
    preDb.close()

    // ── 2. Track eval calls ───────────────────────────────────────────────────
    let introspectEvalFired = false
    let threadsEvalFired = false

    // ── 3. Boot daemon with companion enabled, reusing the pre-seeded stateDir ─
    const daemon = await startTestDaemon({
      stateDirOverride: stateDir,
      dangerously: true,
      companion: {
        enabled: true,
        default_chat_id: 'chat1',
      },
      claudeScript: {
        async onDispatch(prompt: string) {
          if (prompt.includes('新增对话片段')) {
            // Threads extraction call — return a valid create op
            threadsEvalFired = true
            return {
              toolCalls: [],
              finalText: '{"ops":[{"op":"create","title":"排产系统","summary":"用户反复讨论排产问题","facets":["task"],"tags":["compass"],"private":false,"episode":{"from_ts":"2026-06-11T01:00:00Z","to_ts":"2026-06-11T01:01:00Z"}}]}',
            }
          }
          // Introspect decision call
          introspectEvalFired = true
          return {
            toolCalls: [],
            finalText: '{"write":false,"reasoning":"no notable pattern for test"}',
          }
        },
      },
    })

    const db = openWechatDb(daemon.stateDir)
    try {
      // ── 4. Explicitly fire the introspect tick ────────────────────────────
      await daemon.fireTick('introspect', new Date('2026-06-12T01:00:00Z'))

      // ── 5. Assert eval calls fired ────────────────────────────────────────
      expect(introspectEvalFired).toBe(true)
      expect(threadsEvalFired).toBe(true)

      // ── 6. Assert threads table has ≥1 row for chat1 ─────────────────────
      const tStore = makeThreadsStore(db)
      const threads = await tStore.list('chat1')
      expect(threads.length).toBeGreaterThanOrEqual(1)
      expect(threads[0]?.title).toBe('排产系统')
      expect(threads[0]?.facets).toContain('task')

      // ── 7. Assert events table has a threads_extracted row ────────────────
      const evStore = makeEventsStore(db, 'chat1')
      const evs = await evStore.list()
      const extractEv = evs.find(e => e.kind === 'threads_extracted')
      expect(extractEv).toBeDefined()
      expect(extractEv?.trigger).toBe('introspect')
      expect(extractEv?.reasoning).toContain('applied=1')
      expect(extractEv?.reasoning).toContain('batch=2')

      // ── 8. Assert watermark was advanced ─────────────────────────────────
      const watermark = await tStore.getWatermark('chat1')
      expect(watermark).toBe('2026-06-11T01:01:00Z')
    } finally {
      db.close()
      await daemon.stop()
    }
  })

  it('introspect tick with no messages skips threads eval entirely', { timeout: 20000 }, async () => {
    let threadsEvalFired = false
    let introspectEvalFired = false

    const daemon = await startTestDaemon({
      dangerously: true,
      companion: {
        enabled: true,
        default_chat_id: 'chat1',
      },
      claudeScript: {
        async onDispatch(prompt: string) {
          if (prompt.includes('新增对话片段')) {
            threadsEvalFired = true
            return { toolCalls: [], finalText: '{"ops":[]}' }
          }
          introspectEvalFired = true
          return { toolCalls: [], finalText: '{"write":false,"reasoning":"skip for test"}' }
        },
      },
    })

    const db = openWechatDb(daemon.stateDir)
    try {
      // Fire introspect tick with no messages in the db
      await daemon.fireTick('introspect', new Date('2026-06-12T02:00:00Z'))

      // Introspect should have fired (companion is enabled), threads should NOT
      expect(introspectEvalFired).toBe(true)
      expect(threadsEvalFired).toBe(false)

      // No threads in table
      const tStore = makeThreadsStore(db)
      const threads = await tStore.list('chat1')
      expect(threads.length).toBe(0)

      // No threads_extracted event
      const evStore = makeEventsStore(db, 'chat1')
      const evs = await evStore.list()
      expect(evs.some(e => e.kind === 'threads_extracted')).toBe(false)
    } finally {
      db.close()
      await daemon.stop()
    }
  })
})
