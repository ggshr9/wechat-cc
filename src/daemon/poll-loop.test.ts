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

  it('preserves quoteTo when ref_msg is present in an item', () => {
    const raw: RawUpdate[] = [{
      from_user_id: 'u',
      create_time_ms: 1000,
      message_type: 1,
      message_state: 2,
      item_list: [
        { type: 1, msg_id: 'prev-1', ref_msg: { title: 'quoted text' } },
        { type: 1, text_item: { text: 'this' } },
      ],
    }]
    const [msg] = parseUpdates(raw, { accountId: 'A', resolveUserName: () => undefined })
    expect(msg!.quoteTo).toBe('prev-1')
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

    const stop = startLongPollLoops({
      accounts: [baseAcct],
      onInbound,
      ilink: { getUpdates },
      parse: (us, deps) => parseUpdates(us, deps),
      resolveUserName: () => undefined,
    })
    await new Promise(r => setTimeout(r, 30))
    expect(seen).toEqual(['a', 'b'])
    expect(getUpdates).toHaveBeenCalledWith('https://x', 'T', '')
    // second call uses updated syncBuf from first response
    if (getUpdates.mock.calls.length >= 2) {
      expect(getUpdates.mock.calls[1]![2]).toBe('buf2')
    }
    await stop()
  })

  it('swallows getUpdates errors and retries', async () => {
    const getUpdates = vi.fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValue({ updates: [], sync_buf: '' })
    const onInbound = vi.fn()

    const stop = startLongPollLoops({
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
    await stop()
  })

  it('stops cleanly when stop() is called mid-loop', async () => {
    const getUpdates = vi.fn().mockImplementation(async () =>
      new Promise(r => setTimeout(() => r({ updates: [], sync_buf: '' }), 20)),
    )
    const stop = startLongPollLoops({
      accounts: [baseAcct],
      onInbound: async () => {},
      ilink: { getUpdates },
      parse: () => [],
      resolveUserName: () => undefined,
    })
    await new Promise(r => setTimeout(r, 10))
    const start = Date.now()
    await stop()
    expect(Date.now() - start).toBeLessThan(1000)  // resolves promptly
  })
})
