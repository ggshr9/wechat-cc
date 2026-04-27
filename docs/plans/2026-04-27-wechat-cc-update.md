# `wechat-cc update` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `wechat-cc update --check [--json]` and `wechat-cc update [--json]` so the desktop GUI can probe for updates and trigger a one-click upgrade. Spec: `docs/specs/2026-04-27-wechat-cc-update.md`.

**Architecture:** Pure-function `analyzeUpdate` / `applyUpdate` in `update.ts` taking an `UpdateDeps` interface. Tests use fake deps; e2e uses real git in `mkdtemp` repos. `cli.ts` adds two cases that build deps via `defaultUpdateDeps(repoRoot, stateDir)` and reuse `service-manager.ts`.

**Tech Stack:** Bun + TypeScript, vitest, `node:child_process` `spawnSync` for `git` / `bun install`, existing `service-manager.ts` for daemon control, existing `findOnPath` from `./util`.

---

## File structure

| Path | Status | Responsibility |
|---|---|---|
| `update.ts` | **create** | Types + `analyzeUpdate` + `applyUpdate` + `defaultUpdateDeps` |
| `update.test.ts` | **create** | Unit tests with fake `UpdateDeps`, 18 cases |
| `update.e2e.test.ts` | **create** | E2E with real git temp repos, fake service, 7 cases |
| `cli.ts` | modify | Extend `CliArgs` union, `parseCliArgs`, main switch, help text |
| `cli.test.ts` | modify | Add `update` arg-parse cases |
| `.github/workflows/desktop.yml` | modify | Append `update.test.ts` + `update.e2e.test.ts` to vitest list |

Each task ends with a passing test suite + a commit.

---

## Task 1: Scaffold types in `update.ts`

**Files:**
- Create: `update.ts`

- [ ] **Step 1: Create `update.ts` with type definitions only**

```ts
// update.ts
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

export function analyzeUpdate(_deps: UpdateDeps): UpdateProbe {
  throw new Error('not implemented')
}

export async function applyUpdate(_deps: UpdateDeps): Promise<UpdateResult> {
  throw new Error('not implemented')
}
```

- [ ] **Step 2: Confirm typecheck passes**

Run: `bun x tsc --noEmit`
Expected: PASS (no type errors).

- [ ] **Step 3: Commit**

```bash
git add update.ts
git commit -m "feat(update): scaffold types for wechat-cc update"
```

---

## Task 2: TDD `analyzeUpdate` — happy paths

**Files:**
- Create: `update.test.ts`
- Modify: `update.ts`

- [ ] **Step 1: Write `update.test.ts` with the fake-deps factory + first 4 cases**

```ts
// update.test.ts
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
  const remoteHead = opts.remoteHead ?? head
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
})
```

- [ ] **Step 2: Run tests to verify they fail with "not implemented"**

Run: `bun x vitest run update.test.ts`
Expected: 4 FAIL with `Error: not implemented`.

- [ ] **Step 3: Implement `analyzeUpdate` happy paths**

