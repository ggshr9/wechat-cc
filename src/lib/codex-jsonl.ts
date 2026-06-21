/**
 * codex-jsonl.ts — read a codex SDK rollout file and convert its events
 * into claude-shaped turns for the dashboard's existing renderer.
 *
 * Why: claude jsonls live at `~/.claude/projects/<encoded-cwd>/<id>.jsonl`
 * with `{type:'user'|'assistant', message:{content:[{type:'text',text}]}}`
 * shape. Codex jsonls live at
 * `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<TS>-<thread-id>.jsonl`
 * with completely different events:
 *   - `{type:'session_meta', payload:{...}}`
 *   - `{type:'response_item', payload:{type:'message', role, content:[{type:'input_text'|'output_text', text}]}}`
 *   - `{type:'response_item', payload:{type:'reasoning', encrypted_content}}`
 *   - `{type:'event_msg', payload:{type:'agent_message', message}}` (duplicates response_item.message.assistant)
 *
 * To keep the dashboard renderer claude-shape-only, this module:
 *   1. Globs `<codex-root>/<YYYY>/<MM>/<DD>/rollout-*-<threadId>.jsonl`
 *   2. Parses each line, picks `response_item` with `payload.type === 'message'`
 *   3. Maps `role: 'user' | 'assistant'` → `type: 'user' | 'assistant'`
 *   4. Maps `content[].input_text/output_text` → `content[].text`
 *   5. Drops reasoning, session_meta, and event_msg entries (latter
 *      duplicates the response_item we already rendered)
 */

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { isValidIso } from './iso-time'

export interface ClaudeShapeTurn {
  type: 'user' | 'assistant'
  message: { content: Array<{ type: 'text'; text: string }> }
  /** ISO 8601 timestamp from the rollout envelope, when present. */
  ts?: string
}

/**
 * Find the rollout jsonl whose filename ends with `-<threadId>.jsonl`.
 * Codex shards by date (`<root>/YYYY/MM/DD/rollout-<TS>-<id>.jsonl`).
 * Returns the first match or null.
 */
export function findCodexRollout(codexRoot: string, threadId: string): string | null {
  if (!existsSync(codexRoot)) return null
  const suffix = `-${threadId}.jsonl`
  // Walk depth ≤ 3 (year/month/day). Bounded because the date sharding
  // scheme is well-defined; we don't want to scan unbounded user dirs.
  try {
    for (const year of safeReaddir(codexRoot)) {
      const yearDir = join(codexRoot, year)
      if (!isDir(yearDir)) continue
      for (const month of safeReaddir(yearDir)) {
        const monthDir = join(yearDir, month)
        if (!isDir(monthDir)) continue
        for (const day of safeReaddir(monthDir)) {
          const dayDir = join(monthDir, day)
          if (!isDir(dayDir)) continue
          for (const file of safeReaddir(dayDir)) {
            if (file.endsWith(suffix)) return join(dayDir, file)
          }
        }
      }
    }
  } catch { /* fall through */ }
  return null
}

/**
 * Parse a codex rollout file into claude-shaped turns. Filters out
 * non-message entries (session_meta, reasoning, event_msg).
 */
export function readCodexJsonlAsClaudeTurns(path: string): ClaudeShapeTurn[] {
  const out: ClaudeShapeTurn[] = []
  let raw: string
  try { raw = readFileSync(path, 'utf8') } catch { return out }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let parsed: unknown
    try { parsed = JSON.parse(line) } catch { continue }
    const turn = codexLineToClaudeTurn(parsed)
    if (turn) out.push(turn)
  }
  return out
}

/** Visible-for-tests: convert one parsed codex line. Returns null to skip. */
export function codexLineToClaudeTurn(line: unknown): ClaudeShapeTurn | null {
  if (!line || typeof line !== 'object') return null
  const obj = line as { type?: unknown; payload?: unknown; timestamp?: unknown }
  if (obj.type !== 'response_item') return null  // skip session_meta, event_msg, etc.
  const payload = obj.payload as { type?: unknown; role?: unknown; content?: unknown } | undefined
  if (!payload || payload.type !== 'message') return null
  if (payload.role !== 'user' && payload.role !== 'assistant') return null
  if (!Array.isArray(payload.content)) return null

  // Pull every text-bearing block. Codex uses `input_text` for user-side
  // and `output_text` for assistant-side; both have a `.text` field.
  const texts: string[] = []
  for (const block of payload.content as Array<{ type?: unknown; text?: unknown }>) {
    if (!block || typeof block !== 'object') continue
    if ((block.type === 'input_text' || block.type === 'output_text') && typeof block.text === 'string') {
      texts.push(block.text)
    }
  }
  if (texts.length === 0) return null

  // Thread through the envelope-level timestamp when present AND a real date —
  // a garbage string would be stored verbatim as the message ts and corrupt
  // ordering. Invalid → undefined, so the backfill falls back to the filename
  // anchor instead.
  const ts = typeof obj.timestamp === 'string' && isValidIso(obj.timestamp) ? obj.timestamp : undefined

  return {
    type: payload.role,
    message: { content: texts.map(text => ({ type: 'text' as const, text })) },
    ...(ts !== undefined ? { ts } : {}),
  }
}

function safeReaddir(p: string): string[] {
  try { return readdirSync(p) } catch { return [] }
}

function isDir(p: string): boolean {
  try { return statSync(p).isDirectory() } catch { return false }
}
