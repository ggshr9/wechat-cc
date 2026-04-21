export interface ProjectsSnapshot {
  projects: Record<string, { path: string; last_active: number }>
  current: string | null
}

export interface ResolverDeps {
  loadProjects: () => ProjectsSnapshot
}

export function makeResolver(deps: ResolverDeps): (chatId: string) => { alias: string; path: string } | null {
  return (_chatId: string) => {
    const snap = deps.loadProjects()
    const alias = snap.current
    if (!alias) return null
    const entry = snap.projects[alias]
    if (!entry) return null
    return { alias, path: entry.path }
  }
}
