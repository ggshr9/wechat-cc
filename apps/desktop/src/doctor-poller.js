// @ts-check
/** @typedef {import('../../../src/cli/schema').DoctorOutputT} DoctorReport */

// doctor-poller.js — single ownership of the `wechat-cc doctor --json`
// lifecycle. Replaces the previous pattern in main.js where five+ call
// sites independently invoked `loadDoctor()` and wrote `state.doctor`,
// racing each other and producing intermediate-state UI flicker.
//
// Contract:
//   - createDoctorPoller({ invoke, intervalMs }) returns a controller
//   - .start() begins ticking + does an immediate refresh
//   - .stop()  clears the tick timer
//   - .refresh() invokes once; concurrent .refresh() calls share the
//                same in-flight promise (deduped)
//   - .subscribe(cb) — cb fires for every successful poll AND immediately
//                if a previous report is cached. Returns unsubscribe.
//   - .current — last good report (null until first successful poll)
//   - .lastError — last invoke error (null after a successful poll)
//   - .waitForCondition(predicate, timeoutMs, pollIntervalMs) — polls
//     until predicate(report) returns truthy or timeout. Used by the
//     wizard's "wait for daemon to come up after install" flow.
//
// No DOM dependencies — testable from vitest with a fake `invoke`.

/**
 * @param {{ invoke: (cmd: string, args: { args: string[] }) => Promise<unknown>, intervalMs?: number }} opts
 */
export function createDoctorPoller({ invoke, intervalMs = 5000 }) {
  /** @type {DoctorReport | null} */
  let lastReport = null
  /** @type {unknown} */
  let lastError = null
  /** @type {Set<(report: DoctorReport) => void>} */
  const subscribers = new Set()
  /** @type {ReturnType<typeof setInterval> | null} */
  let timer = null
  /** @type {Promise<DoctorReport | null> | null} */
  let inflight = null

  /** @param {DoctorReport} report */
  function notify(report) {
    // Snapshot subscribers — a callback that unsubscribes during dispatch
    // shouldn't skip the next callback in the iteration.
    const snapshot = Array.from(subscribers)
    for (const cb of snapshot) {
      try { cb(report) } catch (err) { console.error('doctor subscriber threw', err) }
    }
  }

  // NOTE: not async — returning the in-flight promise directly preserves
  // identity for concurrent callers (so `refresh() === refresh()` while
  // a fetch is in progress, which is the dedup contract).
  function refresh() {
    if (inflight) return inflight
    inflight = (async () => {
      try {
        const report = /** @type {DoctorReport} */ (await invoke("wechat_cli_json", { args: ["doctor", "--json"] }))
        lastReport = report
        lastError = null
        notify(report)
        return report
      } catch (err) {
        lastError = err
        // Subscribers don't see errors — they keep getting the last good
        // report. UI components that care about staleness check .lastError.
        return null
      } finally {
        inflight = null
      }
    })()
    return inflight
  }

  /**
   * @param {(report: DoctorReport) => boolean} predicate
   * @param {number} [timeoutMs]
   * @param {number} [pollIntervalMs]
   */
  async function waitForCondition(predicate, timeoutMs = 8000, pollIntervalMs = 500) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const report = await refresh()
      if (report && predicate(report)) return report
      await new Promise(r => setTimeout(r, pollIntervalMs))
    }
    return lastReport
  }

  return {
    start() {
      if (timer) return
      timer = setInterval(() => { refresh() }, intervalMs)
      refresh()  // immediate first tick
    },
    stop() {
      if (timer) { clearInterval(timer); timer = null }
    },
    refresh,
    /** @param {(report: DoctorReport) => void} cb */
    subscribe(cb) {
      subscribers.add(cb)
      // Replay cached report so late subscribers don't wait a full tick.
      if (lastReport) {
        try { cb(lastReport) } catch (err) { console.error('doctor subscriber threw', err) }
      }
      return () => subscribers.delete(cb)
    },
    get current() { return lastReport },
    get lastError() { return lastError },
    waitForCondition,
  }
}
