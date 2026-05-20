import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { startCompanionScheduler } from './scheduler'

describe('startCompanionScheduler', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('fires onTick when enabled + not snoozed', async () => {
    const onTick = vi.fn().mockResolvedValue(undefined)
    const stop = startCompanionScheduler({
      intervalMs: 1000,
      jitterRatio: 0,
      shouldRun: () => true,
      onTick,
      log: () => {},
    })
    await vi.advanceTimersByTimeAsync(1100)
    expect(onTick).toHaveBeenCalled()
    await stop()
  })

  it('does not fire when disabled', async () => {
    const onTick = vi.fn()
    const stop = startCompanionScheduler({
      intervalMs: 1000, jitterRatio: 0,
      shouldRun: () => false,
      onTick, log: () => {},
    })
    await vi.advanceTimersByTimeAsync(1100)
    expect(onTick).not.toHaveBeenCalled()
    await stop()
  })

  it('does not fire when snoozed', async () => {
    const onTick = vi.fn()
    const stop = startCompanionScheduler({
      intervalMs: 1000, jitterRatio: 0,
      shouldRun: () => false,
      onTick, log: () => {},
    })
    await vi.advanceTimersByTimeAsync(1100)
    expect(onTick).not.toHaveBeenCalled()
    await stop()
  })

  it('keeps scheduling after exceptions', async () => {
    const onTick = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(undefined)
    const log = vi.fn()
    const stop = startCompanionScheduler({
      intervalMs: 1000, jitterRatio: 0,
      shouldRun: () => true,
      onTick, log,
    })
    await vi.advanceTimersByTimeAsync(1100)
    expect(onTick).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith('SCHED', expect.stringContaining('boom'))
    await vi.advanceTimersByTimeAsync(1100)
    expect(onTick).toHaveBeenCalledTimes(2)
    await stop()
  })

  it('stop() halts future ticks', async () => {
    const onTick = vi.fn()
    const stop = startCompanionScheduler({
      intervalMs: 1000, jitterRatio: 0,
      shouldRun: () => true,
      onTick, log: () => {},
    })
    await stop()
    await vi.advanceTimersByTimeAsync(5000)
    expect(onTick).not.toHaveBeenCalled()
  })

  it('uses name in startup log when provided', async () => {
    const logs: string[] = []
    const stop = startCompanionScheduler({
      intervalMs: 1000, jitterRatio: 0,
      shouldRun: () => false,
      onTick: async () => {},
      log: (tag, line) => logs.push(`${tag} ${line}`),
      name: 'push',
    })
    expect(logs.some(l => l.includes('push scheduler started'))).toBe(true)
    await stop()
  })

  it('calls shouldRun exactly once per tick (atomic gate, not two separate reads)', async () => {
    // Pre-PR D the scheduler called both isEnabled() and isSnoozed() per
    // tick — two separate config reads with a race window between them
    // where `开启 companion` + `别烦我` arriving in sequence could be
    // misread. With one merged gate the scheduler hits it once per tick.
    const shouldRun = vi.fn(() => true)
    const stop = startCompanionScheduler({
      intervalMs: 1000, jitterRatio: 0,
      shouldRun,
      onTick: async () => {},
      log: () => {},
    })
    await vi.advanceTimersByTimeAsync(1100)
    expect(shouldRun).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1100)
    expect(shouldRun).toHaveBeenCalledTimes(2)
    await stop()
  })

  it('falls back to "companion" when no name provided', async () => {
    const logs: string[] = []
    const stop = startCompanionScheduler({
      intervalMs: 1000, jitterRatio: 0,
      shouldRun: () => false,
      onTick: async () => {},
      log: (tag, line) => logs.push(`${tag} ${line}`),
    })
    expect(logs.some(l => l.includes('companion scheduler started'))).toBe(true)
    await stop()
  })
})
