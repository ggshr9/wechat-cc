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

  // ── Edge cases that could mis-archive a freshly-bound bot ────────────
  // The boot-time dedupe (main.ts:38) runs with empty opts, so its only
  // signal for "which is newer" is filesystem mtime. On fast SSDs the two
  // dirs from a quick remove+rescan can land within the same ms tick, and
  // the tiebreak is `b.botId.localeCompare(a.botId)` (descending). If the
  // tiebreak doesn't agree with the actual scan order, the FRESH bot dir
  // gets archived — daemon then loads only the now-dead old bot.

  it('tied mtimes + lex tiebreak: lex-larger botId wins regardless of true scan order', () => {
    // Both dirs at mtimeMs=1000. Lex desc picks 'zzz@bot' over 'aaa@bot'.
    // If the user actually scanned zzz first then aaa, aaa is the new bot
    // but lex picks zzz → archives aaa → the FRESH bind is lost.
    const { deps, renames } = fs({
      '/state/accounts': { type: 'dir', children: ['bot-aaa', 'bot-zzz'] },
      '/state/accounts/bot-aaa': { type: 'dir', children: ['account.json'], mtimeMs: 1000 },
      '/state/accounts/bot-aaa/account.json': { type: 'file', content: '{"userId":"u","botId":"aaa@bot"}' },
      '/state/accounts/bot-zzz': { type: 'dir', children: ['account.json'], mtimeMs: 1000 },
      '/state/accounts/bot-zzz/account.json': { type: 'file', content: '{"userId":"u","botId":"zzz@bot"}' },
    })
    const r = dedupeAccountsByUserId('/state/accounts', {}, deps)
    // Confirms: tiebreak archives the lex-smaller dir, regardless of which
    // scan was actually newer in wall-clock terms. This is a known mis-
    // archive risk when boot dedupe runs on fast SSDs without an explicit
    // keepBotId. Setup-flow's dedupe is unaffected (it always passes
    // keepBotId), but a daemon restart between scans + an mtime tie can
    // surface this.
    expect(renames.map(([from]) => from)).toEqual(['/state/accounts/bot-aaa'])
    expect(r.affectedUserIds).toEqual(['u'])
  })

  it('legacy account.json without botId field: lookup falls back to dir name (no false match)', () => {
    // If a legacy/half-written account.json has no botId field, dedupe-
    // accounts.ts:85 falls back to using the directory name as the botId.
    // Scenario: scan-time dedupe asks for keepBotId="new@bot" (raw,
    // unsanitised), but a stale dir's account.json yields botId="bot-old"
    // (dir name fallback). The `e.botId === wantedBotId` check fails and
    // `e.dir.endsWith(wantedBotId)` also fails (sanitised vs raw), so
    // dedupe falls through to mtime sort. If mtimes are correct, that
    // still picks the right one — but if the legacy dir has a fresher
    // mtime (e.g. it was touch'd by some other code), the FRESH bind
    // could be archived.
    const { deps, renames } = fs({
      '/state/accounts': { type: 'dir', children: ['bot-stale', 'bot-fresh'] },
      // Stale: legacy file, no botId field, but mtime is freshest
      '/state/accounts/bot-stale': { type: 'dir', children: ['account.json'], mtimeMs: 9999 },
      '/state/accounts/bot-stale/account.json': { type: 'file', content: '{"userId":"u-shared"}' },
      // Fresh: explicit botId, but mtime is older
      '/state/accounts/bot-fresh': { type: 'dir', children: ['account.json'], mtimeMs: 5000 },
      '/state/accounts/bot-fresh/account.json': { type: 'file', content: '{"userId":"u-shared","botId":"fresh@bot"}' },
    })
    // Caller asked to keep fresh@bot (the just-scanned one). But the lookup
    // can't find e.botId === "fresh@bot" in the stale dir (botId fallback
    // is "bot-stale"), so explicit-keep works — fresh is kept correctly.
    const r = dedupeAccountsByUserId('/state/accounts', { keepUserId: 'u-shared', keepBotId: 'fresh@bot' }, deps)
    expect(renames.map(([from]) => from)).toEqual(['/state/accounts/bot-stale'])
    expect(r.affectedUserIds).toEqual(['u-shared'])
  })

  it('empty keepBotId falls through to mtime sort (boot-time dedupe semantics)', () => {
    // Boot-time call: `dedupeAccountsByUserId(accountsDir, {})`. Verifies
    // that when caller passes no keepUserId/keepBotId, the explicit-keep
    // branch is skipped entirely and we go straight to mtime tiebreak.
    const { deps, renames } = fs({
      '/state/accounts': { type: 'dir', children: ['bot-A', 'bot-B'] },
      '/state/accounts/bot-A': { type: 'dir', children: ['account.json'], mtimeMs: 1000 },
      '/state/accounts/bot-A/account.json': { type: 'file', content: '{"userId":"u","botId":"A@bot"}' },
      '/state/accounts/bot-B': { type: 'dir', children: ['account.json'], mtimeMs: 9000 },
      '/state/accounts/bot-B/account.json': { type: 'file', content: '{"userId":"u","botId":"B@bot"}' },
    })
    const r = dedupeAccountsByUserId('/state/accounts', {}, deps)
    expect(renames.map(([from]) => from)).toEqual(['/state/accounts/bot-A'])
    expect(r.affectedUserIds).toEqual(['u'])
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
