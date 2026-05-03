/**
 * Standard shape every register*(deps) function returns.
 * stop MUST be idempotent — main.ts shutdown may call it multiple times
 * if a SIGTERM lands during graceful SIGINT handling.
 */
export interface Lifecycle {
  readonly name: string
  stop(): Promise<void>
}

export class LifecycleStopError extends Error {
  constructor(
    public readonly failed: number,
    public readonly total: number,
    public readonly details: Array<{ name: string; err: unknown }>,
  ) {
    super(`${failed}/${total} lifecycle handles failed to stop cleanly`)
    this.name = 'LifecycleStopError'
  }
}

/**
 * Aggregates a set of Lifecycle handles. Stops them in REVERSE registration
 * order (LIFO) — sequential, not concurrent. 5s per-handle timeout. One
 * failure does NOT abort subsequent stops.
 */
export class LifecycleSet {
  constructor(private readonly log: (tag: string, line: string) => void) {}
  private readonly handles: Lifecycle[] = []

  register(handle: Lifecycle): void { this.handles.push(handle) }

  stopAll(): Promise<void> {
    const result = this._stopAll()
    // Pre-attach a no-op rejection handler so Node.js does not fire
    // `unhandledRejection` during the async gap between when `result` settles
    // (e.g. under fake timers) and when the caller attaches its own handler.
    // The caller still receives the rejection because it holds the same promise.
    result.catch(() => {})
    return result
  }

  private async _stopAll(): Promise<void> {
    const ordered = [...this.handles].reverse()
    const failures: Array<{ name: string; err: unknown }> = []
    for (const h of ordered) {
      const t0 = Date.now()
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new Error('stop timeout (5000ms)')), 5000)
      })
      try {
        await Promise.race([h.stop(), timeout])
        this.log('LIFECYCLE', `stopped ${h.name} (${Date.now() - t0}ms)`)
      } catch (err) {
        this.log('LIFECYCLE', `stop ${h.name} failed (${Date.now() - t0}ms): ${
          err instanceof Error ? err.message : err
        }`)
        failures.push({ name: h.name, err })
      } finally {
        if (timer) clearTimeout(timer)
      }
    }
    if (failures.length > 0) {
      throw new LifecycleStopError(failures.length, this.handles.length, failures)
    }
  }
}
