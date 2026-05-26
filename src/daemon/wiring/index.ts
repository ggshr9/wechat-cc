/**
 * wiring/ — main.ts dep factory hub. Composes the three sub-builders into
 * one wireMain() entry. Holds zero business logic — pure orchestration.
 */
import type { Db } from '../../lib/db'
import type { IlinkAdapter, IlinkAccount } from '../ilink-glue'
import type { Bootstrap } from '../bootstrap'
import type { Access } from '../../lib/access'
import { Ref } from '../../lib/lifecycle'
import type { GuardLifecycle } from '../guard/lifecycle'
import type { PollingLifecycle } from '../polling-lifecycle'
import type { InboundPipelineDeps } from '../inbound/build'
import type { PipelineRun } from '../inbound/types'
import type { CompanionPushDeps, CompanionIntrospectDeps } from '../companion/lifecycle'
import type { SchedulerDeps } from '../guard/scheduler'
import type { SessionsLifecycleDeps } from '../sessions-lifecycle'
import type { IlinkLifecycleDeps } from '../ilink-lifecycle'
import type { PollingDeps } from '../polling-lifecycle'
import type { StartupSweepDeps } from '../startup-sweeps'
import { buildPipelineDeps } from './pipeline-deps'
import { buildLifecycleDeps } from './lifecycle-deps'
import { buildTickBodies, type TickBodies } from './tick-bodies'

export interface WireMainOpts {
  stateDir: string
  db: Db
  ilink: IlinkAdapter
  /** Loaded before makeIlinkAdapter — passed separately because IlinkAdapter doesn't expose accounts. */
  accounts: IlinkAccount[]
  boot: Bootstrap
  /** `--dangerously` flag — read by startup-sweeps for notification text. */
  dangerously: boolean
  /**
   * Task 11 — tick-bodies resolve `default_chat_id`'s tier from
   * access.json on each tick. Threaded through wireMain so the eval
   * harness can inject a fake `loadAccess` without touching disk.
   */
  loadAccess: () => Access
  log: (tag: string, line: string, fields?: Record<string, unknown>) => void
  /** Forwarded to buildLifecycleDeps — eval harness override. */
  schedulerIntervalMs?: number
}

export interface WiredDeps {
  pipelineDeps: InboundPipelineDeps
  companionPushDeps: CompanionPushDeps
  companionIntrospectDeps: CompanionIntrospectDeps
  guardDeps: SchedulerDeps
  sessionsDeps: SessionsLifecycleDeps
  ilinkDeps: IlinkLifecycleDeps
  pollingDeps: Omit<PollingDeps, 'runPipeline'>
  startupDeps: StartupSweepDeps
  /**
   * The same TickBodies object used by the lifecycle onTick callbacks.
   * Exposed so bootDaemon can wire DaemonHandle.fireTick directly to it —
   * eval harness calls fireTick to drive ticks deterministically.
   */
  ticks: TickBodies
  /**
   * Late-bound references — main.ts populates via wireRef() after the
   * corresponding lifecycle is registered. Closures (admin handler's
   * pollHandle, mwGuard's guardState) read .current at call time.
   */
  refs: {
    polling: Ref<PollingLifecycle>
    guard: Ref<GuardLifecycle>
    pipeline: Ref<PipelineRun>
  }
}

export function wireMain(opts: WireMainOpts): WiredDeps {
  const refs = {
    polling: new Ref<PollingLifecycle>('polling'),
    guard: new Ref<GuardLifecycle>('guard'),
    pipeline: new Ref<PipelineRun>('pipeline'),
  }
  const ticks = buildTickBodies({
    ...opts,
    permissionMode: opts.dangerously ? 'dangerously' : 'strict',
  })
  const { pipelineDeps } = buildPipelineDeps(opts, refs)
  const lifecycleDeps = buildLifecycleDeps(opts, ticks)
  return {
    pipelineDeps,
    ...lifecycleDeps,
    ticks,
    refs,
  }
}
