import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { searchAcrossSessions } from './searcher'

describe('searchAcrossSessions', () => {
  let stateDir: string
  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'searcher-'))
  })
  afterEach(() => rmSync(stateDir, { recursive: true, force: true }))

  it('returns empty for empty query', async () => {
    expect(await searchAcrossSessions('', { stateDir })).toEqual([])
    expect(await searchAcrossSessions('   ', { stateDir })).toEqual([])
  })

  it('returns empty when sessions.json has no aliases', async () => {
    writeFileSync(join(stateDir, 'sessions.json'), JSON.stringify({ version: 1, sessions: {} }))
    expect(await searchAcrossSessions('anything', { stateDir })).toEqual([])
  })

  it('returns empty when alias maps to a missing jsonl', async () => {
    writeFileSync(join(stateDir, 'sessions.json'), JSON.stringify({
      version: 1,
      sessions: { compass: { session_id: 's_nonexistent', last_used_at: '2026-01-01T00:00:00Z' } },
    }))
    expect(await searchAcrossSessions('foo', { stateDir })).toEqual([])
  })
})
