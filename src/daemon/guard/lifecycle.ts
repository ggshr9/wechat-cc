import type { Lifecycle } from '../../lib/lifecycle'
import { startGuardScheduler, type SchedulerDeps, type GuardState } from './scheduler'

export interface GuardLifecycle extends Lifecycle {
  current(): GuardState
}

export function registerGuard(deps: SchedulerDeps): GuardLifecycle {
  const handle = startGuardScheduler(deps)
  return {
    name: 'guard',
    stop: () => handle.stop(),
    current: () => handle.current(),
  }
}
