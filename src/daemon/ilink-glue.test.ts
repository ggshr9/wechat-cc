import { describe, it, expect } from 'vitest'
import { loadAllAccounts } from './ilink-glue'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('loadAllAccounts', () => {
  it('returns empty array when accounts/ dir does not exist', async () => {
    const state = mkdtempSync(join(tmpdir(), 'wcc-state-'))
    const accts = await loadAllAccounts(state)
    expect(accts).toEqual([])
  })

  it('reads each subdir under accounts/ as an account', async () => {
    const state = mkdtempSync(join(tmpdir(), 'wcc-state-'))
    const acct = join(state, 'accounts', 'A1')
    mkdirSync(acct, { recursive: true })
    writeFileSync(join(acct, 'account.json'), JSON.stringify({ botId: 'b', userId: 'u', baseUrl: 'https://x' }))
    writeFileSync(join(acct, 'token'), 'TOKEN\n')
    const accts = await loadAllAccounts(state)
    expect(accts).toHaveLength(1)
    expect(accts[0]!.id).toBe('A1')
    expect(accts[0]!.botId).toBe('b')
    expect(accts[0]!.userId).toBe('u')
    expect(accts[0]!.baseUrl).toBe('https://x')
    expect(accts[0]!.token).toBe('TOKEN')
    expect(accts[0]!.syncBuf).toBe('')
  })

  it('reads sync_buf when present', async () => {
    const state = mkdtempSync(join(tmpdir(), 'wcc-state-'))
    const acct = join(state, 'accounts', 'A2')
    mkdirSync(acct, { recursive: true })
    writeFileSync(join(acct, 'account.json'), JSON.stringify({ botId: 'b', userId: 'u', baseUrl: 'https://x' }))
    writeFileSync(join(acct, 'token'), 'T')
    writeFileSync(join(acct, 'sync_buf'), 'opaque-sync-buf-contents')
    const accts = await loadAllAccounts(state)
    expect(accts[0]!.syncBuf).toBe('opaque-sync-buf-contents')
  })

  it('skips subdirs missing account.json or token', async () => {
    const state = mkdtempSync(join(tmpdir(), 'wcc-state-'))
    const complete = join(state, 'accounts', 'good')
    const partial = join(state, 'accounts', 'bad')
    mkdirSync(complete, { recursive: true })
    mkdirSync(partial, { recursive: true })
    writeFileSync(join(complete, 'account.json'), JSON.stringify({ botId: 'b', userId: 'u', baseUrl: 'https://x' }))
    writeFileSync(join(complete, 'token'), 'T')
    // partial has no files
    const accts = await loadAllAccounts(state)
    expect(accts.map(a => a.id)).toEqual(['good'])
  })
})
