/**
 * Per-provider session jsonl path resolvers — used by canResume callbacks
 * to probe whether the SDK still has the session/thread on disk before
 * we ask it to resume.
 *
 *   Claude:  ~/.claude/projects/<encoded-cwd>/<session_id>.jsonl
 *   Codex:   ~/.codex/sessions/<YYYY>/<MM>/<DD>/<thread_id>.jsonl  (sharded)
 *
 * Codex's sharding caused RFC 03 P5 review #9: the original P0 impl
 * checked only the unsharded path which never matched real Codex output,
 * so resume always silently failed. Now does a bounded depth-3 walk.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export function claudeSessionJsonlPath(home: string, cwd: string, sessionId: string): string {
  const encoded = cwd.replace(/\//g, '-')
  return join(home, '.claude', 'projects', encoded, `${sessionId}.jsonl`)
}

export function codexSessionJsonlPaths(home: string, threadId: string): string[] {
  const root = join(home, '.codex', 'sessions')
  const candidates: string[] = [
    // Unsharded fallback first (cheapest existsSync check).
    join(root, `${threadId}.jsonl`),
    join(root, `${threadId}.json`),
  ]
  if (!existsSync(root)) return candidates
  try {
    // Walk: <root>/<YYYY>/<MM>/<DD>/<id>.{jsonl,json}
    // Bounded by Codex's known sharding scheme (year/month/day) so we
    // don't accidentally scan unbounded user dirs.
    const { readdirSync, statSync } = require('node:fs') as typeof import('node:fs')
    for (const year of safeReaddir(root, readdirSync)) {
      const yearDir = join(root, year)
      if (!isDir(yearDir, statSync)) continue
      for (const month of safeReaddir(yearDir, readdirSync)) {
        const monthDir = join(yearDir, month)
        if (!isDir(monthDir, statSync)) continue
        for (const day of safeReaddir(monthDir, readdirSync)) {
          const dayDir = join(monthDir, day)
          if (!isDir(dayDir, statSync)) continue
          candidates.push(
            join(dayDir, `${threadId}.jsonl`),
            join(dayDir, `${threadId}.json`),
          )
        }
      }
    }
  } catch {
    // permissions / EIO — fall back to unsharded candidates only.
  }
  return candidates
}

function safeReaddir(p: string, readdirSync: typeof import('node:fs').readdirSync): string[] {
  try { return readdirSync(p) } catch { return [] }
}

function isDir(p: string, statSync: typeof import('node:fs').statSync): boolean {
  try { return statSync(p).isDirectory() } catch { return false }
}
