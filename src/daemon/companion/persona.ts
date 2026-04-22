import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { personasDir, personaPath } from './paths'

export interface PersonaFrontmatter {
  name: string
  display_name: string
  min_push_gap_minutes: number
  quiet_hours_local: string
}

export interface Persona {
  frontmatter: PersonaFrontmatter
  body: string
  sourcePath: string
}

// Captures front-matter block + everything after. Tolerates CRLF.
const FRONT_MATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/

export function parsePersonaFile(content: string, sourcePath: string): Persona | null {
  const m = FRONT_MATTER_RE.exec(content)
  if (!m) return null
  const rawFm = m[1]!
  const body = m[2]!.trim()

  const fm: Record<string, string> = {}
  for (const line of rawFm.split(/\r?\n/)) {
    const eq = line.indexOf(':')
    if (eq < 0) continue
    const k = line.slice(0, eq).trim()
    if (!k) continue
    let v = line.slice(eq + 1).trim()
    // strip surrounding double quotes
    if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
      v = v.slice(1, -1)
    }
    fm[k] = v
  }

  const name = fm['name'] ?? ''
  const display_name = fm['display_name'] ?? ''
  if (!name || !display_name) return null

  const gapRaw = fm['min_push_gap_minutes']
  const gap = gapRaw !== undefined ? Number(gapRaw) : 10
  if (!Number.isFinite(gap) || gap < 0) return null

  const quiet = fm['quiet_hours_local'] ?? ''

  return {
    frontmatter: {
      name,
      display_name,
      min_push_gap_minutes: gap,
      quiet_hours_local: quiet,
    },
    body,
    sourcePath,
  }
}

export function listPersonas(stateDir: string): Persona[] {
  const dir = personasDir(stateDir)
  if (!existsSync(dir)) return []
  const out: Persona[] = []
  let files: string[]
  try {
    files = readdirSync(dir)
  } catch {
    return []
  }
  for (const f of files) {
    if (!f.endsWith('.md')) continue
    try {
      const content = readFileSync(join(dir, f), 'utf8')
      const p = parsePersonaFile(content, join(dir, f))
      if (p) out.push(p)
    } catch {
      // skip unreadable
    }
  }
  return out
}

export function loadPersona(stateDir: string, name: string): Persona | null {
  const p = personaPath(stateDir, name)
  if (!existsSync(p)) return null
  try {
    return parsePersonaFile(readFileSync(p, 'utf8'), p)
  } catch {
    return null
  }
}
