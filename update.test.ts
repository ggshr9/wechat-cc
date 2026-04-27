import { describe, expect, it, vi } from 'vitest'
import {
  analyzeUpdate,
  applyUpdate,
  type UpdateDeps,
  type RunResult,
} from './update'

type GitRoute = (args: string[]) => RunResult | undefined

function ok(stdout = ''): RunResult { return { stdout, stderr: '', code: 0 } }
function fail(stderr = '', code = 1): RunResult { return { stdout: '', stderr, code } }

interface FakeOpts {
  branch?: string
  head?: string
  remoteHead?: string
  behind?: number
  ahead?: number
  porcelain?: string  // body of `git status --porcelain`
  lockfileDiff?: string  // body of `git diff --name-only ... -- bun.lock`
  fetch?: RunResult
  pull?: RunResult
  daemon?: { alive: boolean; pid: number | null }
  serviceInstalled?: boolean
  bunPath?: string | null
  installResult?: RunResult
  detached?: boolean
  extraGit?: GitRoute
}

function makeFakeDeps(opts: FakeOpts = {}) {
  const branch = opts.branch ?? 'master'
  const head = opts.head ?? 'aaaaaaa'
  const remoteHead = opts.remoteHead ?? (opts.ahead && opts.ahead > 0 ? '1111111' : head)
  const behind = opts.behind ?? 0
  const ahead = opts.ahead ?? 0
  const porcelain = opts.porcelain ?? ''
  const lockfileDiff = opts.lockfileDiff ?? ''
  const fetch = opts.fetch ?? ok()
  const pull = opts.pull ?? ok()
  const detached = opts.detached ?? false

  const stop = vi.fn()
  const start = vi.fn()
  const install = vi.fn(() => opts.installResult ?? ok())

  const runGit = vi.fn<(args: string[]) => RunResult>((args) => {
    const route = opts.extraGit?.(args)
    if (route) return route
    if (args[0] === 'fetch') return fetch
    if (args[0] === 'symbolic-ref') return detached ? fail('not a symbolic ref') : ok(`${branch}\n`)
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') return ok(`${head}\n`)
    if (args[0] === 'rev-parse' && args[1] === `origin/${branch}`) return ok(`${remoteHead}\n`)
    if (args[0] === 'rev-list' && args.includes(`${head}..${remoteHead}`)) return ok(`${behind}\n`)
    if (args[0] === 'rev-list' && args.includes(`${remoteHead}..${head}`)) return ok(`${ahead}\n`)
    if (args[0] === 'status' && args[1] === '--porcelain') return ok(porcelain)
    if (args[0] === 'diff' && args.includes('bun.lock')) return ok(lockfileDiff)
    if (args[0] === 'pull') return pull
    return fail(`unrouted git ${args.join(' ')}`)
  })

  const deps: UpdateDeps = {
    repoRoot: '/fake/repo',
    stateDir: '/fake/state',
    runGit,
    bun: { path: opts.bunPath === undefined ? '/usr/local/bin/bun' : opts.bunPath, install },
    daemon: () => opts.daemon ?? { alive: false, pid: null },
    service: {
      installed: () => opts.serviceInstalled ?? false,
      stop,
      start,
    },
    now: () => 0,
  }
  return { deps, runGit, stop, start, install }
}

