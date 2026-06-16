import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Concatenate all .md files in a chat's memory dir into a single string.
 * Used by introspect (writes observations) AND summarizer (writes session
 * summaries) — both want the user's stated preferences + Claude's prior
 * notes as context. Same source of truth: when the user tells Claude in
 * chat "总结请像朋友说话", Claude writes that to memory; both downstream
 * SDK paths read it and adapt without any prompt code change here.
 *
 * Returns '' when the dir doesn't exist (new chat) or has no .md files.
 */
// The synthesized overview (written by memory-synthesis.ts). Kept as a local
// literal to avoid pulling that CLI module into the hot daemon snapshot path.
const OVERVIEW_FILENAME = '_overview.md'

export async function buildMemorySnapshot(stateDir: string, chatId: string): Promise<string> {
  const dir = join(stateDir, 'memory', chatId)
  if (!existsSync(dir)) return ''
  const entries = await readdir(dir, { withFileTypes: true })
  const names = entries.filter(e => e.isFile() && e.name.endsWith('.md')).map(e => e.name)
  // Deterministic order, with the synthesized overview leading: it's the
  // distilled "big picture" the downstream SDK should read before the raw
  // notes. (readdir order is platform-dependent, so sort for stable prompts.)
  names.sort((a, b) => {
    if (a === OVERVIEW_FILENAME) return b === OVERVIEW_FILENAME ? 0 : -1
    if (b === OVERVIEW_FILENAME) return 1
    return a.localeCompare(b)
  })
  const out: string[] = []
  for (const name of names) {
    try {
      const content = await readFile(join(dir, name), 'utf8')
      out.push(`# ${name}\n${content}`)
    } catch { /* skip unreadable */ }
  }
  return out.join('\n\n')
}
