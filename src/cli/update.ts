import { buildServicePlan, isServiceInstalled, startService, stopService } from './service-manager'
import { loadAgentConfig } from '../lib/agent-config'
import { findOnPath } from '../lib/util'
import { readDaemon } from './doctor'
import { detectServiceBinaryPath } from './binary-detect'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'

export type UpdateReason =
  | 'dirty_tree'
  | 'diverged'
  | 'detached_head'
  | 'fetch_failed'
  | 'pull_conflict'
  | 'install_failed'
  | 'bun_missing'
  | 'rebuild_failed'
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
  /**
   * Binary refresh hook (2026-05-08). When the installed service points
   * at a self-contained `wechat-cc-cli`, `detect()` returns its absolute
   * path and `rebuild(path)` is called after pull+install to recompile +
   * atomically replace the binary so the new code actually reaches the
   * daemon. When `detect()` returns null (dev mode running `bun cli.ts`),
   * the rebuild step is skipped. Optional for back-compat with callers
   * that don't yet wire it up.
   *
   * `readSentinel(binaryPath)` reads the SHA that produced the binary
   * (`<binaryPath>.commit` written by rebuild). Used by analyzeUpdate
   * to mark binaryStale=true when the sentinel mismatches local HEAD —
   * triggers a rebuild even when there's no upstream to pull. Returns
   * null when the sentinel file is missing (pre-fix binary, force rebuild).
   */
  binary?: {
    detect: () => string | null
    rebuild: (binaryPath: string) => RunResult
    readSentinel: (binaryPath: string) => string | null
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
  /** True when binary mode is active AND the sentinel file is missing or doesn't match HEAD — meaning the binary lags the local source even if there's no upstream to pull. */
  binaryStale?: boolean
  /** Absolute path the binary refresh would target. Set when binary mode active. */
  binaryPath?: string
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
  /** True when binary mode was detected and `bun build --compile` ran successfully. */
  rebuildRan: boolean
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

  // Binary mode + sentinel check — drives rebuild even when there's no
  // upstream to pull. Only meaningful when binary mode is configured;
  // dev-mode users (bun cli.ts) get binaryStale=false unconditionally.
  let binaryStale = false
  let binaryPath: string | undefined
  if (deps.binary) {
    const detected = deps.binary.detect()
    if (detected) {
      binaryPath = detected
      const sentinel = deps.binary.readSentinel(detected)
      // null sentinel = pre-fix binary built before this feature shipped
      // → treat as stale so the first update post-upgrade refreshes it.
      binaryStale = sentinel !== head
    }
  }

  probe.ok = true
  probe.currentCommit = head
  probe.latestCommit = remoteHead
  probe.behind = behind
  probe.aheadOfRemote = ahead
  probe.updateAvailable = behind > 0 || binaryStale
  probe.binaryStale = binaryStale
  if (binaryPath) probe.binaryPath = binaryPath
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
      rebuildRan: false,
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
    rebuildRan: inner.rebuildRan,
    daemonAction,
    elapsedMs: ((deps.now ?? Date.now)() - startedAt),
  }
}

// Run the actual upgrade steps (pull, optional bun install, optional binary
// rebuild). No knowledge of the daemon — caller (applyUpdate) handles
// stop/start/restore. Returns either { ok:true, installRan, rebuildRan } or
// a typed UpdateRejected.
function runMutatingSteps(
  deps: UpdateDeps,
  probe: UpdateProbe,
): { ok: true; installRan: boolean; rebuildRan: boolean } | UpdateRejected {
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

  // Binary refresh — only when service points at compiled `wechat-cc-cli`.
  // detect() in analyzeUpdate already populated probe.binaryPath when binary
  // mode is active; null in dev mode (bun cli.ts) so this is a no-op for
  // source-checkout users. The rebuild helper handles atomic replace; if
  // it fails we surface rebuild_failed and let the caller's bestEffortStart
  // bring the daemon back on the OLD binary (better than leaving it down).
  let rebuildRan = false
  if (deps.binary && probe.binaryPath) {
    const rebuilt = deps.binary.rebuild(probe.binaryPath)
    rebuildRan = rebuilt.code === 0
    if (rebuilt.code !== 0) {
      return {
        ok: false, mode: 'apply', reason: 'rebuild_failed',
        message: `bun build --compile failed for ${probe.binaryPath}`,
        details: { stderr: rebuilt.stderr, binaryPath: probe.binaryPath },
      }
    }
  }

  return { ok: true, installRan, rebuildRan }
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
      const r = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8', windowsHide: true })
      return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.status ?? 1 }
    },
    bun: {
      path: bunPath,
      install: () => {
        if (!bunPath) return { stdout: '', stderr: 'bun not on PATH', code: 127 }
        const r = spawnSync(bunPath, ['install', '--frozen-lockfile'], { cwd: repoRoot, encoding: 'utf8', windowsHide: true })
        return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.status ?? 1 }
      },
    },
    daemon: () => readDaemon(stateDir),
    service: {
      installed: () => isServiceInstalled(plan),
      stop: () => stopService(plan),
      start: () => startService(plan),
    },
    binary: {
      detect: () => detectServiceBinaryPath({
        homeDir: homedir(),
        platform: platform(),
        readFile: (p) => existsSync(p) ? readFileSync(p, 'utf8') : null,
        readSchTask: () => readWindowsScheduledTaskExecute(),
      }),
      rebuild: (binaryPath) => compileAndAtomicReplace({
        bunPath,
        repoRoot,
        binaryPath,
      }),
      readSentinel: (binaryPath) => {
        const sentinelPath = `${binaryPath}.commit`
        if (!existsSync(sentinelPath)) return null
        try { return readFileSync(sentinelPath, 'utf8').trim() } catch { return null }
      },
    },
  }
}