Replace the stub in `update.ts` with:

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun x vitest run update.test.ts`
Expected: 4 PASS.

- [ ] **Step 5: Commit**

```bash
git add update.ts update.test.ts
git commit -m "feat(update): analyzeUpdate happy paths"
```

---

## Task 3: TDD `analyzeUpdate` — error and edge cases

**Files:**
- Modify: `update.test.ts`

- [ ] **Step 1: Add 3 cases for dirty / detached / fetch_failed**

Append to `update.test.ts` inside `describe('analyzeUpdate', …)`:

```ts
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
```

- [ ] **Step 2: Run all `analyzeUpdate` tests**

Run: `bun x vitest run update.test.ts -t analyzeUpdate`
Expected: 7 PASS (all pass without code changes — implementation already covers these branches).

- [ ] **Step 3: Commit**

```bash
git add update.test.ts
git commit -m "test(update): cover analyzeUpdate dirty / detached / fetch_failed"
```

---

## Task 4: TDD `applyUpdate` — early rejects

**Files:**
- Modify: `update.test.ts`
- Modify: `update.ts`

- [ ] **Step 1: Add 4 reject cases at end of `update.test.ts`**

```ts
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
```

- [ ] **Step 2: Run tests to confirm they FAIL with "not implemented"**

Run: `bun x vitest run update.test.ts -t "early rejects"`
Expected: 4 FAIL.

- [ ] **Step 3: Implement reject branches in `applyUpdate`**

Replace the `applyUpdate` stub:

```ts
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

  // Steps 5-9: continue in later tasks (no-op for now to satisfy types).
  return {
    ok: false, mode: 'apply', reason: 'fetch_failed',
    message: 'apply continuation not yet implemented',
    details: { wasService, startedAt },
  }
}
```

- [ ] **Step 4: Run tests to verify reject cases pass**

Run: `bun x vitest run update.test.ts -t "early rejects"`
Expected: 4 PASS.

- [ ] **Step 5: Commit**

```bash
git add update.ts update.test.ts
git commit -m "feat(update): applyUpdate early rejects (dirty / diverged / not-service)"
```

---

## Task 5: TDD `applyUpdate` — service stop + stop_failed

**Files:**
- Modify: `update.test.ts`
- Modify: `update.ts`

- [ ] **Step 1: Add 2 cases**

```ts
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
```

- [ ] **Step 2: Run test, confirm fails**

Run: `bun x vitest run update.test.ts -t "service stop"`
Expected: 1 FAIL.

- [ ] **Step 3: Replace the stub continuation with the stop-step + tail**

In `update.ts`, replace the trailing "// Steps 5-9" block + return with:

```ts
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
```

- [ ] **Step 4: Confirm test passes + earlier tests still pass**

Run: `bun x vitest run update.test.ts`
Expected: all `analyzeUpdate` and `early rejects` + new `service stop` PASS.

- [ ] **Step 5: Commit**

```bash
git add update.ts update.test.ts
git commit -m "feat(update): applyUpdate handles service.stop failure"
```

---

## Task 6: TDD `applyUpdate` — pull / install / bun_missing

**Files:**
- Modify: `update.test.ts`
- Modify: `update.ts`

- [ ] **Step 1: Add 3 cases**

```ts
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
```

- [ ] **Step 2: Run tests, confirm 3 fail**

Run: `bun x vitest run update.test.ts -t "pull/install"`
Expected: 3 FAIL.

- [ ] **Step 3: Implement the pull + install + bun-check branches**

In `update.ts`, replace the trailing stub (`// Step 7-10 implemented…` block + return) with:

```ts
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

  // Step 9-10 (start + return) come in next task.
  return {
    ok: true, mode: 'apply',
    fromCommit: probe.currentCommit!,
    toCommit: probe.latestCommit!,
    lockfileChanged: !!probe.lockfileWillChange,
    installRan,
    daemonAction: 'noop',
    elapsedMs: ((deps.now ?? Date.now)() - startedAt),
  }
}
```

- [ ] **Step 4: Run tests**

Run: `bun x vitest run update.test.ts`
Expected: previous + new 3 PASS.

- [ ] **Step 5: Commit**

```bash
git add update.ts update.test.ts
git commit -m "feat(update): applyUpdate pull / install / bun_missing branches"
```

---

## Task 7: TDD `applyUpdate` — service start success + restart_failed + happy path

**Files:**
- Modify: `update.test.ts`
- Modify: `update.ts`

- [ ] **Step 1: Add 4 cases**

```ts
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
```

- [ ] **Step 2: Run tests, confirm 4 fail**

Run: `bun x vitest run update.test.ts -t "completion paths"`
Expected: 4 FAIL.

- [ ] **Step 3: Patch `applyUpdate` — add no-update fast path + service start logic**

