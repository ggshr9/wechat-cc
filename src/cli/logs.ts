/**
 * logs.ts — read + parse the daemon's channel.log tail for the GUI's
 * Logs pane and `wechat-cc logs --tail N` CLI.
 *
 * Why structured: the daemon writes lines like
 *   2026-04-28T07:22:21.184Z [SESSION_EXPIRED] 18ca067b4366-im-bot — ...
 * Pre-parsing on the CLI side lets the GUI just render rows; raw text
 * goes through unchanged when a line doesn't match (e.g. multi-line
 * stack traces, free-form console.error from third-party libs).
 *
 * Bounded: channel.log rotates at 10MB (≈70k lines) so reading the
 * whole file is acceptable. Tail count clamped to [1, 5000] — anything
 * larger is a UX bug (no one's scanning 5k lines in the GUI).
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface LogEntry {
  /** ISO timestamp ("" if line doesn't match the format). */
  timestamp: string
  /** Bracketed tag, e.g. "SESSION_EXPIRED" ("" if no match). */
  tag: string
  /** Everything after `[TAG] ` (or the whole line if no match). */
  message: string
  /** Original line — useful when timestamp/tag are blank. */
  raw: string
}

export interface LogTailResult {
  ok: true
  logFile: string
  totalLines: number
  entries: LogEntry[]
}

export interface LogTailError {
  ok: false
  logFile: string
  error: string
}

const MIN_TAIL = 1
const MAX_TAIL = 5000

// Regex matches the daemon's standard `<ISO> [TAG] <msg>` shape. The
// `]\ ?` allows the message to be either flush against `]` or separated
// by exactly one space — any further leading whitespace is preserved as
// part of the message (so a deliberately-indented line stays indented
// when rendered in the GUI).
const ENTRY_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z) \[([^\]]+)\] ?(.*)$/

export function parseLine(raw: string): LogEntry {
  const m = ENTRY_RE.exec(raw)
  if (!m) return { timestamp: '', tag: '', message: raw, raw }
  return { timestamp: m[1]!, tag: m[2]!, message: m[3] ?? '', raw }
}

// Order matters: `Infinity > MAX_TAIL` is true (so we map to MAX), but
// `Number.isFinite(Infinity)` is false (so a finiteness-first check
// would incorrectly map to MIN). Same idea for -Infinity vs MIN.
export function clampTail(n: number): number {
  if (Number.isNaN(n)) return MIN_TAIL
  if (n < MIN_TAIL) return MIN_TAIL
  if (n > MAX_TAIL) return MAX_TAIL
  return Math.floor(n)
}

export function tailLog(stateDir: string, lastN: number): LogTailResult | LogTailError {
  const logFile = join(stateDir, 'channel.log')
  if (!existsSync(logFile)) {
    return { ok: true, logFile, totalLines: 0, entries: [] }
  }
  let content: string
  try {
    content = readFileSync(logFile, 'utf8')
  } catch (err) {
    return { ok: false, logFile, error: err instanceof Error ? err.message : String(err) }
  }
  const lines = content.split('\n').filter(l => l.length > 0)
  const n = clampTail(lastN)
  const tail = lines.slice(-n)
  return { ok: true, logFile, totalLines: lines.length, entries: tail.map(parseLine) }
}
