/**
 * Guard scheduler — IP-change-triggered probing.
 *
 *   Every `pollMs` (default 30s):
 *     1. Fetch public IP via ipify.
 *     2. If IP unchanged → no probe; previous reachable state stays.
 *     3. If IP changed (or first poll, or transitioning enabled) →
 *        probe canary URL. Update state. Fire onStateChange iff the
 *        reachable bit flipped.
 *
 * Why IP-triggered (not time-triggered): probing google.com on a fixed
 * cadence is wasteful and potentially noticeable (China firewall logs).
 * Public IP is the real state signal — VPN drops/reconnects always
 * change egress IP. Outside that signal, status is stable.
 *
 * The scheduler is config-aware (calls isEnabled() each tick) so the
 * dashboard toggle takes effect on the next tick — no restart needed.
 */

import { fetchPublicIp, probeReachable } from './probe'

export interface GuardState {
  ip: string | null
  reachable: boolean
  lastChecked: string | null  // ISO timestamp of last probe (NOT IP poll)
  lastError: string | null
}

export function initialState(): GuardState {
  return { ip: null, reachable: true, lastChecked: null, lastError: null }
}

export interface SchedulerDeps {
  pollMs: number
  isEnabled: () => boolean
  probeUrl: () => string
  ipifyUrl: () => string
  fetchPublicIp?: typeof fetchPublicIp        // injectable for tests
  probeReachable?: typeof probeReachable      // injectable for tests
  onStateChange?: (prev: GuardState, next: GuardState) => void | Promise<void>
  log?: (tag: string, msg: string) => void
}

export interface SchedulerHandle {
  current(): GuardState
  /** Force a poll right now (used by CLI `guard status` and tests). */
  pokeNow(): Promise<GuardState>
  stop(): Promise<void>
}

export function startGuardScheduler(deps: SchedulerDeps): SchedulerHandle {
  const log = deps.log ?? (() => {})
  const fIp = deps.fetchPublicIp ?? fetchPublicIp
  const fProbe = deps.probeReachable ?? probeReachable
  let state = initialState()
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null
  // Concurrent calls (auto-tick + pokeNow + a second pokeNow) share one
  // physical poll. Without this, the auto-tick on construction would
  // race against pokeNow() in tests (and against admin CLI in prod).
  let inFlightPromise: Promise<GuardState> | null = null

  async function tick(): Promise<GuardState> {
    if (stopped || !deps.isEnabled()) return state
    if (inFlightPromise) return inFlightPromise
    inFlightPromise = (async () => {
      const ipRes = await fIp({ url: deps.ipifyUrl() })
      const prevIp = state.ip
      const ipChanged = ipRes.ip !== null && ipRes.ip !== prevIp
      // First successful poll after enable / restart counts as a change
      // so we always know reachable status before any inbound arrives.
      const firstPoll = state.lastChecked === null && ipRes.ip !== null
      if (!ipChanged && !firstPoll) return state
      const probe = await fProbe(deps.probeUrl())
      const next: GuardState = {
        ip: ipRes.ip,
        reachable: probe.reachable,
        lastChecked: new Date().toISOString(),
        lastError: probe.error ?? ipRes.error ?? null,
      }
      const flipped = state.reachable !== next.reachable || state.ip !== next.ip
      const prev = state
      state = next
      if (flipped) {
        log('GUARD', `state ip=${prevIp ?? '?'} → ${next.ip ?? '?'} reachable=${prev.reachable} → ${next.reachable}${next.lastError ? ` err=${next.lastError}` : ''}`)
        try { await deps.onStateChange?.(prev, next) }
        catch (err) { log('GUARD', `onStateChange threw: ${err instanceof Error ? err.message : String(err)}`) }
      }
      return next
    })()
    try { return await inFlightPromise }
    finally { inFlightPromise = null }
  }

  function schedule() {
    if (stopped) return
    timer = setTimeout(async () => {
      await tick()
      schedule()
    }, deps.pollMs)
  }

  // Kick off immediately so daemon startup learns its state in <3s.
  // Schedule the recurring tick AFTER the first one resolves so we don't
  // double-fire on slow networks.
  void tick().then(schedule)

  return {
    current: () => state,
    pokeNow: tick,
    async stop() {
      stopped = true
      if (timer) clearTimeout(timer)
    },
  }
}