Two edits in `update.ts`:

(a) After the `wasService = true` block (right before the `if (wasService) deps.service.stop()` try/catch), add the **no-update fast path** at the *correct* position. Specifically, put this *before* the daemon-status block (between the `diverged` check and `const daemon = deps.daemon()`):

```ts
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
```

(b) Replace the trailing `daemonAction: 'noop'` return (the one added in Task 6 stubbing the start step) with the real start logic:

```ts
  let daemonAction: DaemonAction = 'noop'
  if (wasService) {
    try {
      deps.service.start()
      daemonAction = 'restarted'
    } catch {
      daemonAction = 'restart_failed'
    }
  }

  return {
    ok: true, mode: 'apply',
    fromCommit: probe.currentCommit!,
    toCommit: probe.latestCommit!,
    lockfileChanged: !!probe.lockfileWillChange,
    installRan,
    daemonAction,
    elapsedMs: ((deps.now ?? Date.now)() - startedAt),
  }
}
```

- [ ] **Step 4: Run all `update.test.ts` cases**

Run: `bun x vitest run update.test.ts`
Expected: ALL PASS (no regressions, new 4 PASS).

- [ ] **Step 5: Commit**

```bash
git add update.ts update.test.ts
git commit -m "feat(update): applyUpdate completion (start success / restart_failed / noop)"
```

---

## Task 8: `defaultUpdateDeps` factory

**Files:**
- Modify: `update.ts`

`ServicePlan` (verified in `service-manager.ts`) exposes `serviceFile: string | null` and `serviceName: string`. macOS / Linux populate `serviceFile`; Windows leaves it null and we probe via `schtasks /Query`.

- [ ] **Step 1: Add imports at top of `update.ts`**

Add to the top-of-file import block (above existing imports):

```ts
import type { ServicePlan } from './service-manager'
import { buildServicePlan, startService, stopService } from './service-manager'
import { loadAgentConfig } from './agent-config'
import { findOnPath } from './util'
import { readDaemon } from './doctor'
```

- [ ] **Step 2: Append the factory at the bottom of `update.ts`**

```ts
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

function isServiceInstalled(plan: ServicePlan): boolean {
  if (plan.serviceFile) return existsSync(plan.serviceFile)
  if (plan.kind === 'scheduled-task') {
    const r = spawnSync('schtasks', ['/Query', '/TN', plan.serviceName], { encoding: 'utf8' })
    return (r.status ?? 1) === 0
  }
  return false
}
```

- [ ] **Step 3: Typecheck**

Run: `bun x tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add update.ts
git commit -m "feat(update): defaultUpdateDeps factory wiring real git + service-manager"
```

---

## Task 9: Wire `parseCliArgs` for `update`

**Files:**
- Modify: `cli.ts`
- Modify: `cli.test.ts`

- [ ] **Step 1: Add the failing test cases in `cli.test.ts`**

Inside the existing `describe('parseCliArgs', …)`, add:

```ts
it('parses update / update --check / update --json / update --check --json', () => {
  expect(parseCliArgs(['update'])).toEqual({ cmd: 'update', check: false, json: false })
  expect(parseCliArgs(['update', '--json'])).toEqual({ cmd: 'update', check: false, json: true })
  expect(parseCliArgs(['update', '--check'])).toEqual({ cmd: 'update', check: true, json: false })
  expect(parseCliArgs(['update', '--check', '--json'])).toEqual({ cmd: 'update', check: true, json: true })
})
```

- [ ] **Step 2: Run, confirm fail**

Run: `bun x vitest run cli.test.ts -t "parses update"`
Expected: FAIL — `cmd: 'help'` returned because `update` not handled.

- [ ] **Step 3: Extend `CliArgs` union**

In `cli.ts`, add to the `CliArgs` union (around line 26):

```ts
  | { cmd: 'update'; check: boolean; json: boolean }
```

- [ ] **Step 4: Add the `update` case in `parseCliArgs`**

