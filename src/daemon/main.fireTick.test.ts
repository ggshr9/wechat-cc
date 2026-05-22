import { describe, it, expect } from 'vitest'

describe('DaemonHandle.fireTick', () => {
  it('the DaemonHandle type exposes fireTick', () => {
    // Type-level assertion — proves the field is on the interface and prevents
    // accidental removal. End-to-end behavior is exercised by the daemon-shim
    // tests in Task 7.
    type Handle = import('./main').DaemonHandle
    const witness: Pick<Handle, 'fireTick'> = {
      fireTick: async (_kind, _at) => {},
    }
    expect(typeof witness.fireTick).toBe('function')
  })
})
