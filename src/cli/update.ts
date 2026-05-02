import { buildServicePlan, isServiceInstalled, startService, stopService } from './service-manager'
import { loadAgentConfig } from '../lib/agent-config'
import { findOnPath } from '../lib/util'
import { readDaemon } from './doctor'
import { spawnSync } from 'node:child_process'

export type UpdateReason =
  | 'dirty_tree'
  | 'diverged'
  | 'detached_head'
  | 'fetch_failed'
  | 'pull_conflict'
  | 'install_failed'
  | 'bun_missing'
  | 'daemon_running_not_service'
  | 'service_stop_failed'
  | 'not_a_git_repo'

export type DaemonAction = 'restarted' | 'noop' | 'restart_failed'

export interface RunResult {
  stdout: string
  stderr: string
  code: number
}

export interface UpdateDeps {
  repoRoot: string
  stateDir: string
  runGit(args: string[]): RunResult
  bun: { path: string | null; install: () => RunResult }
  daemon: () => { alive: boolean; pid: number | null }
  service: {
    installed: () => boolean
    stop: () => void
    start: () => void
  }
  now?: () => number
}

export interface UpdateProbe {
  ok: boolean
  mode: 'check'
  currentCommit?: string
  latestCommit?: string
  updateAvailable?: boolean
  behind?: number
  aheadOfRemote?: number
  lockfileWillChange?: boolean
  dirty?: boolean
  dirtyFiles?: string[]
  reason?: UpdateReason
  message?: string
  details?: Record<string, unknown>
}

export interface UpdateApplied {
  ok: true
  mode: 'apply'
  fromCommit: string
  toCommit: string
  lockfileChanged: boolean
  installRan: boolean
  daemonAction: DaemonAction
  elapsedMs: number
}

export interface UpdateRejected {
  ok: false
  mode: 'apply'
  reason: UpdateReason
  message: string
  details?: Record<string, unknown>
}

export type UpdateResult = UpdateApplied | UpdateRejected

export function analyzeUpdate(deps: UpdateDeps): UpdateProbe {
  const probe: UpdateProbe = { ok: false, mode: 'check' }

  let fetched: RunResult
  try {
    fetched = deps.runGit(['fetch', 'origin'])
  } catch (err) {
    return { ok: false, mode: 'check', reason: 'fetch_failed', message: 'git fetch origin threw', details: { stderr: err instanceof Error ? err.message : String(err) } }
  }
  if (fetched.code !== 0) {
    return { ok: false, mode: 'check', reason: 'fetch_failed', message: 'git fetch origin failed', details: { stderr: fetched.stderr } }
  }

  const branchRes = deps.runGit(['symbolic-ref', '--short', 'HEAD'])
  if (branchRes.code !== 0) {
    const head = deps.runGit(['rev-parse', 'HEAD'])
    return {
      ok: false, mode: 'check', reason: 'detached_head',
      message: 'HEAD is detached; checkout a branch and retry',
      details: { currentCommit: head.stdout.trim() },
    }
  }
  const branch = branchRes.stdout.trim()

  const head = deps.runGit(['rev-parse', 'HEAD']).stdout.trim()
  const remoteHead = deps.runGit(['rev-parse', `origin/${branch}`]).stdout.trim()
  const behind = parseCount(deps.runGit(['rev-list', '--count', `${head}..${remoteHead}`]).stdout)
  const ahead = parseCount(deps.runGit(['rev-list', '--count', `${remoteHead}..${head}`]).stdout)
  const porcelain = deps.runGit(['status', '--porcelain']).stdout
  const dirtyFiles = porcelain.split('\n').map((l) => l.slice(3).trim()).filter(Boolean)
  const lockfileDiff = deps.runGit(['diff', '--name-only', 'HEAD', `origin/${branch}`, '--', 'bun.lock']).stdout

  probe.ok = true
  probe.currentCommit = head
  probe.latestCommit = remoteHead
  probe.behind = behind
  probe.aheadOfRemote = ahead
  probe.updateAvailable = behind > 0
  probe.dirty = dirtyFiles.length > 0
  probe.dirtyFiles = dirtyFiles
  probe.lockfileWillChange = lockfileDiff.trim().length > 0
  return probe
}

function parseCount(s: string): number {
  const n = Number.parseInt(s.trim(), 10)
  return Number.isFinite(n) ? n : 0
}

