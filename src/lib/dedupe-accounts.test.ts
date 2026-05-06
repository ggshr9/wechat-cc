import { describe, it, expect } from 'vitest'
import { dedupeAccountsByUserId, SUPERSEDED_INFIX } from './dedupe-accounts'

// In-memory FS fixture builder. Keys are absolute paths; for dirs the value
// is the array of child names; for files it's the string content. mtimeMs
// is tracked separately so tests can simulate "newer dir wins" picks.
function fs(tree: Record<string, { type: 'dir'; children: string[]; mtimeMs?: number } | { type: 'file'; content: string; mtimeMs?: number }>) {
  const renames: Array<[string, string]> = []
  return {
    renames,
    deps: {
      exists: (p: string) => p in tree || renames.some(([_, to]) => to === p),
      readdir: (p: string) => {
        const node = tree[p]
        if (!node || node.type !== 'dir') throw new Error(`not a dir: ${p}`)
        return node.children
      },
      readFile: (p: string) => {
        const node = tree[p]
        if (!node || node.type !== 'file') throw new Error(`not a file: ${p}`)
        return node.content
      },
      stat: (p: string) => ({ mtimeMs: (tree[p] as any)?.mtimeMs ?? 0 }),
      rename: (from: string, to: string) => {
        renames.push([from, to])
        // Mutate tree so subsequent reads see the rename.
        if (from in tree) { tree[to] = tree[from]!; delete tree[from] }
      },
      now: () => new Date('2026-05-06T12:00:00Z').getTime(),
      log: () => {},
    },
  }
}

