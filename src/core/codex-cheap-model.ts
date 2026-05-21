/**
 * Codex cheap-model resolver — picks the cheapest practical model the
 * user's Codex CLI has access to, without requiring config or env vars.
 *
 * Codex CLI maintains `~/.codex/models_cache.json` after each `codex login`
 * with the full list of models the user's subscription unlocks. We use
 * that as the source of truth for "which slug is callable" instead of
 * guessing or hardcoding a name that might not exist in the user's plan.
 *
 * Resolution chain (first hit wins):
 *   1. WECHAT_CODEX_CHEAP_MODEL env (explicit override; trust the user)
 *   2. `-mini` variant from cache (every recent codex family ships one;
 *      it's reliably cheaper than the non-mini sibling)
 *   3. Highest-priority eligible model from cache (codex's `priority`
 *      field sorts featured-first → smaller = pricier; the LARGEST
 *      priority number is the least featured = typically cheapest)
 *   4. Hardcoded literal — last-resort fallback if cache is missing /
 *      corrupt / has zero eligible rows
 *
 * Read at provider construction (once per daemon boot). If a user runs
 * `codex login` to add a new subscription tier with cheaper models,
 * they restart the daemon and the resolver picks them up.
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

interface CodexModelCacheEntry {
  slug: string
  visibility?: string
  supported_in_api?: boolean
  priority?: number
}

interface CodexModelsCache {
  models?: CodexModelCacheEntry[]
}

/** Last-resort fallback when env, cache, and parse all fail. Verified
 *  present in the default codex CLI distribution as of 0.128.0. Update
 *  if codex deprecates this slug. */
const HARD_FALLBACK = 'gpt-5.4-mini'

export interface ResolveCodexCheapModelDeps {
  /** Override the cache path — used by tests + edge installs. */
  cachePath?: string
  /** Override env reader — tests inject a controlled record. */
  env?: NodeJS.ProcessEnv
}

export function resolveCodexCheapModel(deps: ResolveCodexCheapModelDeps = {}): string {
  const env = deps.env ?? process.env
  // 1. env override
  const envModel = env['WECHAT_CODEX_CHEAP_MODEL']
  if (envModel && envModel.length > 0) return envModel

  // 2 + 3. parse models_cache.json
  const path = deps.cachePath ?? join(homedir(), '.codex', 'models_cache.json')
  if (existsSync(path)) {
    try {
      const cache = JSON.parse(readFileSync(path, 'utf8')) as CodexModelsCache
      const eligible = (cache.models ?? [])
        .filter(m => m.visibility === 'list' && m.supported_in_api !== false && typeof m.slug === 'string' && m.slug.length > 0)

      // Prefer the explicit `-mini` variant — every recent codex family
      // ships one; it's reliably the cheapest tier within its family.
      const mini = eligible.find(m => m.slug.includes('-mini'))
      if (mini) return mini.slug

      // Otherwise: largest priority number = least-featured = cheapest tier
      const ranked = [...eligible].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
      const top = ranked[0]?.slug
      if (top) return top
    } catch {
      // fall through to hardcoded fallback
    }
  }

  return HARD_FALLBACK
}
