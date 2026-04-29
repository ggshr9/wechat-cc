/**
 * Cross-session full-text search.
 *
 * Naive case-insensitive substring scan across every session jsonl
 * registered in sessions.json. Returns hits with ~140-char snippets
 * around each match. SQLite FTS upgrade tracked for v0.5 — the current
 * approach is fast enough at <100 sessions × <1000 turns each.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeSessionStore } from '../../core/session-store'
import { resolveProjectJsonlPath } from './path-resolver'

export interface SearchHit {
  alias: string
  session_id: string
  turn_index: number
  snippet: string         // ~140 chars around match
}

export async function searchAcrossSessions(
  query: string,
  opts: { limit?: number; stateDir: string },
): Promise<SearchHit[]> {
  const limit = opts.limit ?? 50
  if (!query || query.trim().length === 0) return []

  const store = makeSessionStore(join(opts.stateDir, 'sessions.json'), { debounceMs: 0 })
  const all = store.all()
  const hits: SearchHit[] = []
  const needle = query.toLowerCase()

  for (const [alias, rec] of Object.entries(all)) {
    const path = resolveProjectJsonlPath(alias, rec.session_id)
    if (!existsSync(path)) continue
    const lines = readFileSync(path, 'utf8').split('\n').filter(l => l.length > 0)
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const lower = line.toLowerCase()
      const idx = lower.indexOf(needle)
      if (idx < 0) continue
      const start = Math.max(0, idx - 60)
      const end = Math.min(line.length, idx + needle.length + 60)
      hits.push({
        alias,
        session_id: rec.session_id,
        turn_index: i,
        snippet: line.slice(start, end),
      })
      if (hits.length >= limit) return hits
    }
  }
  return hits
}
