import type { Lifecycle } from '../../lib/lifecycle'
import { startGuardScheduler, type SchedulerDeps, type GuardState } from './scheduler'

export interface GuardLifecycle extends Lifecycle {
  current(): GuardState
}

export function registerGuard(deps: SchedulerDeps): GuardLifecycle {
  const handle = startGuardScheduler(deps)
  let stopped = false
  return {
    name: 'guard',
    stop: async () => { if (!stopped) { stopped = true; await handle.stop() } },
    current: () => handle.current(),
  }
}
