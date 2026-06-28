/**
 * internal-api file-locate route — admin-only on-demand file search over the
 * owner's computer. Stateless: wraps the pure lib/locate-files core. Searches
 * caller-supplied roots (the agent passes dirs it learned in locations.md)
 * followed by the default life dirs. Returns metadata only — never file bodies.
 * Admin-tier per route-tiers.ts.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { type RouteTable } from './types'
import { locateFiles } from '../../lib/locate-files'

/** The zero-config default search roots. Single source of truth. */
export function defaultLifeDirs(home: string = homedir()): string[] {
  return [join(home, 'Desktop'), join(home, 'Documents'), join(home, 'Downloads')]
}

export function fileRoutes(): RouteTable {
  return {
    'GET /v1/locate': (q) => {
      const query = q.get('q') ?? undefined
      const raw = q.get('mode') ?? (query ? 'name' : 'browse')
      const VALID_MODES = new Set(['name', 'content', 'browse'])
      const mode = VALID_MODES.has(raw) ? (raw as 'name' | 'content' | 'browse') : 'name'
      const extraRoots = q.getAll('root').filter(r => r.startsWith('/'))   // absolute only
      const roots = [...extraRoots, ...defaultLifeDirs()]
      const { candidates, truncated } = locateFiles({ roots, query, mode })
      return { status: 200, body: { candidates, truncated } }
    },
  }
}
