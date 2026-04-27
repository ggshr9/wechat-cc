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

function makeDeps(localRepo: string, opts: { daemonAlive?: boolean; serviceInstalled?: boolean; bun?: { path: string | null } } = {}) {
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
  // Disable CRLF normalization so file content round-trips byte-exact on
  // Windows runners (default `core.autocrlf=true` on git-for-Windows turns
  // checked-out LF into CRLF, breaking the bun.lock content assertion).
  git(upstream, 'config', 'core.autocrlf', 'false')
  commit(upstream, 'README.md', 'v1\n', 'initial')
  commit(upstream, 'bun.lock', 'lock-v1\n', 'add lockfile')

  // clone into local with autocrlf forced off via -c, otherwise git-for-Windows
  // applies its system-level autocrlf=true during checkout *before* a repo-local
  // setting could override it, leaving the working tree dirty after clone.
  execFileSync('git', ['-c', 'core.autocrlf=false', 'clone', '-q', upstream, local])
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
