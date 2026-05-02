/**
 * log.ts — channel log writer with 10MB auto-rotation.
 *
 * Two output streams:
 *   - <stateDir>/channel.log       — human-readable `<ISO> [TAG] <msg>` (legacy
 *                                    format, consumed by `wechat-cc logs`,
 *                                    log-viewer.ts, the dashboard logs pane,
 *                                    and operators tailing with `tail -f`)
 *   - <stateDir>/channel.log.jsonl — structured JSON lines, ONE per call that
 *                                    supplies the optional `fields` arg. Built
 *                                    for programmatic consumers (dashboard
 *                                    filters by chat_id/provider/etc., future
 *                                    metric scrapers, etc.). Calls without
 *                                    fields write only to channel.log; the
 *                                    JSONL stays small.
 *
 * Both streams rotate independently at 10 MB. Rotation is opportunistic
 * (every Nth call) rather than per-call to amortise the statSync cost.
 *
 * Conversion guidance for new code:
 *   log('COORDINATOR', `solo chat=${chatId} → provider=${pid}`, {
 *     chat_id: chatId, provider: pid, mode: 'solo',
 *   })
 * The msg string still gets the human-readable form (so existing tools work);
 * the fields object lands in the JSONL only.
 */

import { appendFileSync, statSync, renameSync } from 'fs'
import { join } from 'path'
import { STATE_DIR } from './config.ts'

export const LOG_FILE = join(STATE_DIR, 'channel.log')
export const LOG_FILE_JSONL = join(STATE_DIR, 'channel.log.jsonl')

const LOG_ROTATE_SIZE = 10 * 1024 * 1024
const LOG_ROTATE_CHECK_INTERVAL = 100
let _logCallsSinceCheck = 0

function maybeRotate(file: string): void {
  try {
    const st = statSync(file)
    if (st.size > LOG_ROTATE_SIZE) {
      try { renameSync(file, `${file}.1`) } catch {}
    }
  } catch {}
}

function maybeRotateAll(): void {
  maybeRotate(LOG_FILE)
  maybeRotate(LOG_FILE_JSONL)
}

maybeRotateAll()

/**
 * Structured fields payload — values must be JSON-serialisable. Keys
 * should be snake_case to match the rest of the wire (chat_id, msg_id,
 * provider, ...). Avoid stuffing user content here; that goes in `msg`.
 */
export type LogFields = Record<string, unknown>

/**
 * Pure formatter: build the legacy text line. Exposed for tests + any
 * future caller that wants the same canonical shape without I/O.
 */
export function formatHumanLine(ts: string, tag: string, msg: string): string {
  return `${ts} [${tag}] ${msg}\n`
}

/**
 * Pure formatter: build the JSON-line record. Returns null when the
 * fields object can't be serialised (circular ref). Exposed for tests
 * + future programmatic consumers.
 */
export function formatJsonRecord(ts: string, tag: string, msg: string, fields: LogFields): string | null {
  try {
    return JSON.stringify({ ts, tag, msg, ...fields }) + '\n'
  } catch {
    return null
  }
}

/**
 * Write a log line. The `fields` arg is optional — when present, a
 * structured JSON record is also written to channel.log.jsonl. The
 * human-readable format remains unchanged for back-compat with tooling
 * that parses `<ISO> [TAG] <msg>`.
 */
export function log(tag: string, msg: string, fields?: LogFields): void {
  if (++_logCallsSinceCheck >= LOG_ROTATE_CHECK_INTERVAL) {
    _logCallsSinceCheck = 0
    maybeRotateAll()
  }
  const ts = new Date().toISOString()
  const humanLine = formatHumanLine(ts, tag, msg)
  process.stderr.write(`wechat channel: ${humanLine}`)
  try { appendFileSync(LOG_FILE, humanLine) } catch {}

  if (fields !== undefined) {
    const jsonLine = formatJsonRecord(ts, tag, msg, fields)
    if (jsonLine !== null) {
      try { appendFileSync(LOG_FILE_JSONL, jsonLine) } catch {}
    }
  }
}