describe('dedupeAccountsByUserId', () => {
  it('returns no-op when no account dir exists', () => {
    const { deps } = fs({})
    const r = dedupeAccountsByUserId('/state/accounts', {}, deps)
    expect(r).toEqual({ archived: [], affectedUserIds: [] })
  })

  it('returns no-op when each userId has exactly one bot dir', () => {
    const { deps, renames } = fs({
      '/state/accounts': { type: 'dir', children: ['bot-a', 'bot-b'] },
      '/state/accounts/bot-a': { type: 'dir', children: ['account.json'], mtimeMs: 1000 },
      '/state/accounts/bot-a/account.json': { type: 'file', content: '{"userId":"u-1","botId":"a@bot"}' },
      '/state/accounts/bot-b': { type: 'dir', children: ['account.json'], mtimeMs: 2000 },
      '/state/accounts/bot-b/account.json': { type: 'file', content: '{"userId":"u-2","botId":"b@bot"}' },
    })
    const r = dedupeAccountsByUserId('/state/accounts', {}, deps)
    expect(r.archived).toHaveLength(0)
    expect(renames).toHaveLength(0)
  })

  it('archives the OLDER bot dir when same userId has two — newer mtime wins', () => {
    const { deps, renames } = fs({
      '/state/accounts': { type: 'dir', children: ['bot-old', 'bot-new'] },
      '/state/accounts/bot-old': { type: 'dir', children: ['account.json'], mtimeMs: 1000 },
      '/state/accounts/bot-old/account.json': { type: 'file', content: '{"userId":"u-shared","botId":"old@bot"}' },
      '/state/accounts/bot-new': { type: 'dir', children: ['account.json'], mtimeMs: 5000 },
      '/state/accounts/bot-new/account.json': { type: 'file', content: '{"userId":"u-shared","botId":"new@bot"}' },
    })
    const r = dedupeAccountsByUserId('/state/accounts', {}, deps)
    expect(r.affectedUserIds).toEqual(['u-shared'])
    expect(r.archived).toHaveLength(1)
    expect(renames).toEqual([
      ['/state/accounts/bot-old', `/state/accounts/bot-old${SUPERSEDED_INFIX}2026-05-06T12-00-00-000Z`],
    ])
  })

  it('honours opts.keepBotId override when caller knows which to keep', () => {
    const { deps, renames } = fs({
      '/state/accounts': { type: 'dir', children: ['bot-a', 'bot-b'] },
      '/state/accounts/bot-a': { type: 'dir', children: ['account.json'], mtimeMs: 5000 },
      '/state/accounts/bot-a/account.json': { type: 'file', content: '{"userId":"u-shared","botId":"a@bot"}' },
      '/state/accounts/bot-b': { type: 'dir', children: ['account.json'], mtimeMs: 1000 },
      '/state/accounts/bot-b/account.json': { type: 'file', content: '{"userId":"u-shared","botId":"b@bot"}' },
    })
    const r = dedupeAccountsByUserId('/state/accounts', { keepUserId: 'u-shared', keepBotId: 'b@bot' }, deps)
    // Even though bot-a has newer mtime, caller said keep b@bot
    expect(renames.map(([from]) => from)).toEqual(['/state/accounts/bot-a'])
    expect(r.affectedUserIds).toEqual(['u-shared'])
  })

  it('skips dirs already containing the SUPERSEDED_INFIX (idempotent)', () => {
    const { deps, renames } = fs({
      '/state/accounts': { type: 'dir', children: [`bot-old${SUPERSEDED_INFIX}2026-05-05T00-00-00Z`, 'bot-new'] },
      // The superseded dir's content would normally exist but we don't enumerate it
      'so loadAllAccounts skipping logic doesn\'t need it for dedup': { type: 'file', content: '' },
      '/state/accounts/bot-new': { type: 'dir', children: ['account.json'], mtimeMs: 5000 },
      '/state/accounts/bot-new/account.json': { type: 'file', content: '{"userId":"u-shared","botId":"new@bot"}' },
    })
    const r = dedupeAccountsByUserId('/state/accounts', {}, deps)
    expect(renames).toHaveLength(0)
    expect(r.archived).toHaveLength(0)
  })

  it('three-way collision: keeps newest, archives the other two', () => {
    const { deps, renames } = fs({
      '/state/accounts': { type: 'dir', children: ['bot-1', 'bot-2', 'bot-3'] },
      '/state/accounts/bot-1': { type: 'dir', children: ['account.json'], mtimeMs: 1000 },
      '/state/accounts/bot-1/account.json': { type: 'file', content: '{"userId":"u","botId":"b1"}' },
      '/state/accounts/bot-2': { type: 'dir', children: ['account.json'], mtimeMs: 5000 },
      '/state/accounts/bot-2/account.json': { type: 'file', content: '{"userId":"u","botId":"b2"}' },
      '/state/accounts/bot-3': { type: 'dir', children: ['account.json'], mtimeMs: 3000 },
      '/state/accounts/bot-3/account.json': { type: 'file', content: '{"userId":"u","botId":"b3"}' },
    })
    const r = dedupeAccountsByUserId('/state/accounts', {}, deps)
    expect(r.affectedUserIds).toEqual(['u'])
    // bot-2 is newest, kept. bot-1 and bot-3 archived.
    expect(renames.map(([from]) => from).sort()).toEqual([
      '/state/accounts/bot-1',
      '/state/accounts/bot-3',
    ])
  })

  it('skips dirs missing account.json (incomplete bind, leave alone for human triage)', () => {
    const { deps, renames } = fs({
      '/state/accounts': { type: 'dir', children: ['bot-broken', 'bot-good'] },
      '/state/accounts/bot-broken': { type: 'dir', children: [], mtimeMs: 1000 },
      '/state/accounts/bot-good': { type: 'dir', children: ['account.json'], mtimeMs: 5000 },
      '/state/accounts/bot-good/account.json': { type: 'file', content: '{"userId":"u","botId":"good"}' },
    })
    const r = dedupeAccountsByUserId('/state/accounts', {}, deps)
    expect(renames).toHaveLength(0)
    expect(r.affectedUserIds).toHaveLength(0)
  })

  it('skips dirs with malformed account.json (does not throw, does not archive)', () => {
    const { deps, renames } = fs({
      '/state/accounts': { type: 'dir', children: ['bot-bad', 'bot-good'] },
      '/state/accounts/bot-bad': { type: 'dir', children: ['account.json'], mtimeMs: 5000 },
      '/state/accounts/bot-bad/account.json': { type: 'file', content: 'NOT_JSON_{[' },
      '/state/accounts/bot-good': { type: 'dir', children: ['account.json'], mtimeMs: 1000 },
      '/state/accounts/bot-good/account.json': { type: 'file', content: '{"userId":"u","botId":"g"}' },
    })
    expect(() => dedupeAccountsByUserId('/state/accounts', {}, deps)).not.toThrow()
    expect(renames).toHaveLength(0)
  })

  it('skips dirs whose account.json lacks userId (legacy v0.1.x format)', () => {
    const { deps, renames } = fs({
      '/state/accounts': { type: 'dir', children: ['bot-legacy', 'bot-modern'] },
      '/state/accounts/bot-legacy': { type: 'dir', children: ['account.json'], mtimeMs: 1000 },
      '/state/accounts/bot-legacy/account.json': { type: 'file', content: '{"botId":"legacy"}' },
      '/state/accounts/bot-modern': { type: 'dir', children: ['account.json'], mtimeMs: 5000 },
      '/state/accounts/bot-modern/account.json': { type: 'file', content: '{"userId":"u","botId":"m"}' },
    })
    const r = dedupeAccountsByUserId('/state/accounts', {}, deps)
    expect(renames).toHaveLength(0)
    expect(r.affectedUserIds).toHaveLength(0)
  })

  it('logs each supersede event via deps.log', () => {
    const logs: Array<[string, string]> = []
    const { deps } = fs({
      '/state/accounts': { type: 'dir', children: ['bot-old', 'bot-new'] },
      '/state/accounts/bot-old': { type: 'dir', children: ['account.json'], mtimeMs: 1000 },
      '/state/accounts/bot-old/account.json': { type: 'file', content: '{"userId":"u","botId":"old@bot"}' },
      '/state/accounts/bot-new': { type: 'dir', children: ['account.json'], mtimeMs: 5000 },
      '/state/accounts/bot-new/account.json': { type: 'file', content: '{"userId":"u","botId":"new@bot"}' },
    })
    dedupeAccountsByUserId('/state/accounts', {}, { ...deps, log: (t, l) => logs.push([t, l]) })
    expect(logs.find(([t]) => t === 'BOOT_DEDUPE')).toBeDefined()
    expect(logs.find(([_, l]) => /superseded old@bot/.test(l) && /kept=new@bot/.test(l))).toBeDefined()
  })
})
