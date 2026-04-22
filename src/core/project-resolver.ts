export interface ProjectsSnapshot {
  projects: Record<string, { path: string; last_active: number }>
  current: string | null
}

export interface ResolverDeps {
  loadProjects: () => ProjectsSnapshot
  /** Used when projects.current is unset or points at a missing alias. */
  fallback?: () => { alias: string; path: string } | null
}

export function makeResolver(deps: ResolverDeps): (chatId: string) => { alias: string; path: string } | null {
  return (_chatId: string) => {
    const snap = deps.loadProjects()
    const alias = snap.current
    if (alias) {
      const entry = snap.projects[alias]
      if (entry) return { alias, path: entry.path }
    }
    return deps.fallback?.() ?? null
  }
}
