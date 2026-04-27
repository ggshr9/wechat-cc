import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

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

  const fetched = deps.runGit(['fetch', 'origin'])
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

  // Step 7-10 implemented in later tasks; for now stub to keep types happy.
  return {
    ok: false, mode: 'apply', reason: 'pull_conflict',
    message: 'pull/install/start continuation not yet implemented',
  }
}
