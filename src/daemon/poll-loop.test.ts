import { describe, it, expect, vi } from 'vitest'
import { parseUpdates, startLongPollLoops, type RawUpdate } from './poll-loop'
import type { Account } from './ilink-glue'

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
