import { describe, it, expect, vi } from 'vitest'
import { LifecycleSet, LifecycleStopError, type Lifecycle } from './lifecycle'

const mkLog = () => {
  const lines: string[] = []
  return { log: (tag: string, line: string) => lines.push(`${tag} ${line}`), lines }
}

const mkLifecycle = (name: string, stop: () => Promise<void>): Lifecycle => ({ name, stop })

describe('LifecycleSet', () => {
  it('stops handles in reverse registration order (LIFO)', async () => {
    const order: string[] = []
    const { log } = mkLog()
    const lc = new LifecycleSet(log)
    lc.register(mkLifecycle('a', async () => { order.push('a') }))
    lc.register(mkLifecycle('b', async () => { order.push('b') }))
    lc.register(mkLifecycle('c', async () => { order.push('c') }))
    await lc.stopAll()
    expect(order).toEqual(['c', 'b', 'a'])
  })

  it('runs stops sequentially, not concurrently', async () => {
    const { log } = mkLog()
    const lc = new LifecycleSet(log)
    let aDone = false
    lc.register(mkLifecycle('a', async () => {
      await new Promise(r => setTimeout(r, 30))
      aDone = true
    }))
    lc.register(mkLifecycle('b', async () => {
      // b stops first (LIFO); when its stop returns, a hasn't started
      expect(aDone).toBe(false)
    }))
    await lc.stopAll()
    expect(aDone).toBe(true)
  })

  it('continues stopping after one failure and aggregates the error', async () => {
    const { log } = mkLog()
    const lc = new LifecycleSet(log)
    const stopped: string[] = []
    lc.register(mkLifecycle('a', async () => { stopped.push('a') }))
    lc.register(mkLifecycle('b', async () => { throw new Error('boom') }))
    lc.register(mkLifecycle('c', async () => { stopped.push('c') }))
    await expect(lc.stopAll()).rejects.toBeInstanceOf(LifecycleStopError)
    expect(stopped).toEqual(['c', 'a'])
  })

  it('times out individual stop after 5000ms', async () => {
    vi.useFakeTimers()
    const { log } = mkLog()
    const lc = new LifecycleSet(log)
    lc.register(mkLifecycle('hang', () => new Promise(() => { /* never resolves */ })))
    const stopPromise = lc.stopAll()
    await vi.advanceTimersByTimeAsync(5001)
    await expect(stopPromise).rejects.toBeInstanceOf(LifecycleStopError)
    vi.useRealTimers()
  })

  it('is a no-op for empty set', async () => {
    const { log } = mkLog()
    const lc = new LifecycleSet(log)
    await expect(lc.stopAll()).resolves.toBeUndefined()
  })

  it('logs name + duration on success', async () => {
    const { log, lines } = mkLog()
    const lc = new LifecycleSet(log)
    lc.register(mkLifecycle('alpha', async () => {}))
    await lc.stopAll()
    expect(lines.some(l => l.startsWith('LIFECYCLE stopped alpha'))).toBe(true)
  })

  it('logs failure with name + error message', async () => {
    const { log, lines } = mkLog()
    const lc = new LifecycleSet(log)
    lc.register(mkLifecycle('beta', async () => { throw new Error('xyz') }))
    await expect(lc.stopAll()).rejects.toBeInstanceOf(LifecycleStopError)
    expect(lines.some(l => l.includes('stop beta failed') && l.includes('xyz'))).toBe(true)
  })

  it('LifecycleStopError carries failed/total/details', async () => {
    const { log } = mkLog()
    const lc = new LifecycleSet(log)
    lc.register(mkLifecycle('a', async () => {}))
    lc.register(mkLifecycle('b', async () => { throw new Error('x') }))
    try { await lc.stopAll(); throw new Error('should have thrown') }
    catch (err) {
      expect(err).toBeInstanceOf(LifecycleStopError)
      const e = err as LifecycleStopError
      expect(e.failed).toBe(1)
      expect(e.total).toBe(2)
      expect(e.details).toHaveLength(1)
      expect(e.details[0]!.name).toBe('b')
    }
  })
})

import { Ref, wireRef } from './lifecycle'

describe('Ref<T>', () => {
  it('current is null by default', () => {
    const ref = new Ref<string>('test')
    expect(ref.current).toBeNull()
    expect(ref.name).toBe('test')
  })

  it('set assigns value the first time', () => {
    const ref = new Ref<string>('test')
    ref.set('hello')
    expect(ref.current).toBe('hello')
  })

  it('set throws on second assignment', () => {
    const ref = new Ref<string>('polling')
    ref.set('a')
    expect(() => ref.set('b')).toThrow(/Ref<polling>: already set/)
  })

  it('deref throws when ref is unset', () => {
    const ref = new Ref<string>('guard')
    expect(() => ref.deref('admin /health needs polling alive'))
      .toThrow(/Ref<guard>: accessed before set \(admin/)
  })

  it('deref returns value when ref is set', () => {
    const ref = new Ref<string>('test')
    ref.set('hello')
    expect(ref.deref()).toBe('hello')
  })
})

describe('wireRef', () => {
  it('is equivalent to ref.set', () => {
    const ref = new Ref<string>('test')
    wireRef(ref, 'value')
    expect(ref.current).toBe('value')
  })

  it('throws on double wireRef (delegates to Ref.set)', () => {
    const ref = new Ref<string>('test')
    wireRef(ref, 'first')
    expect(() => wireRef(ref, 'second')).toThrow(/already set/)
  })
})
