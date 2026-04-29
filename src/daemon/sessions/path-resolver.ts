/**
 * Find the .jsonl file for a session by walking ~/.claude/projects/.
 *
 * Claude Agent SDK stores session jsonls under directories keyed by the
 * encoded cwd (slashes → dashes). We don't have the cwd directly here,
 * but the file name is `<session_id>.jsonl` so we glob the projects/
 * subdirs to find a match. Synthesize an "_unknown_" fallback path when
 * not found so callers can existsSync-check before reading.
 */
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function resolveProjectJsonlPath(
  alias: string,
  sessionId: string,
  opts: { home?: string } = {},
): string {
  const home = opts.home ?? homedir()
  const projectsRoot = join(home, '.claude', 'projects')
  if (!existsSync(projectsRoot)) {
    return join(projectsRoot, '_unknown_', `${sessionId}.jsonl`)
  }
  for (const dir of readdirSync(projectsRoot, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue
    const candidate = join(projectsRoot, dir.name, `${sessionId}.jsonl`)
    if (existsSync(candidate)) return candidate
  }
  return join(projectsRoot, '_unknown_', `${sessionId}.jsonl`)
}