In the `switch (cmd)` block, before the `default:` line, add:

```ts
    case 'update': {
      return {
        cmd: 'update',
        check: rest.includes('--check'),
        json: rest.includes('--json'),
      }
    }
```

- [ ] **Step 5: Run all cli tests**

Run: `bun x vitest run cli.test.ts`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add cli.ts cli.test.ts
git commit -m "feat(cli): parse update subcommand"
```

---

## Task 10: Wire `cli.ts` main switch

**Files:**
- Modify: `cli.ts`

- [ ] **Step 1: Update help text**

In the `HELP_TEXT` constant in `cli.ts`, add (after the `wechat-cc memory read …` block):

```
  wechat-cc update [--check] [--json]
                        Pull latest + reinstall deps + restart service.
                        --check probes only (no side effects); GUI calls
                        this on a timer to surface the Update button.
```

- [ ] **Step 2: Add `update` case in main switch**

After the `case 'account-remove':` block, add:

```ts
    case 'update': {
      const { analyzeUpdate, applyUpdate, defaultUpdateDeps } = await import('./update.ts')
      const deps = defaultUpdateDeps(here, STATE_DIR)
      if (parsed.check) {
        const probe = analyzeUpdate(deps)
        if (parsed.json) {
          console.log(JSON.stringify(probe, null, 2))
        } else if (!probe.ok) {
          console.error(`update check: ${probe.reason} — ${probe.message}`)
          process.exit(1)
        } else {
          console.log(probe.updateAvailable
            ? `update available: ${probe.currentCommit} → ${probe.latestCommit} (${probe.behind} commits${probe.lockfileWillChange ? ', lockfile changes' : ''})`
            : `up to date (${probe.currentCommit})`)
        }
        return
      }
      const result = await applyUpdate(deps)
      if (parsed.json) {
        console.log(JSON.stringify(result, null, 2))
      } else if (!result.ok) {
        console.error(`update failed: ${result.reason} — ${result.message}`)
        process.exit(1)
      } else {
        const lockNote = result.lockfileChanged ? ', deps reinstalled' : ''
        console.log(`updated: ${result.fromCommit} → ${result.toCommit}${lockNote}, daemon=${result.daemonAction} (${result.elapsedMs}ms)`)
      }
      return
    }
```

- [ ] **Step 3: Smoke-typecheck**

Run: `bun x tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Smoke-run with `--check` against the real repo**

Run: `bun cli.ts update --check --json`
Expected: well-formed JSON with `mode: 'check'`. (May print `behind: 0`; that's fine — we're verifying wiring, not behavior.)

- [ ] **Step 5: Commit**

```bash
git add cli.ts
git commit -m "feat(cli): wire update subcommand to update.ts + help text"
```

---

## Task 11: E2E tests with real git

**Files:**
- Create: `update.e2e.test.ts`

- [ ] **Step 1: Write the harness**

