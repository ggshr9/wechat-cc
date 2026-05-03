/**
 * Lifecycle dep builder — 6 lifecycle deps (companion×2, guard, sessions, ilink, polling) + startup.
 * Pure field mapping, no business logic.
 */
import type { Db } from '../../lib/db'
import type { IlinkAdapter, IlinkAccount } from '../ilink-glue'
import type { Bootstrap } from '../bootstrap'
import type { CompanionPushDeps, CompanionIntrospectDeps } from '../companion/lifecycle'
import type { SchedulerDeps } from '../guard/scheduler'
import type { SessionsLifecycleDeps } from '../sessions-lifecycle'
import type { IlinkLifecycleDeps } from '../ilink-lifecycle'
import type { PollingDeps } from '../polling-lifecycle'
import type { StartupSweepDeps } from '../startup-sweeps'
import { loadCompanionConfig } from '../companion/config'
import { loadGuardConfig } from '../guard/store'
import { parseUpdates } from '../poll-loop'
import type { TickBodies } from './tick-bodies'

export interface LifecycleDepsOpts {
  stateDir: string
  db: Db
  ilink: IlinkAdapter
  accounts: IlinkAccount[]
  boot: Bootstrap
  dangerously: boolean
  log: (tag: string, line: string, fields?: Record<string, unknown>) => void
}

export function buildLifecycleDeps(opts: LifecycleDepsOpts, ticks: TickBodies): {
  companionPushDeps: CompanionPushDeps
  companionIntrospectDeps: CompanionIntrospectDeps
  guardDeps: SchedulerDeps
  sessionsDeps: SessionsLifecycleDeps
  ilinkDeps: IlinkLifecycleDeps
  pollingDeps: Omit<PollingDeps, 'runPipeline'>
  startupDeps: StartupSweepDeps
} {
  const { stateDir, db, ilink, accounts, boot, dangerously, log } = opts

  const isSnoozed = () => {
    const s = loadCompanionConfig(stateDir).snooze_until
    return !!s && Date.parse(s) > Date.now()
  }
  const isEnabled = () => loadCompanionConfig(stateDir).enabled

  return {
    companionPushDeps: { isEnabled, isSnoozed, log, onTick: ticks.pushTick },
    companionIntrospectDeps: { isEnabled, isSnoozed, log, onTick: ticks.introspectTick },
    guardDeps: {
      pollMs: 30_000,
      isEnabled: () => loadGuardConfig(stateDir).enabled,
      probeUrl: () => loadGuardConfig(stateDir).probe_url,
      ipifyUrl: () => loadGuardConfig(stateDir).ipify_url,
      log,
      onStateChange: async (prev, next) => {
        if (prev.reachable && !next.reachable) {
          log('GUARD', `network DOWN — shutting down all sessions (was ${prev.ip}, now ${next.ip})`)
          await boot.sessionManager.shutdown()
        }
      },
    },
    sessionsDeps: {
      sessionManager: boot.sessionManager,
      sessionStore: boot.sessionStore,
      conversationStore: boot.conversationStore,
    },
    ilinkDeps: { ilink: { flush: () => ilink.flush() } },
    pollingDeps: {
      stateDir,
      accounts,
      ilink: {
        getUpdates: (id, base, tok, sb) =>
          ilink.getUpdatesForLoop(id, base, tok, sb ?? '') as ReturnType<PollingDeps['ilink']['getUpdates']>,
      },
      parse: parseUpdates,
      resolveUserName: (cid) => ilink.resolveUserName(cid),
      log,
    },
    startupDeps: {
      stateDir, db, ilink, log,
      accountCount: accounts.length,
      dangerously,
      runIntrospectOnce: ticks.introspectTick,
    },
  }
}
