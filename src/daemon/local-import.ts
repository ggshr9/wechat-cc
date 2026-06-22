/**
 * local-import — auto-import the operator's LOCAL claude/codex history into the
 * messages table so the desktop 对话 pane + the "懂你" synthesis can see it.
 *
 * Runs at daemon startup and on the 24h companion introspect tick. Pure file
 * scan + SQLite INSERT OR IGNORE — NO LLM cost (the once-a-day overview
 * synthesis is a separate, LLM-backed step the tick also drives).
 *
 * Data model: local history has no WeChat-contact owner (it's project-tied,
 * not person-tied), so it lands in synthetic `local:claude` / `local:codex`
 * chat buckets, kept separate from real per-contact conversations.
 *
 * Incremental: a watermark (the previous run's start time) bounds each re-scan
 * to files touched since — the first run imports everything, later runs only
 * re-parse new / appended sessions. INSERT OR IGNORE makes any overlap a no-op.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Db } from '../lib/db'
import { backfillFromClaudeJsonl, backfillFromCodexJsonl } from '../cli/dialogue'
import { loadCompanionConfig } from './companion/config'

export const LOCAL_CLAUDE_CHAT = 'local:claude'
export const LOCAL_CODEX_CHAT = 'local:codex'

/** Production history roots (overridable in deps for tests). */
export function defaultLocalRoots(): { claudeProjectsRoot: string; codexRoot: string } {
  return {
    claudeProjectsRoot: join(homedir(), '.claude', 'projects'),
    codexRoot: join(homedir(), '.codex', 'sessions'),
  }
}

/** File-backed incremental watermark (a single ms value) under stateDir. */
export function makeFileWatermark(path: string): { get: () => number | null; set: (ms: number) => void } {
  return {
    get() {
      try {
        const n = Number((JSON.parse(readFileSync(path, 'utf8')) as { watermark?: unknown }).watermark)
        return Number.isFinite(n) ? n : null
      } catch { return null }
    },
    set(ms) {
      try { writeFileSync(path, JSON.stringify({ watermark: ms }), { mode: 0o600 }) } catch { /* best-effort */ }
    },
  }
}

export interface LocalImportDeps {
  db: Db
  /** `~/.claude/projects` — one subdir per project, each holding session jsonls. */
  claudeProjectsRoot: string
  /** `~/.codex/sessions` — year/month/day tree of rollout-*.jsonl. */
  codexRoot: string
  /** Previous run's watermark (ms), or null if never run (→ import everything). */
  getWatermark: () => number | null
  setWatermark: (ms: number) => void
  now: () => number
  log?: (tag: string, line: string) => void
}

export interface LocalImportResult {
  claude: { scanned: number; inserted: number }
  codex: { scanned: number; inserted: number }
}

function listSubdirs(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => join(root, e.name))
  } catch {
    return []
  }
}

export async function importLocalHistory(deps: LocalImportDeps): Promise<LocalImportResult> {
  // null watermark (first run) → undefined → import everything.
  const since = deps.getWatermark() ?? undefined
  // Stamp the next watermark from the run START, not the end: a session
  // appended-to DURING this run gets a newer mtime and is safely re-scanned
  // next time (over-scan, never under-scan; INSERT OR IGNORE dedups).
  const startedAt = deps.now()

  const claude = { scanned: 0, inserted: 0 }
  for (const projectDir of listSubdirs(deps.claudeProjectsRoot)) {
    const r = await backfillFromClaudeJsonl(deps.db, projectDir, LOCAL_CLAUDE_CHAT, false, since)
    claude.scanned += r.scanned
    claude.inserted += r.inserted
  }

  const codex = await backfillFromCodexJsonl(deps.db, deps.codexRoot, LOCAL_CODEX_CHAT, false, since)

  // Advance the watermark only after a clean run — a throw above leaves it
  // unchanged so the next run retries from the same point (no lost progress).
  deps.setWatermark(startedAt)
  deps.log?.('LOCAL_IMPORT', `claude=${claude.inserted}/${claude.scanned} codex=${codex.inserted}/${codex.scanned} since=${since ?? 'all'}`)
  return { claude, codex }
}

// Coalesce concurrent runs. At startup the standalone import sweep and the
// introspect catch-up tick BOTH call this; without a guard they'd race into a
// double full-scan (idempotent, but wasteful). A second concurrent caller
// awaits the first's promise instead of starting its own.
let _importInFlight: Promise<void> | null = null

/**
 * Production wiring: run the local-history import iff the operator opted in
 * (companion config `import_local_history`). Used by the startup sweep and the
 * 24h introspect tick. Default-off → a no-op in tests/e2e (no real-home scan).
 * Errors are logged, never thrown. `roots` is overridable for tests.
 */
export async function runLocalImportIfEnabled(
  stateDir: string,
  db: Db,
  log?: (tag: string, line: string) => void,
  roots: { claudeProjectsRoot: string; codexRoot: string } = defaultLocalRoots(),
): Promise<void> {
  if (!loadCompanionConfig(stateDir).import_local_history) return
  if (_importInFlight) return _importInFlight
  _importInFlight = (async () => {
    const wm = makeFileWatermark(join(stateDir, 'local-import-watermark.json'))
    try {
      await importLocalHistory({ db, ...roots, getWatermark: wm.get, setWatermark: wm.set, now: () => Date.now(), log })
    } catch (err) {
      log?.('LOCAL_IMPORT', `failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  })()
  try { await _importInFlight } finally { _importInFlight = null }
}
