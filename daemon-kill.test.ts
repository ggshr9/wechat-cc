import { describe, expect, it } from 'vitest'
import { killDaemonByPid, type KillDeps } from './daemon-kill'

function makeDeps(opts: {
  cmdline?: string | null
  diesAfter?: number  // how many seconds (in fake time) before isAlive flips to false; Infinity = never
  signalThrows?: boolean
}): { deps: KillDeps; sleeps: number[]; signals: Array<[number, string | number]> } {
  let elapsed = 0
  const sleeps: number[] = []
  const signals: Array<[number, string | number]> = []
  const dies = opts.diesAfter ?? Infinity
  const deps: KillDeps = {
    readCmdline: () => opts.cmdline ?? null,
    killSignal: (pid, sig) => {
      signals.push([pid, sig])
      if (opts.signalThrows && sig !== 0) throw new Error('EPERM')
      if (sig === 0 && elapsed >= dies) {
        const e = new Error('ESRCH') as NodeJS.ErrnoException
        e.code = 'ESRCH'
        throw e
      }
    },
    sleep: async (ms) => { elapsed += ms / 1000; sleeps.push(ms) },
  }
  return { deps, sleeps, signals }
}

describe('killDaemonByPid', () => {
  it('rejects invalid pids', async () => {
    const { deps } = makeDeps({})
    expect((await killDaemonByPid(deps, 0)).killed).toBe(false)
    expect((await killDaemonByPid(deps, -1)).killed).toBe(false)
    expect((await killDaemonByPid(deps, NaN)).killed).toBe(false)
  })

  it('refuses pids that do not look like the wechat-cc daemon (path traversal / typo guard)', async () => {
    const { deps } = makeDeps({ cmdline: '/usr/bin/firefox --some-flag' })
    const result = await killDaemonByPid(deps, 1234)
    expect(result.killed).toBe(false)
    expect(result.message).toMatch(/does not look like a wechat-cc daemon/)
  })

  it('returns "not found" when ps cannot read the pid', async () => {
    const { deps } = makeDeps({ cmdline: null })
    const result = await killDaemonByPid(deps, 999999)
    expect(result.killed).toBe(false)
    expect(result.message).toMatch(/not found/)
  })

  it('SIGTERM alone is enough when daemon shuts down within the grace window', async () => {
    const { deps, signals } = makeDeps({
      cmdline: '/home/x/.bun/bin/bun src/daemon/main.ts --dangerously',
      diesAfter: 1.0, // dies before the 1.5s SIGTERM grace
    })
    const result = await killDaemonByPid(deps, 4321)
    expect(result.killed).toBe(true)
    expect(result.message).toMatch(/SIGTERM/)
    expect(signals.find(([, sig]) => sig === 'SIGKILL')).toBeUndefined()
  })

  it('escalates to SIGKILL when SIGTERM grace window elapses', async () => {
    const { deps, signals } = makeDeps({
      cmdline: '/home/x/.bun/bin/bun cli.ts run --dangerously',
      diesAfter: 1.6, // alive past SIGTERM grace, dies before SIGKILL recheck
    })
    const result = await killDaemonByPid(deps, 4321)
    expect(result.killed).toBe(true)
    expect(result.message).toMatch(/SIGKILL/)
    expect(signals.find(([, sig]) => sig === 'SIGKILL')).toBeDefined()
  })

  it('reports failure when even SIGKILL does not work', async () => {
    const { deps } = makeDeps({
      cmdline: '/home/x/.bun/bin/bun cli.ts run',
      diesAfter: Infinity,
    })
    const result = await killDaemonByPid(deps, 4321)
    expect(result.killed).toBe(false)
    expect(result.message).toMatch(/still alive/)
  })

  it('accepts both cli.ts and src/daemon/main.ts entrypoints', async () => {
    const a = await killDaemonByPid(makeDeps({ cmdline: 'bun cli.ts run', diesAfter: 0.5 }).deps, 1)
    const b = await killDaemonByPid(makeDeps({ cmdline: 'bun src/daemon/main.ts --dangerously', diesAfter: 0.5 }).deps, 1)
    expect(a.killed).toBe(true)
    expect(b.killed).toBe(true)
  })
})
