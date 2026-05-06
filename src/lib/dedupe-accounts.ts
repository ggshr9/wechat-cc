/**
 * dedupe-accounts.ts — collapse duplicate ilink bot bindings to one per
 * wechat userId.
 *
 * Why this exists: ilink only allows one active bot per wechat user
 * account — when a user re-scans the QR, the old bot's session is
 * invalidated server-side. But locally, every scan creates a fresh
 * `accounts/<botId>/` dir, and we never cleaned up the stale ones.
 * Effects: dashboard shows "two 顾时瑞" rows with different botIds, the
 * daemon polls a session-expired bot for hours, /health admin command
 * has to triage manually.
 *
 * Strategy: scan account.json files, group by userId, keep the newest
 * (by directory mtime; tiebreak by directory name desc), and rename the
 * older ones to `<dir>.superseded.<iso8601>`. The `.superseded.` infix
 * is what `loadAllAccounts` filters on — superseded dirs are invisible
 * to the daemon's poll loop without being deleted (so we keep the
 * audit trail / can restore if a dedupe was wrong).
 *
 * Called from:
 *   - daemon boot (`src/daemon/main.ts`) — handles legacy state
 *   - setup-flow `persistConfirmedAccount` — handles fresh re-scans
 *
 * Idempotent: running twice is a no-op (already-superseded dirs are
 * skipped by the readdir filter).
 */

import { existsSync, readdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'

export interface DedupeAccountsDeps {
  exists?: (p: string) => boolean
  readdir?: (p: string) => string[]
  readFile?: (p: string) => string
  rename?: (from: string, to: string) => void
  stat?: (p: string) => { mtimeMs: number }
  now?: () => number
  log?: (tag: string, line: string) => void
}

export interface DedupeResult {
  /** Archived dirs, full path to `<...>.superseded.<iso>`. */
  archived: string[]
  /** userIds whose group had duplicates. */
  affectedUserIds: string[]
}

/** Filename infix that marks a dir as archived; loadAllAccounts skips these. */
export const SUPERSEDED_INFIX = '.superseded.'

/**
 * Scan `<stateDir>/accounts/`, group by userId, archive duplicates.
 *
 * `keepBotId` (optional) overrides the "newest mtime wins" rule for the
 * specified userId — useful from setup-flow to force-keep the just-written
 * account instead of relying on filesystem timestamps which may not have
 * incremented yet on fast SSDs.
 */
export function dedupeAccountsByUserId(
  accountsDir: string,
  opts: { keepUserId?: string; keepBotId?: string } = {},
  deps: DedupeAccountsDeps = {},
): DedupeResult {
  const exists = deps.exists ?? existsSync
  const readdir = deps.readdir ?? readdirSync
  const readFile = deps.readFile ?? ((p: string) => readFileSync(p, 'utf8'))
  const rename = deps.rename ?? renameSync
  const stat = deps.stat ?? ((p: string) => statSync(p))
  const now = deps.now ?? (() => Date.now())
  const log = deps.log ?? (() => {})

  if (!exists(accountsDir)) return { archived: [], affectedUserIds: [] }

  type Entry = { dir: string; botId: string; userId: string; mtimeMs: number }
  const entries: Entry[] = []
  for (const name of readdir(accountsDir)) {
    if (name.includes(SUPERSEDED_INFIX)) continue  // already archived
    const acctDir = join(accountsDir, name)
    const metaPath = join(acctDir, 'account.json')
    if (!exists(metaPath)) continue
    let userId = ''; let botId = ''
    try {
      const meta = JSON.parse(readFile(metaPath)) as { userId?: string; botId?: string }
      userId = typeof meta.userId === 'string' ? meta.userId : ''
      botId = typeof meta.botId === 'string' ? meta.botId : name
    } catch { continue }  // malformed account.json — skip, don't archive
    if (!userId) continue  // legacy entry without userId — leave alone
    let mtimeMs = 0
    try { mtimeMs = stat(acctDir).mtimeMs } catch { /* default 0 */ }
    entries.push({ dir: acctDir, botId, userId, mtimeMs })
  }

  // Group by userId.
  const byUserId = new Map<string, Entry[]>()
  for (const e of entries) {
    if (!byUserId.has(e.userId)) byUserId.set(e.userId, [])
    byUserId.get(e.userId)!.push(e)
  }

  const archived: string[] = []
  const affectedUserIds: string[] = []
  const isoNow = new Date(now()).toISOString().replace(/[:.]/g, '-')

  for (const [userId, group] of byUserId) {
    if (group.length < 2) continue
    affectedUserIds.push(userId)

    // Pick which to keep:
    //   - if caller asked, keep that botId
    //   - else: newest mtime wins; tiebreak = lexicographic botId desc (stable)
    let keep: Entry
    if (opts.keepUserId === userId && opts.keepBotId) {
      const wantedBotId = opts.keepBotId
      const explicit = group.find(e => e.botId === wantedBotId || e.dir.endsWith(wantedBotId))
      keep = explicit ?? group.slice().sort((a, b) => b.mtimeMs - a.mtimeMs || b.botId.localeCompare(a.botId))[0]!
    } else {
      keep = group.slice().sort((a, b) => b.mtimeMs - a.mtimeMs || b.botId.localeCompare(a.botId))[0]!
    }

    for (const e of group) {
      if (e === keep) continue
      const dest = `${e.dir}${SUPERSEDED_INFIX}${isoNow}`
      try {
        rename(e.dir, dest)
        archived.push(dest)
        log('BOOT_DEDUPE', `superseded ${e.botId} (userId=${userId} kept=${keep.botId})`)
      } catch (err) {
        log('BOOT_DEDUPE', `rename failed for ${e.dir}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  return { archived, affectedUserIds }
}
