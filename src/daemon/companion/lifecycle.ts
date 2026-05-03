import type { Lifecycle } from '../../lib/lifecycle'
import { startCompanionScheduler } from './scheduler'

export interface CompanionPushDeps {
  isEnabled(): boolean
  isSnoozed(): boolean
  log: (tag: string, line: string) => void
  onTick(): Promise<void>
}

const PUSH_INTERVAL_MS = 20 * 60 * 1000
const INTROSPECT_INTERVAL_MS = 24 * 60 * 60 * 1000
const JITTER = 0.3

export function registerCompanionPush(deps: CompanionPushDeps): Lifecycle {
  const stop = startCompanionScheduler({
    name: 'push',
    intervalMs: PUSH_INTERVAL_MS,
    jitterRatio: JITTER,
    isEnabled: deps.isEnabled,
    isSnoozed: deps.isSnoozed,
    log: deps.log,
    onTick: deps.onTick,
  })
  let stopped = false
  return {
    name: 'companion-push',
    stop: async () => { if (!stopped) { stopped = true; await stop() } },
  }
}

export interface CompanionIntrospectDeps extends CompanionPushDeps {}

export function registerCompanionIntrospect(deps: CompanionIntrospectDeps): Lifecycle {
  const stop = startCompanionScheduler({
    name: 'introspect',
    intervalMs: INTROSPECT_INTERVAL_MS,
    jitterRatio: JITTER,
    isEnabled: deps.isEnabled,
    isSnoozed: deps.isSnoozed,
    log: deps.log,
    onTick: deps.onTick,
  })
  let stopped = false
  return {
    name: 'companion-introspect',
    stop: async () => { if (!stopped) { stopped = true; await stop() } },
  }
}
