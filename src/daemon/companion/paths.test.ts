import { describe, expect, it } from 'vitest'
import { companionDir, configPath } from './paths'

describe('companion paths', () => {
  const base = '/tmp/fake-state'

  it('companionDir = <stateDir>/companion', () => {
    expect(companionDir(base)).toBe('/tmp/fake-state/companion')
  })

  it('configPath is under companionDir', () => {
    expect(configPath(base)).toBe('/tmp/fake-state/companion/config.json')
  })
})
