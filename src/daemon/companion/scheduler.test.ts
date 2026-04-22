import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { startScheduler, type SchedulerDeps, type EvalResult } from './scheduler'
import type { CompanionConfig, Trigger } from './config'

function baseCfg(overrides: Partial<CompanionConfig> = {}): CompanionConfig {
  return {
    enabled: true,
    timezone: 'Asia/Shanghai',
    per_project_persona: { P: 'assistant', _default: 'assistant' },
    default_chat_id: 'c',
    snooze_until: null,
    triggers: [],
    ...overrides,
  }
}

function mkTrigger(over: Partial<Trigger> = {}): Trigger {
  return {
    id: 't1',
    project: 'P',
    schedule: '* * * * *',  // every minute
    task: 'do X',
    personas: [],
    on_failure: 'silent',
    created_at: '2026-04-22T00:00:00Z',
    ...over,
  }
}

const fakeNow = new Date('2026-04-22T10:00:00+08:00')

describe('scheduler', () => {
  beforeEach(() => { vi.useFakeTimers({ now: fakeNow }) })
  afterEach(() => { vi.useRealTimers() })

  it('does not evaluate when config.enabled=false', async () => {
    const evalTrigger = vi.fn()
    const stop = startScheduler({
      loadConfig: () => baseCfg({ enabled: false, triggers: [mkTrigger()] }),
      runs: { append: vi.fn(), rotate: vi.fn() },
      pushes: { append: vi.fn(), rotate: vi.fn() },
      evalTrigger,
      now: () => fakeNow,
    }, () => {})
    await vi.advanceTimersByTimeAsync(60_000)
    expect(evalTrigger).not.toHaveBeenCalled()
    await stop()
  })

  it('does not evaluate when schedule does not match current minute', async () => {
    const evalTrigger = vi.fn().mockResolvedValue({
      pushed: false, cost_usd: 0, tool_uses_count: 0, duration_ms: 0,
    } satisfies EvalResult)
    const cfg = baseCfg({
      triggers: [mkTrigger({ schedule: '0 * * * *' })],  // top-of-hour only
    })
    // fakeNow = 10:00 Shanghai — top of hour matches! Use 10:30 to miss.
    const tenThirty = new Date('2026-04-22T10:30:00+08:00')
    const stop = startScheduler({
      loadConfig: () => cfg,
      runs: { append: vi.fn(), rotate: vi.fn() },
      pushes: { append: vi.fn(), rotate: vi.fn() },
      evalTrigger,
      now: () => tenThirty,
    }, () => {})
    await vi.advanceTimersByTimeAsync(60_000)
    expect(evalTrigger).not.toHaveBeenCalled()
    await stop()
  })

  it('fires evalTrigger when schedule matches', async () => {
    const evalTrigger = vi.fn().mockResolvedValue({
      pushed: false, cost_usd: 0, tool_uses_count: 0, duration_ms: 50,
    } satisfies EvalResult)
    const runsAppend = vi.fn()
    const stop = startScheduler({
      loadConfig: () => baseCfg({ triggers: [mkTrigger()] }),
      runs: { append: runsAppend, rotate: vi.fn() },
      pushes: { append: vi.fn(), rotate: vi.fn() },
      evalTrigger,
      now: () => fakeNow,
    }, () => {})
    await vi.advanceTimersByTimeAsync(60_000)
    await Promise.resolve()
    await Promise.resolve()
    expect(evalTrigger).toHaveBeenCalled()
    expect(runsAppend).toHaveBeenCalled()
    const entry = runsAppend.mock.calls[0]?.[0]
    expect(entry?.trigger_id).toBe('t1')
    expect(entry?.pushed).toBe(false)
    await stop()
  })

  it('when evalTrigger returns pushed=true, appends to push log too', async () => {
    const pushesAppend = vi.fn()
    const stop = startScheduler({
      loadConfig: () => baseCfg({ triggers: [mkTrigger()] }),
      runs: { append: vi.fn(), rotate: vi.fn() },
      pushes: { append: pushesAppend, rotate: vi.fn() },
      evalTrigger: vi.fn().mockResolvedValue({
        pushed: true, message: 'hello', cost_usd: 0.01, tool_uses_count: 1, duration_ms: 100,
      } satisfies EvalResult),
      now: () => fakeNow,
    }, () => {})
    await vi.advanceTimersByTimeAsync(60_000)
    await Promise.resolve()
    await Promise.resolve()
    expect(pushesAppend).toHaveBeenCalled()
    const entry = pushesAppend.mock.calls[0]?.[0]
    expect(entry?.message).toBe('hello')
    expect(entry?.chat_id).toBe('c')
    await stop()
  })

  it('skips trigger when current persona not in trigger.personas[]', async () => {
    const evalTrigger = vi.fn()
    const stop = startScheduler({
      loadConfig: () => baseCfg({
        per_project_persona: { P: 'companion' },
        triggers: [mkTrigger({ personas: ['assistant'] })],
      }),
      runs: { append: vi.fn(), rotate: vi.fn() },
      pushes: { append: vi.fn(), rotate: vi.fn() },
      evalTrigger,
      now: () => fakeNow,
    }, () => {})
    await vi.advanceTimersByTimeAsync(60_000)
    expect(evalTrigger).not.toHaveBeenCalled()
    await stop()
  })

  it('skips when snooze_until is in the future', async () => {
    const evalTrigger = vi.fn()
    const future = new Date(fakeNow.getTime() + 60 * 60 * 1000).toISOString()
    const stop = startScheduler({
      loadConfig: () => baseCfg({ snooze_until: future, triggers: [mkTrigger()] }),
      runs: { append: vi.fn(), rotate: vi.fn() },
      pushes: { append: vi.fn(), rotate: vi.fn() },
      evalTrigger,
      now: () => fakeNow,
    }, () => {})
    await vi.advanceTimersByTimeAsync(60_000)
    expect(evalTrigger).not.toHaveBeenCalled()
    await stop()
  })

  it('respects trigger.paused_until when in future', async () => {
    const evalTrigger = vi.fn()
    const future = new Date(fakeNow.getTime() + 60 * 60 * 1000).toISOString()
    const stop = startScheduler({
      loadConfig: () => baseCfg({
        triggers: [mkTrigger({ paused_until: future })],
      }),
      runs: { append: vi.fn(), rotate: vi.fn() },
      pushes: { append: vi.fn(), rotate: vi.fn() },
      evalTrigger,
      now: () => fakeNow,
    }, () => {})
    await vi.advanceTimersByTimeAsync(60_000)
    expect(evalTrigger).not.toHaveBeenCalled()
    await stop()
  })

  it('stop() prevents further ticks', async () => {
    const evalTrigger = vi.fn().mockResolvedValue({
      pushed: false, cost_usd: 0, tool_uses_count: 0, duration_ms: 0,
    } satisfies EvalResult)
    const stop = startScheduler({
      loadConfig: () => baseCfg({ triggers: [mkTrigger()] }),
      runs: { append: vi.fn(), rotate: vi.fn() },
      pushes: { append: vi.fn(), rotate: vi.fn() },
      evalTrigger,
      now: () => fakeNow,
    }, () => {})
    await stop()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(evalTrigger).not.toHaveBeenCalled()
  })
})