function writeBinarySentinel(binaryPath: string, repoRoot: string): void {
  // Capture HEAD at rebuild time so a future `wechat-cc update` can detect
  // "binary lags HEAD" via sentinel mismatch — fixes the second framework
  // gap from the 2026-05-08 audit (update was a no-op when behind=0 even
  // if binary was older than the local source). Best-effort: silently
  // skip if git's missing or HEAD is detached.
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8', windowsHide: true })
  if (r.status !== 0) return
  const sha = (r.stdout ?? '').trim()
  if (!sha) return
  try {
    writeFileSync(`${binaryPath}.commit`, sha + '\n', { mode: 0o644 })
  } catch { /* best-effort sentinel; rebuild itself succeeded */ }
}

// Spawn `bun build --compile` to a temp file in the same dir as the target
// binary, then atomically rename. Atomic replace within the same filesystem
// is safe even while the old binary is still memory-mapped by the running
// daemon (POSIX semantics; Windows refuses, so we unlink first there).
function compileAndAtomicReplace(opts: {
  bunPath: string | null
  repoRoot: string
  binaryPath: string
}): RunResult {
  if (!opts.bunPath) {
    return { stdout: '', stderr: '`bun` not on PATH; install Bun then retry', code: 127 }
  }
  const tmp = `${opts.binaryPath}.tmp-${process.pid}-${Date.now()}`
  const r = spawnSync(
    opts.bunPath,
    ['build', '--compile', '--minify', '--sourcemap=inline', join(opts.repoRoot, 'cli.ts'), '--outfile', tmp],
    { cwd: opts.repoRoot, encoding: 'utf8', windowsHide: true },
  )
  if (r.status !== 0) {
    try { if (existsSync(tmp)) unlinkSync(tmp) } catch { /* best-effort tmp cleanup */ }
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.status ?? 1 }
  }
  try {
    if (process.platform === 'win32' && existsSync(opts.binaryPath)) {
      // Windows can't rename over a running PE image — unlink first. The
      // service is stopped at this point in the update flow so the old
      // binary is no longer locked.
      unlinkSync(opts.binaryPath)
    }
    renameSync(tmp, opts.binaryPath)
  } catch (err) {
    try { if (existsSync(tmp)) unlinkSync(tmp) } catch { /* best-effort */ }
    return {
      stdout: r.stdout ?? '',
      stderr: `atomic rename failed: ${err instanceof Error ? err.message : String(err)}`,
      code: 1,
    }
  }
  // Drop the sentinel last, after the binary is in place. If this throws
  // we still report success — the rebuild worked, sentinel is just a
  // cache. Worst case: next update sees null sentinel and rebuilds again.
  writeBinarySentinel(opts.binaryPath, opts.repoRoot)
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: 0 }
}

// Windows-only probe: shell out to PowerShell to read the scheduled task's
// Execute path. Safe-by-default — returns null when the task is missing,
// PS isn't available, or anything else goes wrong (caller treats null as
// "dev mode, skip rebuild" which is the correct fallback).
function readWindowsScheduledTaskExecute(): string | null {
  if (process.platform !== 'win32') return null
  const r = spawnSync(
    'powershell',
    ['-NoProfile', '-Command', `try { (Get-ScheduledTask -TaskName 'wechat-cc' -ErrorAction Stop).Actions[0].Execute } catch { '' }`],
    { encoding: 'utf8', windowsHide: true },
  )
  if (r.status !== 0) return null
  const out = (r.stdout ?? '').trim()
  return out.length > 0 ? out : null
}