export async function applyUpdate(deps: UpdateDeps): Promise<UpdateResult> {
  const startedAt = (deps.now ?? Date.now)()
  const probe = analyzeUpdate(deps)
  if (!probe.ok) {
    return { ok: false, mode: 'apply', reason: probe.reason!, message: probe.message ?? 'probe failed', ...(probe.details ? { details: probe.details } : {}) }
  }
  if (probe.dirty) {
    return {
      ok: false, mode: 'apply', reason: 'dirty_tree',
      message: 'working tree has uncommitted changes; commit/stash/discard then retry',
      details: { dirtyFiles: probe.dirtyFiles ?? [] },
    }
  }
  if ((probe.aheadOfRemote ?? 0) > 0) {
    return {
      ok: false, mode: 'apply', reason: 'diverged',
      message: 'local branch has commits not on origin; push or rebase then retry',
      details: { aheadBy: probe.aheadOfRemote, behindBy: probe.behind },
    }
  }
  if (!probe.updateAvailable) {
    return {
      ok: true, mode: 'apply',
      fromCommit: probe.currentCommit!,
      toCommit: probe.latestCommit!,
      lockfileChanged: false,
      installRan: false,
      daemonAction: 'noop',
      elapsedMs: ((deps.now ?? Date.now)() - startedAt),
    }
  }
  const daemon = deps.daemon()
  let wasService = false
  if (daemon.alive) {
    if (!deps.service.installed()) {
      return {
        ok: false, mode: 'apply', reason: 'daemon_running_not_service',
        message: 'daemon is running outside the installed service; stop it manually then retry',
        details: { pid: daemon.pid },
      }
    }
    wasService = true
  }

  if (wasService) {
    try {
      deps.service.stop()
    } catch (err) {
      return {
        ok: false, mode: 'apply', reason: 'service_stop_failed',
        message: 'service.stop() threw',
        details: { stderr: err instanceof Error ? err.message : String(err) },
      }
    }
  }

  // From here the service is stopped. The mutating steps (pull/install)
  // are split into a daemon-unaware helper; whether we restart on success
  // or restore on failure is the wrapper's single concern. This isolates
  // "WeChat must not go silently dark on a failed update" to one place
  // instead of three explicit `tryRestoreDaemon()` calls scattered across
  // each early-return.
  const inner = runMutatingSteps(deps, probe)
  if (!inner.ok) {
    bestEffortStart(deps, wasService)
    return inner
  }

  const daemonAction: DaemonAction = wasService
    ? (tryStart(deps) ? 'restarted' : 'restart_failed')
    : 'noop'

  return {
    ok: true, mode: 'apply',
    fromCommit: probe.currentCommit!,
    toCommit: probe.latestCommit!,
    lockfileChanged: !!probe.lockfileWillChange,
    installRan: inner.installRan,
    daemonAction,
    elapsedMs: ((deps.now ?? Date.now)() - startedAt),
  }
}

// Run the actual upgrade steps (pull, optional bun install). No knowledge of
// the daemon — caller (applyUpdate) handles stop/start/restore. Returns
// either { ok:true, installRan } or a typed UpdateRejected.
function runMutatingSteps(
  deps: UpdateDeps,
  probe: UpdateProbe,
): { ok: true; installRan: boolean } | UpdateRejected {
  const pulled = deps.runGit(['pull', '--ff-only'])
  if (pulled.code !== 0) {
    return {
      ok: false, mode: 'apply', reason: 'pull_conflict',
      message: 'git pull --ff-only failed',
      details: { stderr: pulled.stderr },
    }
  }

  let installRan = false
  if (probe.lockfileWillChange) {
    if (!deps.bun.path) {
      return {
        ok: false, mode: 'apply', reason: 'bun_missing',
        message: 'bun.lock changed but `bun` is not on PATH; install Bun then retry',
      }
    }
    const installed = deps.bun.install()
    installRan = true
    if (installed.code !== 0) {
      return {
        ok: false, mode: 'apply', reason: 'install_failed',
        message: 'bun install --frozen-lockfile failed',
        details: { stderr: installed.stderr },
      }
    }
  }
  return { ok: true, installRan }
}

// Best-effort daemon restore — used after a failed mutating step. Swallows
// any error from service.start(); the caller is propagating the original
// failure (pull_conflict / bun_missing / install_failed) which is more
// actionable than "service.start ALSO failed". No-op when wasService=false.
function bestEffortStart(deps: UpdateDeps, wasService: boolean): void {
  if (!wasService) return
  try { deps.service.start() } catch { /* original failure is what the user needs */ }
}

// Attempt service.start, returning whether it succeeded. Used on the
// happy path to map success/failure to daemonAction='restarted'/'restart_failed'.
function tryStart(deps: UpdateDeps): boolean {
  try { deps.service.start(); return true } catch { return false }
}

export function defaultUpdateDeps(repoRoot: string, stateDir: string): UpdateDeps {
  const bunPath = findOnPath('bun')
  const config = loadAgentConfig(stateDir)
  const plan = buildServicePlan({
    cwd: repoRoot,
    dangerouslySkipPermissions: config.dangerouslySkipPermissions,
    autoStart: config.autoStart,
  })

  return {
    repoRoot,
    stateDir,
    runGit(args) {
      const r = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' })
      return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.status ?? 1 }
    },
    bun: {
      path: bunPath,
      install: () => {
        if (!bunPath) return { stdout: '', stderr: 'bun not on PATH', code: 127 }
        const r = spawnSync(bunPath, ['install', '--frozen-lockfile'], { cwd: repoRoot, encoding: 'utf8' })
        return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.status ?? 1 }
      },
    },
    daemon: () => readDaemon(stateDir),
    service: {
      installed: () => isServiceInstalled(plan),
      stop: () => stopService(plan),
      start: () => startService(plan),
    },
  }
}
