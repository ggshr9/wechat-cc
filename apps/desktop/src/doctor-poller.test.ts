import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
// @ts-expect-error — vanilla JS sibling module; covered at runtime.
import { createDoctorPoller } from './doctor-poller.js'

beforeEach(() => { vi.useRealTimers() })
afterEach(() => { vi.useRealTimers() })

describe('createDoctorPoller', () => {
  it('refresh() invokes "doctor --json" exactly once and notifies subscribers', async () => {
    const invoke = vi.fn().mockResolvedValue({ ready: true })
    const poller = createDoctorPoller({ invoke, intervalMs: 60_000 })
    const sub = vi.fn()
    poller.subscribe(sub)
    await poller.refresh()
    expect(invoke).toHaveBeenCalledOnce()
    expect(invoke).toHaveBeenCalledWith('wechat_cli_json', { args: ['doctor', '--json'] })
    expect(sub).toHaveBeenCalledWith({ ready: true })
    expect(poller.current).toEqual({ ready: true })
    expect(poller.lastError).toBe(null)
  })

  it('concurrent refresh() calls share one in-flight promise', async () => {
    let resolveInner: (v: unknown) => void = () => {}
    const invoke = vi.fn(() => new Promise(r => { resolveInner = r }))
    const poller = createDoctorPoller({ invoke, intervalMs: 60_000 })
    const p1 = poller.refresh()
    const p2 = poller.refresh()
    expect(p1).toBe(p2)
    expect(invoke).toHaveBeenCalledOnce()
    resolveInner({ ready: true })
    await p1
  })

  it('subscribe() replays the cached report immediately', async () => {
    const invoke = vi.fn().mockResolvedValue({ ready: true })
    const poller = createDoctorPoller({ invoke, intervalMs: 60_000 })
    await poller.refresh()
    const lateSub = vi.fn()
    poller.subscribe(lateSub)
    expect(lateSub).toHaveBeenCalledWith({ ready: true })
  })

  it('unsubscribe stops further notifications', async () => {
    const invoke = vi.fn().mockResolvedValue({ ready: true })
    const poller = createDoctorPoller({ invoke, intervalMs: 60_000 })
    const sub = vi.fn()
    const unsub = poller.subscribe(sub)
    await poller.refresh()
    sub.mockClear()
    unsub()
    await poller.refresh()
    expect(sub).not.toHaveBeenCalled()
  })

  it('subscriber that throws does not break notification of others', async () => {
    const invoke = vi.fn().mockResolvedValue({ ready: true })
    const poller = createDoctorPoller({ invoke, intervalMs: 60_000 })
    const goodSub = vi.fn()
    poller.subscribe(() => { throw new Error('crash') })
    poller.subscribe(goodSub)
    // suppress console.error noise from the deliberately-throwing subscriber
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await poller.refresh()
    expect(goodSub).toHaveBeenCalledWith({ ready: true })
    errSpy.mockRestore()
  })

  it('invoke error is captured in lastError; current report stays last-good', async () => {
    const invoke = vi.fn()
      .mockResolvedValueOnce({ ready: true })
      .mockRejectedValueOnce(new Error('boom'))
    const poller = createDoctorPoller({ invoke, intervalMs: 60_000 })
    await poller.refresh()
    await poller.refresh()
    expect(poller.current).toEqual({ ready: true })
    expect((poller.lastError as Error)?.message).toBe('boom')
  })

  it('successful poll after error clears lastError', async () => {
    const invoke = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ ready: true })
    const poller = createDoctorPoller({ invoke, intervalMs: 60_000 })
    await poller.refresh()
    expect(poller.lastError).toBeInstanceOf(Error)
    await poller.refresh()
    expect(poller.lastError).toBe(null)
    expect(poller.current).toEqual({ ready: true })
  })

  it('start() does an immediate refresh then ticks at intervalMs', async () => {
    vi.useFakeTimers()
    const invoke = vi.fn().mockResolvedValue({ ready: true })
    const poller = createDoctorPoller({ invoke, intervalMs: 1000 })
    poller.start()
    // immediate refresh (synchronous schedule, microtask)
    await Promise.resolve()
    await Promise.resolve()
    expect(invoke).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1000)
    await Promise.resolve()
    expect(invoke).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(1000)
    await Promise.resolve()
    expect(invoke).toHaveBeenCalledTimes(3)
    poller.stop()
    vi.advanceTimersByTime(5000)
    expect(invoke).toHaveBeenCalledTimes(3)  // no further ticks
  })

  it('start() is idempotent — second call does not double-schedule', async () => {
    vi.useFakeTimers()
    const invoke = vi.fn().mockResolvedValue({ ready: true })
    const poller = createDoctorPoller({ invoke, intervalMs: 1000 })
    poller.start()
    poller.start()
    await Promise.resolve()
    vi.advanceTimersByTime(1000)
    await Promise.resolve()
    // Immediate + 1 tick = 2 invokes (not 4 from a doubled timer).
    expect(invoke).toHaveBeenCalledTimes(2)
    poller.stop()
  })

  it('waitForCondition resolves on the first poll where predicate matches', async () => {
    const reports = [
      { checks: { daemon: { alive: false } } },
      { checks: { daemon: { alive: false } } },
      { checks: { daemon: { alive: true } } },
    ]
    const invoke = vi.fn().mockImplementation(() => Promise.resolve(reports.shift()))
    const poller = createDoctorPoller({ invoke, intervalMs: 60_000 })
    // Use very short pollIntervalMs so the test runs in real time without
    // needing fake timers (waitForCondition mixes setTimeout with refreshes
    // and works cleanly with real timers).
    const result = await poller.waitForCondition(
      (r: { checks: { daemon: { alive: boolean } } }) => r.checks.daemon.alive,
      5000,
      5,
    )
    expect(result.checks.daemon.alive).toBe(true)
  })

  it('waitForCondition returns last report on timeout', async () => {
    const invoke = vi.fn().mockResolvedValue({ checks: { daemon: { alive: false } } })
    const poller = createDoctorPoller({ invoke, intervalMs: 60_000 })
    const result = await poller.waitForCondition(
      (r: { checks: { daemon: { alive: boolean } } }) => r.checks.daemon.alive,
      50,
      10,
    )
    expect(result.checks.daemon.alive).toBe(false)
  })
})