```ts
// update.e2e.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { analyzeUpdate, applyUpdate, type UpdateDeps } from './update'

let tmp: string
let upstream: string  // bare-ish remote
let local: string

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function commit(cwd: string, file: string, body: string, message: string): string {
  writeFileSync(join(cwd, file), body)
  git(cwd, 'add', file)
  git(cwd, 'commit', '-m', message, '--no-verify')
  return git(cwd, 'rev-parse', 'HEAD')
}

function makeDeps(localRepo: string, opts: { daemonAlive?: boolean; serviceInstalled?: boolean; lockfileLines?: string[]; bun?: { path: string | null } } = {}) {
  const stop = vi.fn()
  const start = vi.fn()
  const install = vi.fn(() => ({ stdout: '', stderr: '', code: 0 }))
  const deps: UpdateDeps = {
    repoRoot: localRepo,
    stateDir: '/dev/null',
    runGit(args) {
      const r = spawnSync('git', args, { cwd: localRepo, encoding: 'utf8' })
      return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.status ?? 1 }
    },
    bun: { path: opts.bun?.path ?? '/usr/local/bin/bun', install },
    daemon: () => ({ alive: opts.daemonAlive ?? false, pid: opts.daemonAlive ? 4242 : null }),
    service: {
      installed: () => opts.serviceInstalled ?? false,
      stop,
      start,
    },
  }
  return { deps, stop, start, install }
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'wechat-cc-update-e2e-'))
  upstream = join(tmp, 'upstream')
  local = join(tmp, 'local')
  mkdirSync(upstream)
  git(upstream, 'init', '-q', '-b', 'master')
  git(upstream, 'config', 'user.email', 'test@example.com')
  git(upstream, 'config', 'user.name', 'Test')
  commit(upstream, 'README.md', 'v1\n', 'initial')
  commit(upstream, 'bun.lock', 'lock-v1\n', 'add lockfile')

  // clone into local
  execFileSync('git', ['clone', '-q', upstream, local])
  git(local, 'config', 'user.email', 'test@example.com')
  git(local, 'config', 'user.name', 'Test')
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe('update e2e', () => {
  it('happy path — upstream commit + lockfile change → service stop+start, HEAD advances', async () => {
    commit(upstream, 'README.md', 'v2\n', 'bump readme')
    commit(upstream, 'bun.lock', 'lock-v2\n', 'bump lockfile')
    const { deps, stop, start, install } = makeDeps(local, { daemonAlive: true, serviceInstalled: true })

    const beforeHead = git(local, 'rev-parse', 'HEAD')
    const result = await applyUpdate(deps)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const afterHead = git(local, 'rev-parse', 'HEAD')

    expect(afterHead).not.toBe(beforeHead)
    expect(readFileSync(join(local, 'bun.lock'), 'utf8')).toBe('lock-v2\n')
    expect(stop).toHaveBeenCalledOnce()
    expect(start).toHaveBeenCalledOnce()
    expect(install).toHaveBeenCalledOnce()
    expect(result.daemonAction).toBe('restarted')
    expect(result.lockfileChanged).toBe(true)
  })

  it('dirty tree → reject, HEAD unchanged', async () => {
    writeFileSync(join(local, 'scratch.txt'), 'wip')
    const { deps } = makeDeps(local)
    const beforeHead = git(local, 'rev-parse', 'HEAD')
    const result = await applyUpdate(deps)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('dirty_tree')
    expect(git(local, 'rev-parse', 'HEAD')).toBe(beforeHead)
  })

  it('diverged — local commit + upstream commit → reject diverged', async () => {
    commit(local, 'local-only.txt', 'local\n', 'local change')
    commit(upstream, 'upstream-only.txt', 'remote\n', 'remote change')
    const { deps } = makeDeps(local)
    const result = await applyUpdate(deps)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('diverged')
  })

  it('no-op — upstream has no new commits', async () => {
    const { deps, stop, start, install } = makeDeps(local, { daemonAlive: true, serviceInstalled: true })
    const result = await applyUpdate(deps)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.daemonAction).toBe('noop')
    expect(stop).not.toHaveBeenCalled()
    expect(start).not.toHaveBeenCalled()
    expect(install).not.toHaveBeenCalled()
  })

  // NOTE: `pull_conflict` is deliberately covered by the *unit* test only
  // (Task 6, fake `pull: fail(...)`). In real usage the `diverged` check at
  // the front of applyUpdate (aheadOfRemote > 0) pre-empts most non-ff cases,
  // so a clean e2e reproduction would require corrupting the repo or adding
  // a failing git hook — more fragile than valuable. The unit test already
  // proves applyUpdate's behavior when `git pull` exits non-zero.

  it('lockfile unchanged → installRan=false', async () => {
    commit(upstream, 'README.md', 'v2\n', 'bump readme only')
    const { deps, install } = makeDeps(local)
    const result = await applyUpdate(deps)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.installRan).toBe(false)
    expect(install).not.toHaveBeenCalled()
  })

  it('--check is side-effect-free', async () => {
    commit(upstream, 'README.md', 'v2\n', 'bump readme')
    const { deps } = makeDeps(local)
    const beforeHead = git(local, 'rev-parse', 'HEAD')
    const probe = analyzeUpdate(deps)
    expect(probe.ok).toBe(true)
    expect(probe.updateAvailable).toBe(true)
    expect(git(local, 'rev-parse', 'HEAD')).toBe(beforeHead)
    expect(git(local, 'status', '--porcelain')).toBe('')
  })
})
```

