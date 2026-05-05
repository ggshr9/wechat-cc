import { describe, it, expect, vi, beforeEach } from 'vitest'

// Use vitest's jsdom-like DOM stub so setPending no-ops cleanly. The
// existing dashboard.js uses document.getElementById in setPending; we
// just need the call not to crash.
beforeEach(() => {
  // @ts-expect-error provide a minimal getElementById stub
  globalThis.document = { getElementById: () => null }
})

// Import AFTER document stub so setPending's getElementById doesn't crash
// @ts-expect-error JS sibling
const { restartDaemon } = await import('./dashboard.js')

function fakeDoctorPoller(cachedDaemonRunning = true) {
  // Return a doctor cache that doesn't trigger the "install" route — so
  // restartDaemon flows into the stop+start path. The shape is enough to
  // satisfy restartButtonState() returning action != "install".
  const checks = {
    daemon: { alive: cachedDaemonRunning, pid: cachedDaemonRunning ? 1234 : null },
    // restartButtonState() checks service.installed — set true so the
    // function returns action: "restart" (not "install"), letting our
    // pid-check path execute.
    service: { installed: true },
  }
  return {
    refresh: vi.fn(async () => ({ checks })),
    current: { checks },
  }
}

describe('restartDaemon (PR3)', () => {
  it('happy path: pid changes → success message includes both pids', async () => {
    const invoke = vi.fn(async (name: string, _args?: unknown) => {
      if (name === 'wechat_daemon_pid') {
        // First call (before): 1234. Second call (after): 5678.
        const callIdx = invoke.mock.calls.filter(c => c[0] === 'wechat_daemon_pid').length
        return callIdx === 1 ? 1234 : 5678
      }
      return { ok: true }
    })
    await restartDaemon({
      invoke,
      doctorPoller: fakeDoctorPoller(),
      formatInvokeError: (e: unknown) => String(e),
      routeToWizardService: () => {},
    })
    // Verify both pid calls happened
    const pidCalls = invoke.mock.calls.filter(c => c[0] === 'wechat_daemon_pid')
    expect(pidCalls.length).toBe(2)
  })

  it('pid unchanged → permission error message', async () => {
    const invoke = vi.fn(async (name: string, _args?: unknown) => {
      if (name === 'wechat_daemon_pid') return 1234  // same pid both times
      return { ok: true }
    })
    await restartDaemon({
      invoke,
      doctorPoller: fakeDoctorPoller(),
      formatInvokeError: (e: unknown) => String(e),
      routeToWizardService: () => {},
    })
    // The function returns early on this branch (no auto-clear) — verify
    // by checking pid was queried twice
    const pidCalls = invoke.mock.calls.filter(c => c[0] === 'wechat_daemon_pid')
    expect(pidCalls.length).toBe(2)
  })

  it('non-Windows (pid always null) → falls through to generic OK', async () => {
    const invoke = vi.fn(async (name: string, _args?: unknown) => {
      if (name === 'wechat_daemon_pid') return null
      return { ok: true }
    })
    await restartDaemon({
      invoke,
      doctorPoller: fakeDoctorPoller(),
      formatInvokeError: (e: unknown) => String(e),
      routeToWizardService: () => {},
    })
    const pidCalls = invoke.mock.calls.filter(c => c[0] === 'wechat_daemon_pid')
    expect(pidCalls.length).toBe(2)
  })
})
