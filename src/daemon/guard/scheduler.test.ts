import { describe, it, expect, vi } from 'vitest'
import { startGuardScheduler } from './scheduler'

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (err: unknown) => void
  const p = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { p, resolve, reject }
}

function makeDeps(overrides: Partial<Parameters<typeof startGuardScheduler>[0]> = {}) {
  return {
    pollMs: 1_000_000,  // effectively never auto-tick in tests; we drive via pokeNow
    isEnabled: () => true,
    probeUrl: () => 'https://canary.test/204',
    ipifyUrl: () => 'https://ipify.test',
    ...overrides,
  } satisfies Parameters<typeof startGuardScheduler>[0]
}

describe('startGuardScheduler', () => {
  it('first poll always probes, even when IP is steady', async () => {
    const probeFn = vi.fn(async () => ({ reachable: true, ms: 12 }))
    const sched = startGuardScheduler(makeDeps({
      fetchPublicIp: async () => ({ ip: '1.2.3.4' }),
      probeReachable: probeFn,
    }))
    await sched.pokeNow()
    expect(probeFn).toHaveBeenCalledTimes(1)
    expect(sched.current().ip).toBe('1.2.3.4')
    expect(sched.current().reachable).toBe(true)
    await sched.stop()
  })

  it('skips the probe when IP hasnt changed', async () => {
    const probeFn = vi.fn(async () => ({ reachable: true, ms: 12 }))
    const sched = startGuardScheduler(makeDeps({
      fetchPublicIp: async () => ({ ip: '1.2.3.4' }),
      probeReachable: probeFn,
    }))
    await sched.pokeNow()  // first → probes
    await sched.pokeNow()  // IP unchanged → no probe
    await sched.pokeNow()
    expect(probeFn).toHaveBeenCalledTimes(1)
    await sched.stop()
  })

  it('re-probes when IP changes; fires onStateChange when reachable flips', async () => {
    const ips = ['1.2.3.4', '1.2.3.4', '5.6.7.8']
    const probes = [
      { reachable: true, ms: 5 },
      { reachable: false, ms: null, error: 'timeout' },
    ]
    let ipIdx = 0
    let probeIdx = 0
    const stateChanges: Array<[boolean, boolean]> = []
    const sched = startGuardScheduler(makeDeps({
      fetchPublicIp: async () => ({ ip: ips[ipIdx++] ?? null }),
      probeReachable: async () => probes[probeIdx++]!,
      onStateChange: (prev, next) => { stateChanges.push([prev.reachable, next.reachable]) },
    }))
    await sched.pokeNow()  // ip=1.2.3.4 first → probe true
    await sched.pokeNow()  // ip=1.2.3.4 unchanged → skip
    await sched.pokeNow()  // ip=5.6.7.8 changed → probe false → flip
    expect(probeIdx).toBe(2)
    expect(sched.current().reachable).toBe(false)
    expect(sched.current().ip).toBe('5.6.7.8')
    // Two state changes: initial null→1.2.3.4 (ip changed), and 1.2.3.4→5.6.7.8 reachable flip.
    expect(stateChanges.length).toBeGreaterThanOrEqual(1)
    expect(stateChanges[stateChanges.length - 1]).toEqual([true, false])
    await sched.stop()
  })

  it('skips ticks entirely when isEnabled() returns false', async () => {
    const ipFn = vi.fn(async () => ({ ip: '1.2.3.4' }))
    const sched = startGuardScheduler(makeDeps({
      isEnabled: () => false,
      fetchPublicIp: ipFn,
      probeReachable: async () => ({ reachable: true, ms: 0 }),
    }))
    await sched.pokeNow()
    await sched.pokeNow()
    expect(ipFn).not.toHaveBeenCalled()
    await sched.stop()
  })

  it('an in-flight tick does not double-fire when pokeNow is called concurrently', async () => {
    const block = deferred<{ ip: string }>()
    const ipFn = vi.fn(async () => block.p)
    const sched = startGuardScheduler(makeDeps({
      fetchPublicIp: ipFn,
      probeReachable: async () => ({ reachable: true, ms: 0 }),
    }))
    const a = sched.pokeNow()
    const b = sched.pokeNow()  // concurrent — should be a no-op
    block.resolve({ ip: '1.2.3.4' })
    await Promise.all([a, b])
    expect(ipFn).toHaveBeenCalledTimes(1)
    await sched.stop()
  })
})