describe('analyzeUpdate', () => {
  it('clean tree, behind=3, lockfile change → updateAvailable=true', () => {
    const { deps } = makeFakeDeps({
      head: 'aaaaaaa',
      remoteHead: 'bbbbbbb',
      behind: 3,
      lockfileDiff: 'bun.lock\n',
    })
    const probe = analyzeUpdate(deps)
    expect(probe).toMatchObject({
      ok: true,
      mode: 'check',
      currentCommit: 'aaaaaaa',
      latestCommit: 'bbbbbbb',
      updateAvailable: true,
      behind: 3,
      aheadOfRemote: 0,
      lockfileWillChange: true,
      dirty: false,
      dirtyFiles: [],
    })
  })

  it('clean tree, behind=0 → updateAvailable=false', () => {
    const { deps } = makeFakeDeps({ head: 'x', remoteHead: 'x', behind: 0 })
    const probe = analyzeUpdate(deps)
    expect(probe.ok).toBe(true)
    expect(probe.updateAvailable).toBe(false)
    expect(probe.behind).toBe(0)
  })

  it('ahead=2, behind=0 → updateAvailable=false, aheadOfRemote=2', () => {
    const { deps } = makeFakeDeps({ ahead: 2, behind: 0 })
    const probe = analyzeUpdate(deps)
    expect(probe.aheadOfRemote).toBe(2)
    expect(probe.updateAvailable).toBe(false)
  })

  it('lockfile unchanged → lockfileWillChange=false', () => {
    const { deps } = makeFakeDeps({ behind: 1, head: 'a', remoteHead: 'b', lockfileDiff: '' })
    expect(analyzeUpdate(deps).lockfileWillChange).toBe(false)
  })

  it('dirty tree → dirty=true with files list', () => {
    const { deps } = makeFakeDeps({ porcelain: ' M cli.ts\n?? scratch.txt\n' })
    const probe = analyzeUpdate(deps)
    expect(probe.dirty).toBe(true)
    expect(probe.dirtyFiles).toEqual(['cli.ts', 'scratch.txt'])
  })

  it('fetch failure → reason=fetch_failed', () => {
    const { deps } = makeFakeDeps({ fetch: fail('network down', 128) })
    const probe = analyzeUpdate(deps)
    expect(probe.ok).toBe(false)
    expect(probe.reason).toBe('fetch_failed')
    expect(probe.details?.stderr).toContain('network down')
  })

  it('detached HEAD → reason=detached_head', () => {
    const { deps } = makeFakeDeps({ detached: true })
    const probe = analyzeUpdate(deps)
    expect(probe.ok).toBe(false)
    expect(probe.reason).toBe('detached_head')
  })
})

describe('applyUpdate — early rejects', () => {
  it('dirty tree → reject without touching service or pull', async () => {
    const { deps, runGit, stop, start, install } = makeFakeDeps({ porcelain: ' M cli.ts\n' })
    const result = await applyUpdate(deps)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('dirty_tree')
    expect(result.details?.dirtyFiles).toEqual(['cli.ts'])
    expect(stop).not.toHaveBeenCalled()
    expect(start).not.toHaveBeenCalled()
    expect(install).not.toHaveBeenCalled()
    expect(runGit).not.toHaveBeenCalledWith(expect.arrayContaining(['pull']))
  })

  it('diverged (ahead > 0) → reject', async () => {
    const { deps, stop } = makeFakeDeps({ ahead: 2, behind: 1, head: 'a', remoteHead: 'b' })
    const result = await applyUpdate(deps)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('diverged')
    expect(result.details).toMatchObject({ aheadBy: 2, behindBy: 1 })
    expect(stop).not.toHaveBeenCalled()
  })

  it('daemon alive but not installed as service → reject', async () => {
    const { deps, stop, runGit } = makeFakeDeps({
      behind: 1, head: 'a', remoteHead: 'b',
      daemon: { alive: true, pid: 4242 },
      serviceInstalled: false,
    })
    const result = await applyUpdate(deps)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('daemon_running_not_service')
    expect(result.details).toMatchObject({ pid: 4242 })
    expect(stop).not.toHaveBeenCalled()
    expect(runGit).not.toHaveBeenCalledWith(expect.arrayContaining(['pull']))
  })

  it('detached HEAD → reject', async () => {
    const { deps } = makeFakeDeps({ detached: true })
    const result = await applyUpdate(deps)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('detached_head')
  })
})

describe('applyUpdate — service stop', () => {
  it('service.stop throws → reject service_stop_failed, pull never runs', async () => {
    const { deps, stop, runGit } = makeFakeDeps({
      behind: 1, head: 'a', remoteHead: 'b',
      daemon: { alive: true, pid: 1 },
      serviceInstalled: true,
    })
    stop.mockImplementation(() => { throw new Error('launchctl bootout failed') })
    const result = await applyUpdate(deps)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('service_stop_failed')
    expect(result.details?.stderr).toContain('launchctl bootout failed')
    expect(runGit).not.toHaveBeenCalledWith(expect.arrayContaining(['pull']))
  })
})

