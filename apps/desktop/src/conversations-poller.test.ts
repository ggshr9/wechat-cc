import { describe, expect, it, vi } from 'vitest'
// @ts-expect-error — vanilla JS sibling module; covered at runtime.
import { createConversationsPoller } from './conversations-poller.js'

describe('createConversationsPoller', () => {
  it('refresh() invokes "conversations list --json" once and notifies subscribers', async () => {
    const payload = { ok: true, conversations: [{ chat_id: 'c1', user_name: 'A', mode: { kind: 'solo', provider: 'claude' } }] }
    const invoke = vi.fn().mockResolvedValue(payload)
    const p = createConversationsPoller({ invoke, intervalMs: 60_000 })
    const sub = vi.fn()
    p.subscribe(sub)
    await p.refresh()
    expect(invoke).toHaveBeenCalledOnce()
    expect(invoke).toHaveBeenCalledWith('wechat_cli_json', { args: ['conversations', 'list', '--json'] })
    expect(sub).toHaveBeenCalledWith(payload)
    expect(p.current).toEqual(payload)
    expect(p.lastError).toBe(null)
  })

  it('errors do NOT clobber the last good report (subscribers stay quiet)', async () => {
    const good = { ok: true, conversations: [] }
    const invoke = vi.fn()
      .mockResolvedValueOnce(good)
      .mockRejectedValueOnce(new Error('cli down'))
    const p = createConversationsPoller({ invoke, intervalMs: 60_000 })
    const sub = vi.fn()
    p.subscribe(sub)
    await p.refresh()  // good
    sub.mockClear()
    await p.refresh()  // err
    expect(sub).not.toHaveBeenCalled()
    expect(p.current).toEqual(good)
    expect(p.lastError).toBeInstanceOf(Error)
  })

  it('concurrent refresh() calls dedupe to one inflight invoke', async () => {
    let resolveInner: (v: unknown) => void = () => {}
    const invoke = vi.fn(() => new Promise(r => { resolveInner = r }))
    const p = createConversationsPoller({ invoke, intervalMs: 60_000 })
    const a = p.refresh()
    const b = p.refresh()
    expect(a).toBe(b)
    expect(invoke).toHaveBeenCalledOnce()
    resolveInner({ ok: true, conversations: [] })
    await a
  })

  it('start() schedules ticks; stop() cancels them', () => {
    const invoke = vi.fn().mockResolvedValue({ ok: true, conversations: [] })
    const p = createConversationsPoller({ invoke, intervalMs: 60_000 })
    p.start()
    expect(invoke).toHaveBeenCalledOnce()  // immediate first tick
    p.stop()
    // Calling start() again starts a fresh interval — no double-timer leak.
    p.start()
    p.stop()
  })
})
