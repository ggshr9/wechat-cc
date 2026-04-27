import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { companionDir, configPath } from './paths'

describe('companion paths', () => {
  const base = '/tmp/fake-state'

  it('companionDir = <stateDir>/companion', () => {
    expect(companionDir(base)).toBe(join(base, 'companion'))
  })

  it('configPath is under companionDir', () => {
    expect(configPath(base)).toBe(join(base, 'companion', 'config.json'))
  })
})
