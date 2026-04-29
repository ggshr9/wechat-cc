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
export async function buildMemorySnapshot(stateDir: string, chatId: string): Promise<string> {
  const dir = join(stateDir, 'memory', chatId)
  if (!existsSync(dir)) return ''
  const entries = await readdir(dir, { withFileTypes: true })
  const mds = entries.filter(e => e.isFile() && e.name.endsWith('.md'))
  const out: string[] = []
  for (const e of mds) {
    try {
      const content = await readFile(join(dir, e.name), 'utf8')
      out.push(`# ${e.name}\n${content}`)
    } catch { /* skip unreadable */ }
  }
  return out.join('\n\n')
}
