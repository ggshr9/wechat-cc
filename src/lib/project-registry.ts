/**
 * project-registry.ts — manages ~/.claude/channels/wechat/projects.json.
 *
 * Single source of truth for alias → path routing. All writes are atomic
 * (tmp + rename). Tested via fixture files — callers pass the registry
 * path so tests can use tmpdir.
 */
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'fs'
import { isAbsolute } from 'path'

export const ALIAS_REGEX = /^[a-z0-9][a-z0-9_-]{1,19}$/

export interface ProjectEntry {
  path: string
  last_active: string  // ISO 8601
}

export interface ProjectRegistry {
  projects: Record<string, ProjectEntry>
  current: string | null
}

function emptyRegistry(): ProjectRegistry {
  return { projects: {}, current: null }
}

function loadRegistry(file: string): ProjectRegistry {
  if (!existsSync(file)) return emptyRegistry()
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<ProjectRegistry>
    return {
      projects: parsed.projects ?? {},
      current: parsed.current ?? null,
    }
  } catch {
    return emptyRegistry()
  }
}

function saveRegistry(file: string, reg: ProjectRegistry): void {
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(reg, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, file)
}

export function addProject(file: string, alias: string, path: string): void {
  if (!ALIAS_REGEX.test(alias)) {
    throw new Error(`invalid alias '${alias}': must match ${ALIAS_REGEX}`)
  }
  if (!isAbsolute(path)) {
    throw new Error(`path must be absolute, got: ${path}`)
  }
  let stat
  try { stat = statSync(path) } catch { throw new Error(`path is not a directory: ${path}`) }
  if (!stat.isDirectory()) throw new Error(`path is not a directory: ${path}`)

  const reg = loadRegistry(file)
  if (reg.projects[alias]) {
    throw new Error(`alias '${alias}' already registered (${reg.projects[alias].path})`)
  }
  reg.projects[alias] = { path, last_active: new Date().toISOString() }
  saveRegistry(file, reg)
}

export interface ProjectView {
  alias: string
  path: string
  last_active: string
  is_current: boolean
}

export function listProjects(file: string): ProjectView[] {
  const reg = loadRegistry(file)
  const out: ProjectView[] = []
  for (const [alias, entry] of Object.entries(reg.projects)) {
    out.push({
      alias,
      path: entry.path,
      last_active: entry.last_active,
      is_current: reg.current === alias,
    })
  }
  out.sort((a, b) => b.last_active.localeCompare(a.last_active))
  return out
}

export function setCurrent(file: string, alias: string): void {
  const reg = loadRegistry(file)
  if (!reg.projects[alias]) {
    throw new Error(`alias '${alias}' is not registered`)
  }
  reg.current = alias
  reg.projects[alias]!.last_active = new Date().toISOString()
  saveRegistry(file, reg)
}

export function removeProject(file: string, alias: string): void {
  const reg = loadRegistry(file)
  if (!reg.projects[alias]) {
    throw new Error(`alias '${alias}' is not registered`)
  }
  if (reg.current === alias) {
    throw new Error(`cannot remove current project '${alias}' — switch elsewhere first`)
  }
  delete reg.projects[alias]
  saveRegistry(file, reg)
}

export function resolveProject(file: string, alias: string): ProjectEntry | null {
  const reg = loadRegistry(file)
  return reg.projects[alias] ?? null
}
