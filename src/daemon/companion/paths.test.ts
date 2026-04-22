import { describe, it, expect } from 'vitest'
import { companionDir, profilePath, personaPath, configPath, runsPath, pushLogPath, personasDir } from './paths'
import { sep } from 'node:path'

describe('companion/paths', () => {
  const S = sep // platform-specific separator
  it('companionDir composes <state>/companion', () => {
    expect(companionDir('/state')).toBe(`${S}state${S}companion` || '/state/companion')
  })
  it('profilePath ends with profile.md', () => {
    expect(profilePath('/state')).toMatch(/profile\.md$/)
  })
  it('personaPath encodes name as filename', () => {
    expect(personaPath('/state', 'assistant')).toMatch(/assistant\.md$/)
    expect(personaPath('/state', 'companion')).toMatch(/companion\.md$/)
  })
  it('configPath ends with config.json', () => {
    expect(configPath('/state')).toMatch(/config\.json$/)
  })
  it('runsPath + pushLogPath end with .jsonl', () => {
    expect(runsPath('/state')).toMatch(/runs\.jsonl$/)
    expect(pushLogPath('/state')).toMatch(/push-log\.jsonl$/)
  })
  it('personasDir is under companionDir', () => {
    const pd = personasDir('/state')
    const cd = companionDir('/state')
    expect(pd.startsWith(cd)).toBe(true)
  })
})
