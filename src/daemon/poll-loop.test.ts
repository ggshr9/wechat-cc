import { describe, it, expect, vi } from 'vitest'
import { getEventListeners } from 'node:events'
import { parseUpdates, startLongPollLoops, sleep, type RawUpdate } from './poll-loop'
import type { Account } from './ilink-glue'

describe('sleep', () => {
  it('removes its abort listener when the timer fires (no leak on a long-lived signal)', async () => {
    // Regression: the retry-backoff sleep added a `{once:true}` abort listener
    // per call but only auto-removed it if abort actually fired. A flapping
    // account (repeated getUpdates failures) accumulated one un-fired listener
    // per cycle on the loop's long-lived AbortSignal → MaxListenersExceeded +
    // a slow closure leak. The timer-fire path must remove the listener too.
    vi.useFakeTimers()
    try {
      const ac = new AbortController()
      const p1 = sleep(100, ac.signal)
      const p2 = sleep(100, ac.signal)
      expect(getEventListeners(ac.signal, 'abort')).toHaveLength(2) // both armed
      await vi.advanceTimersByTimeAsync(100)
      await Promise.all([p1, p2])
      expect(getEventListeners(ac.signal, 'abort')).toHaveLength(0) // removed on fire
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('parseUpdates', () => {
  it('normalizes a text message', () => {
    const raw: RawUpdate[] = [{
      message_id: 1,
      from_user_id: 'u1',
      create_time_ms: 1234000,
      message_type: 1,
      message_state: 2,
      item_list: [{ type: 1, text_item: { text: 'hi' } }],
    }]
    const [msg] = parseUpdates(raw, { accountId: 'A', resolveUserName: () => '小白' })
    expect(msg).toMatchObject({
      chatId: 'u1', userId: 'u1', userName: '小白',
      text: 'hi', msgType: 'text', accountId: 'A',
    })
    expect(msg!.createTimeMs).toBe(1234000)
  })

  it('uses create_time_ms directly (already in ms)', () => {
    const raw: RawUpdate[] = [{
      from_user_id: 'u',
      create_time_ms: 100000,
      message_type: 1,
      message_state: 2,
      item_list: [{ type: 1, text_item: { text: 'x' } }],
    }]
    const [msg] = parseUpdates(raw, { accountId: 'A', resolveUserName: () => undefined })
    expect(msg!.createTimeMs).toBe(100000)
  })

  it('produces attachment entry for an image message', () => {
    const raw: RawUpdate[] = [{
      from_user_id: 'u',
      create_time_ms: 1000,
      message_type: 1,
      message_state: 2,
      item_list: [{
        type: 2,
        image_item: {
          media: { encrypt_query_param: 'abc', aes_key: 'base64key' },
          aeskey: 'base64key',
        },
      }],
    }]
    const [msg] = parseUpdates(raw, { accountId: 'A', resolveUserName: () => undefined })
    expect(msg!.attachments).toHaveLength(1)
    expect(msg!.attachments![0]).toMatchObject({ kind: 'image' })
  })

  it('extracts full quoted text (prefers message_item text over title) + type', () => {
    const raw: RawUpdate[] = [{
      from_user_id: 'u',
      create_time_ms: 1000,
      message_type: 1,
      message_state: 2,
      item_list: [
        {
          type: 1,
          msg_id: 'cur-1',
          ref_msg: {
            title: '明天下午三点的会议…',
            message_item: { type: 1, text_item: { text: '明天下午三点的会议改到周四了，记得通知大家' } },
          },
        },
        { type: 1, text_item: { text: 'this' } },
      ],
    }]
    const [msg] = parseUpdates(raw, { accountId: 'A', resolveUserName: () => undefined })
    expect(msg!.quote).toEqual({ type: 'text', text: '明天下午三点的会议改到周四了，记得通知大家' })
    expect(msg!.text).not.toContain('[引用')
    expect(msg!.text).toBe('this')
  })

  it('keeps current text when ref_msg and text_item are on the same item', () => {
    const raw: RawUpdate[] = [{
      from_user_id: 'u',
      create_time_ms: 1000,
      message_type: 1,
      message_state: 2,
      item_list: [{
        type: 1,
        msg_id: 'cur-1',
        ref_msg: {
          title: '上一条…',
          message_item: { type: 1, text_item: { text: '上一条完整内容' } },
        },
        text_item: { text: '这次回复正文' },
      }],
    }]
    const [msg] = parseUpdates(raw, { accountId: 'A', resolveUserName: () => undefined })
    expect(msg!.quote).toEqual({ type: 'text', text: '上一条完整内容' })
    expect(msg!.msgType).toBe('text')
    expect(msg!.text).toBe('这次回复正文')
  })

  it('does not mark a quote-only ref item as current text', () => {
    const raw: RawUpdate[] = [{
      from_user_id: 'u',
      create_time_ms: 1000,
      message_type: 1,
      message_state: 2,
      item_list: [{
        type: 1,
        ref_msg: {
          title: '上一条…',
          message_item: { type: 1, text_item: { text: '上一条完整内容' } },
        },
      }],
    }]
    const [msg] = parseUpdates(raw, { accountId: 'A', resolveUserName: () => undefined })
    expect(msg!.quote).toEqual({ type: 'text', text: '上一条完整内容' })
    expect(msg!.msgType).toBe('unknown')
    expect(msg!.text).toBe('(non-text message)')
  })

  it('prefers unsupported_item.text over title, labels non-text quote types', () => {
    const raw: RawUpdate[] = [{
      from_user_id: 'u',
      create_time_ms: 1000,
      message_type: 1,
      message_state: 2,
      item_list: [
        {
          type: 1,
          ref_msg: {
            title: '[图片-截断标题]',
            message_item: { type: 2, unsupported_item: { text: '[图片]' } },
          },
        },
        { type: 1, text_item: { text: 'what is this' } },
      ],
    }]
    const [msg] = parseUpdates(raw, { accountId: 'A', resolveUserName: () => undefined })
    expect(msg!.quote).toEqual({ type: 'image', text: '[图片]' })
  })

  it('falls back to title when no message_item text or unsupported_item', () => {
    const raw: RawUpdate[] = [{
      from_user_id: 'u',
      create_time_ms: 1000,
      message_type: 1,
      message_state: 2,
      item_list: [
        { type: 1, ref_msg: { title: '短摘要…' } },
        { type: 1, text_item: { text: 'reply' } },
      ],
    }]
    const [msg] = parseUpdates(raw, { accountId: 'A', resolveUserName: () => undefined })
    expect(msg!.quote).toEqual({ type: 'unknown', text: '短摘要…' })
  })

  it('does not set quote for a degenerate ref_msg with no type and no text', () => {
    const raw: RawUpdate[] = [{
      from_user_id: 'u',
      create_time_ms: 1000,
      message_type: 1,
      message_state: 2,
      item_list: [
        { type: 1, ref_msg: {} },
        { type: 1, text_item: { text: 'hello' } },
      ],
    }]
    const [msg] = parseUpdates(raw, { accountId: 'A', resolveUserName: () => undefined })
    expect(msg!.quote).toBeUndefined()
  })

  it('falls back userName=undefined when resolver returns undefined', () => {
    const raw: RawUpdate[] = [{
      from_user_id: 'u42',
      create_time_ms: 1000,
      message_type: 1,
      message_state: 2,
      item_list: [{ type: 1, text_item: { text: 'x' } }],
    }]
    const [msg] = parseUpdates(raw, { accountId: 'A', resolveUserName: () => undefined })
    expect(msg!.userName).toBeUndefined()
  })

  it('skips bot messages (message_type !== 1)', () => {
    const raw: RawUpdate[] = [{
      from_user_id: 'bot',
      create_time_ms: 1000,
      message_type: 2,
      message_state: 2,
      item_list: [{ type: 1, text_item: { text: 'bot reply' } }],
    }]
    const result = parseUpdates(raw, { accountId: 'A', resolveUserName: () => undefined })
    expect(result).toHaveLength(0)
  })

  it('skips messages still generating (message_state !== 2)', () => {
    const raw: RawUpdate[] = [{
      from_user_id: 'u',
      create_time_ms: 1000,
      message_type: 1,
      message_state: 1,
      item_list: [{ type: 1, text_item: { text: 'partial' } }],
    }]
    const result = parseUpdates(raw, { accountId: 'A', resolveUserName: () => undefined })
    expect(result).toHaveLength(0)
  })

  it('joins multiple text items', () => {
    const raw: RawUpdate[] = [{
      from_user_id: 'u',
      create_time_ms: 1000,
      message_type: 1,
      message_state: 2,
      item_list: [
        { type: 1, text_item: { text: 'line1' } },
        { type: 1, text_item: { text: 'line2' } },
      ],
    }]
    const [msg] = parseUpdates(raw, { accountId: 'A', resolveUserName: () => undefined })
    expect(msg!.text).toBe('line1\nline2')
  })

  it('passes through context_token from raw update so daemon can capture it', () => {
    const raw: RawUpdate[] = [{
      from_user_id: 'u',
      create_time_ms: 1000,
      message_type: 1,
      message_state: 2,
      context_token: 'ctx-abc-123',
      item_list: [{ type: 1, text_item: { text: 'hi' } }],
    }]
    const [msg] = parseUpdates(raw, { accountId: 'A', resolveUserName: () => undefined })
    expect(msg!.contextToken).toBe('ctx-abc-123')
  })

  it('omits contextToken when raw update has no context_token', () => {
    const raw: RawUpdate[] = [{
      from_user_id: 'u',
      create_time_ms: 1000,
      message_type: 1,
      message_state: 2,
      item_list: [{ type: 1, text_item: { text: 'hi' } }],
    }]
    const [msg] = parseUpdates(raw, { accountId: 'A', resolveUserName: () => undefined })
    expect(msg!.contextToken).toBeUndefined()
  })
})

describe('startLongPollLoops', () => {
  const baseAcct: Account = {
    id: 'A1', botId: 'b', userId: 'ubot', baseUrl: 'https://x', token: 'T', syncBuf: '',
  }

  it('calls onInbound for each parsed message then stops cleanly', async () => {
    const updates: RawUpdate[] = [
      {
        from_user_id: 'u1', create_time_ms: 1000, message_type: 1, message_state: 2,
        item_list: [{ type: 1, text_item: { text: 'a' } }],
      },
      {
        from_user_id: 'u1', create_time_ms: 2000, message_type: 1, message_state: 2,
        item_list: [{ type: 1, text_item: { text: 'b' } }],
      },
    ]
    const getUpdates = vi.fn()
      .mockResolvedValueOnce({ updates, sync_buf: 'buf2' })
      .mockImplementation(async () => { await new Promise(r => setTimeout(r, 50)); return { updates: [], sync_buf: 'buf2' } })

    const seen: string[] = []
    const onInbound = async (m: import('../core/prompt-format').InboundMsg) => {
      seen.push(m.text)
    }

    const handle = startLongPollLoops({
      accounts: [baseAcct],
      onInbound,
      ilink: { getUpdates },
      parse: (us, deps) => parseUpdates(us, deps),
      resolveUserName: () => undefined,
    })
    await new Promise(r => setTimeout(r, 30))
    expect(seen).toEqual(['a', 'b'])
    expect(getUpdates).toHaveBeenCalledWith('A1', 'https://x', 'T', '')
    // second call uses updated syncBuf from first response (4th positional arg)
    if (getUpdates.mock.calls.length >= 2) {
      expect(getUpdates.mock.calls[1]![3]).toBe('buf2')
    }
    await handle.stop()
  })

  it('calls onPollCycle after a successful getUpdates (daemon-health heartbeat hook)', async () => {
    // The poll loop is the daemon's "am I actually serving" signal. Each
    // successful long-poll round-trip fires onPollCycle so main.ts can stamp
    // the heartbeat the instance lock reads — a daemon whose poll loop stalls
    // (or never starts) lets the heartbeat go stale and becomes stealable.
    // Resolve the first round-trip, then yield via a real timer on subsequent
    // calls. A bare mockResolvedValue would resolve instantly every iteration,
    // starving the macrotask queue (the loop never awaits anything real) so
    // the 30ms timer below — and handle.stop() — could never fire → hang.
    const getUpdates = vi.fn()
      .mockResolvedValueOnce({ updates: [], sync_buf: '' })
      .mockImplementation(async () => { await new Promise(r => setTimeout(r, 50)); return { updates: [], sync_buf: '' } })
    const onPollCycle = vi.fn()
    const handle = startLongPollLoops({
      accounts: [baseAcct],
      onInbound: async () => {},
      ilink: { getUpdates },
      parse: (us, deps) => parseUpdates(us, deps),
      resolveUserName: () => undefined,
      onPollCycle,
    })
    await new Promise(r => setTimeout(r, 30))
    await handle.stop()
    expect(onPollCycle).toHaveBeenCalled()
  })

  it('stamps onPollCycle after EACH inbound message (so a slow batch does not starve the heartbeat)', async () => {
    // A batch of slow turns runs inline in the loop; without a per-message
    // stamp the heartbeat would only refresh once the whole batch drains,
    // long enough for the instance lock to look stale and be stolen.
    const updates: RawUpdate[] = [
      { from_user_id: 'u1', create_time_ms: 1000, message_type: 1, message_state: 2, item_list: [{ type: 1, text_item: { text: 'a' } }] },
      { from_user_id: 'u1', create_time_ms: 2000, message_type: 1, message_state: 2, item_list: [{ type: 1, text_item: { text: 'b' } }] },
    ]
    const getUpdates = vi.fn()
      .mockResolvedValueOnce({ updates, sync_buf: 'b1' })
      .mockImplementation(async () => { await new Promise(r => setTimeout(r, 50)); return { updates: [], sync_buf: 'b1' } })
    const onPollCycle = vi.fn()
    let inbound = 0
    const handle = startLongPollLoops({
      accounts: [baseAcct],
      onInbound: async () => { inbound++; await new Promise(r => setTimeout(r, 5)) },
      ilink: { getUpdates },
      parse: (us, deps) => parseUpdates(us, deps),
      resolveUserName: () => undefined,
      onPollCycle,
    })
    await new Promise(r => setTimeout(r, 40))
    await handle.stop()
    expect(inbound).toBe(2)
    // ≥1 per-message stamp + the per-round-trip stamp → strictly more than the
    // single round-trip count. At minimum once per delivered message.
    expect(onPollCycle.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('swallows getUpdates errors and retries', async () => {
    const getUpdates = vi.fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValue({ updates: [], sync_buf: '' })
    const onInbound = vi.fn()

    const handle = startLongPollLoops({
      accounts: [baseAcct],
      onInbound,
      ilink: { getUpdates },
      parse: () => [],
      resolveUserName: () => undefined,
      log: () => {},
    })
    await new Promise(r => setTimeout(r, 50))
    expect(getUpdates).toHaveBeenCalled()
    expect(onInbound).not.toHaveBeenCalled()  // no updates
    await handle.stop()
  })

  it('persists the advanced syncBuf via onSyncBuf after a batch', async () => {
    const updates: RawUpdate[] = [
      {
        from_user_id: 'u1', create_time_ms: 1000, message_type: 1, message_state: 2,
        item_list: [{ type: 1, text_item: { text: 'a' } }],
      },
    ]
    const getUpdates = vi.fn()
      .mockResolvedValueOnce({ updates, sync_buf: 'buf2' })
      .mockImplementation(async () => { await new Promise(r => setTimeout(r, 50)); return { updates: [], sync_buf: 'buf2' } })

    const persisted: Array<[string, string]> = []
    const handle = startLongPollLoops({
      accounts: [baseAcct],
      onInbound: async () => {},
      ilink: { getUpdates },
      parse: (us, deps) => parseUpdates(us, deps),
      resolveUserName: () => undefined,
      onSyncBuf: (id, buf) => { persisted.push([id, buf]) },
    })
    await new Promise(r => setTimeout(r, 30))
    expect(persisted).toContainEqual(['A1', 'buf2'])
    await handle.stop()
  })

  it('persists syncBuf only after the batch is fully processed (crash-safe ordering)', async () => {
    const updates: RawUpdate[] = [
      {
        from_user_id: 'u1', create_time_ms: 1000, message_type: 1, message_state: 2,
        item_list: [{ type: 1, text_item: { text: 'a' } }],
      },
    ]
    const getUpdates = vi.fn()
      .mockResolvedValueOnce({ updates, sync_buf: 'buf2' })
      .mockImplementation(async () => { await new Promise(r => setTimeout(r, 50)); return { updates: [], sync_buf: 'buf2' } })

    const order: string[] = []
    const handle = startLongPollLoops({
      accounts: [baseAcct],
      onInbound: async () => { order.push('inbound') },
      ilink: { getUpdates },
      parse: (us, deps) => parseUpdates(us, deps),
      resolveUserName: () => undefined,
      onSyncBuf: () => { order.push('persist') },
    })
    await new Promise(r => setTimeout(r, 30))
    expect(order[0]).toBe('inbound')
    expect(order.indexOf('persist')).toBeGreaterThan(order.indexOf('inbound'))
    await handle.stop()
  })

  it('does not re-persist an unchanged syncBuf on idle polls', async () => {
    const getUpdates = vi.fn()
      .mockResolvedValueOnce({ updates: [], sync_buf: 'buf2' })
      .mockImplementation(async () => { await new Promise(r => setTimeout(r, 10)); return { updates: [], sync_buf: 'buf2' } })

    const persisted: string[] = []
    const handle = startLongPollLoops({
      accounts: [baseAcct],
      onInbound: async () => {},
      ilink: { getUpdates },
      parse: () => [],
      resolveUserName: () => undefined,
      onSyncBuf: (_id, buf) => { persisted.push(buf) },
    })
    await new Promise(r => setTimeout(r, 60))
    expect(persisted).toEqual(['buf2'])  // only the first change, not every idle poll
    await handle.stop()
  })

  it('stops cleanly when stop() is called mid-loop', async () => {
    const getUpdates = vi.fn().mockImplementation(async () =>
      new Promise(r => setTimeout(() => r({ updates: [], sync_buf: '' }), 20)),
    )
    const handle = startLongPollLoops({
      accounts: [baseAcct],
      onInbound: async () => {},
      ilink: { getUpdates },
      parse: () => [],
      resolveUserName: () => undefined,
    })
    await new Promise(r => setTimeout(r, 10))
    const start = Date.now()
    await handle.stop()
    expect(Date.now() - start).toBeLessThan(1000)  // resolves promptly
  })
})
