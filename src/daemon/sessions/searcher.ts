/**
 * Cross-session full-text search.
 *
 * Naive case-insensitive substring scan across every session jsonl
 * registered in sessions.json. Returns hits with ~140-char snippets
 * around each match plus the parsed turn JSON so the client can project
 * snippets through the same compact-mode lens used in the detail view.
 *
 * SQLite FTS upgrade tracked for v0.5 — the current approach is fast
 * enough at <100 sessions × <1000 turns each.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeSessionStore } from '../../core/session-store'
import type { Db } from '../../lib/db'
import { resolveProjectJsonlPath } from './path-resolver'

export interface SearchHit {
  alias: string
  session_id: string
  turn_index: number
  snippet: string                  // ~140 chars around raw-line match (detailed mode)
  turn: unknown                    // parsed JSON for the matched line, or null on parse failure
  session_has_reply_tool: boolean  // computed once per session — gates compact-mode wrap-up suppression
}

// Cheap string check — the tool name is always quoted in the JSON
// serialization, so substring search beats parsing every line just to
// detect this flag.
const REPLY_TOOL_MARKER = '"mcp__wechat__reply"'

export async function searchAcrossSessions(
  query: string,
  opts: { limit?: number; stateDir: string; home?: string; db: Db },
): Promise<SearchHit[]> {
  const limit = opts.limit ?? 50
  if (!query || query.trim().length === 0) return []

  const store = makeSessionStore(opts.db, { migrateFromFile: join(opts.stateDir, 'sessions.json') })
  const all = store.all()
  const hits: SearchHit[] = []
  const needle = query.toLowerCase()

  for (const [alias, rec] of Object.entries(all)) {
    const path = resolveProjectJsonlPath(alias, rec.session_id, opts.home ? { home: opts.home } : {})
    if (!existsSync(path)) continue
    const lines = readFileSync(path, 'utf8').split('\n').filter(l => l.length > 0)
    const sessionHasReplyTool = lines.some(l => l.includes(REPLY_TOOL_MARKER))

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      const lower = line.toLowerCase()
      const idx = lower.indexOf(needle)
      if (idx < 0) continue
      const start = Math.max(0, idx - 60)
      const end = Math.min(line.length, idx + needle.length + 60)
      let parsed: unknown = null
      try { parsed = JSON.parse(line) } catch { /* leave null — client treats as un-projectable */ }
      hits.push({
        alias,
        session_id: rec.session_id,
        turn_index: i,
        snippet: line.slice(start, end),
        turn: parsed,
        session_has_reply_tool: sessionHasReplyTool,
      })
      if (hits.length >= limit) return hits
    }
  }
  return hits
}
