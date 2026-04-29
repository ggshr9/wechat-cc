/**
 * Per-project 1-line LLM summary, cached in sessions.json.
 *
 * Refresh policy: when summary is missing, OR last_used_at is newer than
 * summary_updated_at, OR summary is older than ttlDays. Refresh runs lazily —
 * dashboard requests a project list, daemon notices stale summary, kicks off
 * an isolated SDK eval to refresh, returns cached summary immediately. Next
 * dashboard refresh shows the new line.
 *
 * The actual SDK call lives in main.ts wiring (Task 8); this module is
 * test-friendly pure helpers + the request prompt builder.
 */
import type { SessionRecord } from '../../core/session-store'

export function needsRefresh(rec: SessionRecord, ttlDays = 7): boolean {
  if (!rec.summary || !rec.summary_updated_at) return true
  const summaryAge = Date.now() - new Date(rec.summary_updated_at).getTime()
  if (summaryAge > ttlDays * 86400_000) return true
  // last_used_at newer → conversation moved on, summary stale
  if (rec.last_used_at > rec.summary_updated_at) return true
  return false
}

export interface TurnSnippet {
  role: 'user' | 'assistant'
  text: string
}

const SUMMARY_PROMPT = `用一句话（中文，不超过 30 字）总结这段对话最后做了什么。\
不要泛泛而谈，要具体。例如「修了 ilink-glue 的 token 透传 bug」「讨论了 v0.4 的会话 pane 形态」。\
直接输出那一句话，不要前缀、引号、解释。

对话：
`

export function formatSummaryRequest(turns: TurnSnippet[]): string {
  const flattened = turns
    .map(t => `${t.role === 'user' ? '我' : 'Claude'}: ${t.text.slice(0, 400)}`)
    .join('\n')
    .slice(0, 1500)
  return SUMMARY_PROMPT + flattened
}
