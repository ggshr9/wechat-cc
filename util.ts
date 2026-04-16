/**
 * util.ts — shared helpers used by both cli.ts and docs.ts.
 *
 * Keep this file small and dependency-free. It's imported by multiple
 * entry points and should not pull in MCP, ilink, or any heavy module.
 */

import { spawnSync } from 'child_process'
import { platform } from 'os'

/**
 * Cross-platform PATH lookup: uses `where` on Windows, `which` elsewhere.
 * Returns the first matching absolute path, or null. `where` on Windows
 * may print multiple matches on separate lines; we take the first.
 */
export function findOnPath(cmd: string): string | null {
  const finder = platform() === 'win32' ? 'where' : 'which'
  try {
    const r = spawnSync(finder, [cmd], { stdio: 'pipe' })
    if (r.status === 0) {
      const out = r.stdout?.toString() ?? ''
      const first = out.split(/\r?\n/)[0]?.trim()
      if (first) return first
    }
  } catch {}
  return null
}