describe('applyUpdate — pull/install', () => {
  it('pull --ff-only fails → reject pull_conflict, install not run, service stays stopped', async () => {
    const { deps, stop, start, install } = makeFakeDeps({
      behind: 1, head: 'a', remoteHead: 'b',
      daemon: { alive: true, pid: 1 },
      serviceInstalled: true,
      pull: fail('Aborting', 1),
    })
    const result = await applyUpdate(deps)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('pull_conflict')
    expect(stop).toHaveBeenCalledOnce()
    expect(install).not.toHaveBeenCalled()
    expect(start).not.toHaveBeenCalled()
  })

  it('install fails → reject install_failed, service stays stopped', async () => {
    const { deps, install, start } = makeFakeDeps({
      behind: 1, head: 'a', remoteHead: 'b',
      lockfileDiff: 'bun.lock\n',
      daemon: { alive: true, pid: 1 },
      serviceInstalled: true,
      installResult: fail('lockfile mismatch', 1),
    })
    const result = await applyUpdate(deps)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('install_failed')
    expect(install).toHaveBeenCalledOnce()
    expect(start).not.toHaveBeenCalled()
  })

  it('lockfile changed but bun missing → reject bun_missing', async () => {
    const { deps, install } = makeFakeDeps({
      behind: 1, head: 'a', remoteHead: 'b',
      lockfileDiff: 'bun.lock\n',
      bunPath: null,
    })
    const result = await applyUpdate(deps)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('bun_missing')
    expect(install).not.toHaveBeenCalled()
  })
})

describe('applyUpdate — completion paths', () => {
  it('happy path with service → restarted, install ran when lockfile changed', async () => {
    const { deps, stop, start, install } = makeFakeDeps({
      behind: 1, head: 'a', remoteHead: 'b',
      lockfileDiff: 'bun.lock\n',
      daemon: { alive: true, pid: 1 },
      serviceInstalled: true,
    })
    const result = await applyUpdate(deps)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.daemonAction).toBe('restarted')
    expect(result.installRan).toBe(true)
    expect(result.lockfileChanged).toBe(true)
    expect(result.fromCommit).toBe('a')
    expect(result.toCommit).toBe('b')
    expect(stop).toHaveBeenCalledOnce()
    expect(install).toHaveBeenCalledOnce()
    expect(start).toHaveBeenCalledOnce()
  })

  it('happy path daemon not running → noop, no install if lockfile unchanged', async () => {
    const { deps, stop, start, install } = makeFakeDeps({
      behind: 1, head: 'a', remoteHead: 'b',
      lockfileDiff: '',
      daemon: { alive: false, pid: null },
    })
    const result = await applyUpdate(deps)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.daemonAction).toBe('noop')
    expect(result.installRan).toBe(false)
    expect(result.lockfileChanged).toBe(false)
    expect(stop).not.toHaveBeenCalled()
    expect(start).not.toHaveBeenCalled()
    expect(install).not.toHaveBeenCalled()
  })

  it('service.start throws after successful pull → ok=true with restart_failed', async () => {
    const { deps, start } = makeFakeDeps({
      behind: 1, head: 'a', remoteHead: 'b',
      daemon: { alive: true, pid: 1 },
      serviceInstalled: true,
    })
    start.mockImplementation(() => { throw new Error('launchctl bootstrap failed') })
    const result = await applyUpdate(deps)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.daemonAction).toBe('restart_failed')
  })

  it('no update available → fast path returns ok with daemonAction=noop', async () => {
    const { deps, stop, start, install } = makeFakeDeps({
      behind: 0, head: 'x', remoteHead: 'x',
      daemon: { alive: true, pid: 1 },
      serviceInstalled: true,
    })
    const result = await applyUpdate(deps)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.daemonAction).toBe('noop')
    expect(result.installRan).toBe(false)
    expect(stop).not.toHaveBeenCalled()
    expect(start).not.toHaveBeenCalled()
    expect(install).not.toHaveBeenCalled()
  })
})
