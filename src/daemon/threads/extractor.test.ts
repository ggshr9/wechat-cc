import { describe, it, expect } from 'vitest'
import { openTestDb } from '../../lib/db'
import { makeMessagesStore } from '../../lib/messages-store'
import { makeThreadsStore } from '../../lib/threads-store'
import { runThreadsExtraction } from './extractor'

function setup() {
  const db = openTestDb()
  return { db, messages: makeMessagesStore(db), threads: makeThreadsStore(db) }
}

describe('threads extractor', () => {
  it('applies create ops and advances watermark to last message ts', async () => {
    const { messages, threads } = setup()
    await messages.append({ id: '1', chatId: 'c1', ts: '2026-06-11T01:00:00Z', direction: 'in', kind: 'text', text: '排产', source: 'live' })
    const res = await runThreadsExtraction({
      chatId: 'c1', messages, threads, log: () => {},
      recordEvent: async () => {},
      sdkEval: async () => '{"ops":[{"op":"create","title":"排产","summary":"s","facets":["task"],"tags":[],"private":false,"episode":{"from_ts":"2026-06-11T01:00:00Z","to_ts":"2026-06-11T01:00:00Z"}}]}',
    })
    expect(res.applied).toBe(1)
    expect((await threads.list('c1')).length).toBe(1)
    expect(await threads.getWatermark('c1')).toBe('2026-06-11T01:00:00Z')
  })

  it('no new messages → skips eval entirely', async () => {
    const { messages, threads } = setup()
    let evalCalls = 0
    await runThreadsExtraction({ chatId: 'c1', messages, threads, log: () => {}, recordEvent: async () => {}, sdkEval: async () => { evalCalls++; return '{"ops":[]}' } })
    expect(evalCalls).toBe(0)
  })

  it('parse failure → watermark does NOT advance (retry next tick)', async () => {
    const { messages, threads } = setup()
    await messages.append({ id: '1', chatId: 'c1', ts: '2026-06-11T01:00:00Z', direction: 'in', kind: 'text', text: 'x', source: 'live' })
    await runThreadsExtraction({ chatId: 'c1', messages, threads, log: () => {}, recordEvent: async () => {}, sdkEval: async () => 'garbage' })
    expect(await threads.getWatermark('c1')).toBeNull()
  })

  it('update op on unknown id is skipped, others still apply', async () => {
    const { messages, threads } = setup()
    await messages.append({ id: '1', chatId: 'c1', ts: '2026-06-11T01:00:00Z', direction: 'in', kind: 'text', text: 'x', source: 'live' })
    const res = await runThreadsExtraction({
      chatId: 'c1', messages, threads, log: () => {}, recordEvent: async () => {},
      sdkEval: async () => '{"ops":[{"op":"touch","id":"thr_ghost","episode":{"from_ts":"a","to_ts":"b"}},{"op":"create","title":"y","summary":"","facets":["life"],"tags":[],"private":false,"episode":{"from_ts":"a","to_ts":"b"}}]}',
    })
    expect(res.applied).toBe(1)
    expect(res.skipped).toBe(1)
  })

  it('contextTail is passed to buildExtractPrompt when pre-watermark messages exist', async () => {
    const { messages, threads } = setup()
    // Seed a message and set the watermark at its ts so it becomes "pre-watermark"
    await messages.append({ id: '1', chatId: 'c1', ts: '2026-06-11T01:00:00Z', direction: 'in', kind: 'text', text: 'old message', source: 'live' })
    await threads.setWatermark('c1', '2026-06-11T01:00:00Z')
    // Add a new post-watermark message
    await messages.append({ id: '2', chatId: 'c1', ts: '2026-06-11T02:00:00Z', direction: 'in', kind: 'text', text: '新消息', source: 'live' })

    let capturedPrompt = ''
    await runThreadsExtraction({
      chatId: 'c1', messages, threads, log: () => {}, recordEvent: async () => {},
      sdkEval: async (prompt: string) => { capturedPrompt = prompt; return '{"ops":[]}' },
    })
    // The context tail containing the old message should be in the prompt
    expect(capturedPrompt).toContain('old message')
    expect(capturedPrompt).toContain('近期历史')
  })

  it('empty ops list advances watermark and records event', async () => {
    const { messages, threads } = setup()
    await messages.append({ id: '1', chatId: 'c1', ts: '2026-06-11T05:00:00Z', direction: 'out', kind: 'text', text: 'hi', source: 'live' })
    let eventRecorded = false
    const res = await runThreadsExtraction({
      chatId: 'c1', messages, threads, log: () => {},
      recordEvent: async () => { eventRecorded = true },
      sdkEval: async () => '{"ops":[]}',
    })
    expect(res.applied).toBe(0)
    expect(res.skipped).toBe(0)
    expect(await threads.getWatermark('c1')).toBe('2026-06-11T05:00:00Z')
    expect(eventRecorded).toBe(true)
  })

  it('update op on known id applies (touch adds episode, lastActive)', async () => {
    const { messages, threads } = setup()
    await messages.append({ id: '1', chatId: 'c1', ts: '2026-06-11T03:00:00Z', direction: 'in', kind: 'text', text: 'follow-up on排产', source: 'live' })
    // Pre-create a thread so the touch op has a target
    const tId = await threads.create({ chatId: 'c1', title: '排产', summary: '', facets: ['task'], tags: [], private: false, episodes: [{ from_ts: '2026-06-10T00:00:00Z', to_ts: '2026-06-10T00:00:00Z' }] })
    const res = await runThreadsExtraction({
      chatId: 'c1', messages, threads, log: () => {}, recordEvent: async () => {},
      sdkEval: async () => `{"ops":[{"op":"touch","id":"${tId}","episode":{"from_ts":"2026-06-11T03:00:00Z","to_ts":"2026-06-11T03:00:00Z"}}]}`,
    })
    expect(res.applied).toBe(1)
    expect(res.skipped).toBe(0)
    const updated = await threads.get(tId)
    expect(updated?.episodes.length).toBe(2)
  })
})