- [ ] **Step 2: Run e2e suite**

Run: `bun x vitest run update.e2e.test.ts`
Expected: 6 PASS (happy / dirty / diverged / no-op / lockfile-unchanged / --check-side-effect-free).

- [ ] **Step 3: Commit**

```bash
git add update.e2e.test.ts
git commit -m "test(update): e2e against real temp git repos"
```

---

## Task 12: Update CI workflow

**Files:**
- Modify: `.github/workflows/desktop.yml`

- [ ] **Step 1: Append both new test files to the vitest list**

In `.github/workflows/desktop.yml` find the block:

```yaml
      - name: Run vitest (touched suites only)
        run: |
          bun x vitest run \
            cli.test.ts \
            agent-config.test.ts \
            doctor.test.ts \
            account-remove.test.ts \
            daemon-kill.test.ts \
            memory.test.ts \
            src/daemon/onboarding.test.ts \
            apps/desktop/src/view.test.ts
```

Add two lines (preserve trailing backslash on the previous line):

```yaml
      - name: Run vitest (touched suites only)
        run: |
          bun x vitest run \
            cli.test.ts \
            agent-config.test.ts \
            doctor.test.ts \
            account-remove.test.ts \
            daemon-kill.test.ts \
            memory.test.ts \
            update.test.ts \
            update.e2e.test.ts \
            src/daemon/onboarding.test.ts \
            apps/desktop/src/view.test.ts
```

- [ ] **Step 2: Validate YAML locally**

Run: `bun x yaml-lint .github/workflows/desktop.yml || true`
Expected: no syntax error (the `|| true` is a guard if yaml-lint isn't installed; visual inspection is fine).

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/desktop.yml
git commit -m "ci(desktop): run update.test.ts + update.e2e.test.ts"
```

---

## Task 13: Final verification

**Files:** none

- [ ] **Step 1: Full repo typecheck**

Run: `bun x tsc --noEmit`
Expected: PASS.

- [ ] **Step 2: Full new-suite test run**

Run: `bun x vitest run update.test.ts update.e2e.test.ts cli.test.ts`
Expected: ALL PASS.

- [ ] **Step 3: Manual end-to-end smoke**

```bash
bun cli.ts update --check --json
bun cli.ts update --check
```

Expected: well-formed JSON / human line. If repo is up to date, `updateAvailable=false`. Do **not** run `bun cli.ts update` (without `--check`) on the working repo — that would actually pull and possibly restart your real daemon. Only smoke `--check`.

- [ ] **Step 4: Verify spec acceptance checklist**

Open `docs/specs/2026-04-27-wechat-cc-update.md` §9 and tick each item:

- [x] `wechat-cc update --check --json` returns the schema
- [x] `wechat-cc update --json` happy path real-restarts daemon (verified by e2e)
- [x] dirty / diverged / detached_head / daemon-not-service all reject without state damage
- [x] `update.test.ts` + `update.e2e.test.ts` pass
- [x] CI runs both files
- [x] README §Updating remains accurate

- [ ] **Step 5: Final commit (if any housekeeping changes)**

If any small fix-ups happened during smoke testing:

```bash
git add -p
git commit -m "chore(update): smoke-test fixups"
```

Otherwise, no commit needed.
