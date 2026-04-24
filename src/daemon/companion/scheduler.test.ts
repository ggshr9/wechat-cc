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
      isEnabled: () => true,
      isSnoozed: () => false,
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
      isEnabled: () => false, isSnoozed: () => false,
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
      isEnabled: () => true, isSnoozed: () => true,
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
      isEnabled: () => true, isSnoozed: () => false,
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
      isEnabled: () => true, isSnoozed: () => false,
      onTick, log: () => {},
    })
    await stop()
    await vi.advanceTimersByTimeAsync(5000)
    expect(onTick).not.toHaveBeenCalled()
  })
})
