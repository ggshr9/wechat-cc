import { describe, it, expect } from 'vitest'
import { requestPushTick } from './companion-push'

describe('requestPushTick', () => {
  it('reads server.pid and signals SIGUSR2', () => {
    const killed: Array<{ pid: number; sig: string }> = []
    const res = requestPushTick({
      readPid: () => '7788\n',
      kill: (pid, sig) => killed.push({ pid, sig }),
    }, '/tmp/state')
    expect(res.pid).toBe(7788)
    expect(killed).toEqual([{ pid: 7788, sig: 'SIGUSR2' }])
  })

  it('throws when the daemon is not running here (no server.pid)', () => {
    expect(() => requestPushTick({ readPid: () => null, kill: () => {} }, '/tmp/state'))
      .toThrow(/没在本机运行/)
  })

  it('throws on an invalid pid', () => {
    expect(() => requestPushTick({ readPid: () => 'garbage', kill: () => {} }, '/tmp/state'))
      .toThrow(/无效/)
  })
})
