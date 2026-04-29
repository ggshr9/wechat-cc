/**
 * Companion v2 scheduler — dead-simple periodic tick.
 *
 * Replaces the v1 croner-based per-trigger scheduler. No more per-trigger
 * logic; no more isolated eval sessions. We only provide what Claude can't:
 * a timer that wakes it up.
 *
 * On every tick (when enabled + not snoozed), `onTick` is called. The
 * supplied onTick typically dispatches a synthetic "companion_tick" user
 * message into the current project's session; Claude reads memory/ +
 * current time context and decides whether to push.
 */

export interface CompanionSchedulerDeps {
  /** Base interval between ticks (e.g. 20 * 60_000 for 20 min). */
  intervalMs: number
  /** Fraction of intervalMs used as ± jitter (e.g. 0.3 → ±30%). */
  jitterRatio: number
  /** Is proactive tick allowed? Checked on every tick (cheap). */
  isEnabled: () => boolean
  /** Is proactive tick suppressed right now? (user said "别烦我") */
  isSnoozed: () => boolean
  /** Wake Claude up. Exceptions are swallowed + logged. */
  onTick: () => Promise<void>
  log: (tag: string, line: string) => void
  /** Optional name for log disambiguation (e.g. 'push', 'introspect'). */
  name?: string
}

export function startCompanionScheduler(deps: CompanionSchedulerDeps): () => Promise<void> {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null

  function scheduleNext(): void {
    if (stopped) return
    const jitter = deps.intervalMs * deps.jitterRatio
    // 100 ms floor protects against pathological tiny intervals; real usage
    // sits in the minutes range so this is effectively a no-op in production.
    const wait = Math.max(100, deps.intervalMs + (Math.random() * 2 - 1) * jitter)
    timer = setTimeout(async () => {
      timer = null
      if (stopped) return
      try {
        if (deps.isEnabled() && !deps.isSnoozed()) {
          await deps.onTick()
        }
      } catch (err) {
        deps.log('SCHED', `${deps.name ?? 'companion'} tick failed: ${err instanceof Error ? err.message : String(err)}`)
      }
      scheduleNext()
    }, wait)
  }

  scheduleNext()
  deps.log('SCHED', `${deps.name ?? 'companion'} scheduler started — interval ${deps.intervalMs}ms ± ${Math.round(deps.jitterRatio * 100)}%`)

  return async () => {
    stopped = true
    if (timer) { clearTimeout(timer); timer = null }
  }
}
