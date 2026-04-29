/**
 * Runtime layer for per-project LLM summary refresh.
 *
 * Reads sessions.json, finds entries where summarizer.needsRefresh() is true,
 * and runs an injected sdkEval against the last 20 turns of the session jsonl
 * to produce a fresh 1-line Chinese summary. The eval call is dependency-
 * injected so tests don't need a live SDK; main.ts/cli.ts wire in the real
 * Haiku-backed eval (see main.ts::isolatedSdkEval).
 *
 * Concurrency: a module-level `isRunning` boolean guards against overlapping
 * batches — a second call while one is in flight returns immediately. This
 * matters because the trigger fires from cli.ts non-blocking, and back-to-back
 * `sessions list-projects` calls would otherwise stack SDK invocations.
 *
 * Errors per-alias are logged via the injected log() (if provided) but never
 * abort the batch — one flaky session shouldn't block summaries for the rest.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeSessionStore } from '../../core/session-store'
import { needsRefresh, formatSummaryRequest } from './summarizer'
import { resolveProjectJsonlPath } from './path-resolver'

export interface SummaryRefreshDeps {
  stateDir: string
  sdkEval: (prompt: string) => Promise<string>
  log?: (tag: string, msg: string) => void
}

let isRunning = false  // module-level — at most one batch concurrent

export async function triggerStaleSummaryRefresh(deps: SummaryRefreshDeps): Promise<void> {
  if (isRunning) return
  isRunning = true
  try {
    const store = makeSessionStore(join(deps.stateDir, 'sessions.json'), { debounceMs: 0 })
    const all = store.all()
    for (const [alias, rec] of Object.entries(all)) {
      if (!needsRefresh(rec)) continue
      try {
        const path = resolveProjectJsonlPath(alias, rec.session_id)
        if (!existsSync(path)) continue
        const lines = readFileSync(path, 'utf8').split('\n').filter(l => l.length > 0)
        const turns = lines.slice(-20).flatMap(l => {
          try {
            const t = JSON.parse(l) as { type?: string; message?: { content?: unknown } }
            const role = t.type === 'user' ? 'user' as const : 'assistant' as const
            const content = extractText(t)
            return content ? [{ role, text: content }] : []
          } catch { return [] }
        })
        if (turns.length === 0) continue
        const prompt = formatSummaryRequest(turns)
        const raw = await deps.sdkEval(prompt)
        const summary = raw.trim().replace(/^["「『]|["」』]$/g, '').slice(0, 50)
        if (summary.length > 0) store.setSummary(alias, summary)
      } catch (err) {
        deps.log?.('SUMMARY', `refresh failed for ${alias}: ${err instanceof Error ? err.message : err}`)
      }
    }
    await store.flush()
  } finally {
    isRunning = false
  }
}

function extractText(turn: { message?: { content?: unknown } }): string {
  const c = turn.message?.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) {
    return c
      .map(p => (p as { type?: string; text?: string }))
      .filter(p => p.type === 'text' && typeof p.text === 'string')
      .map(p => p.text!)
      .join(' ')
  }
  return ''
}
