/**
 * log.ts — channel.log writer with 10MB auto-rotation.
 */

import { appendFileSync, statSync, renameSync } from 'fs'
import { join } from 'path'
import { STATE_DIR } from './config.ts'

export const LOG_FILE = join(STATE_DIR, 'channel.log')

const LOG_ROTATE_SIZE = 10 * 1024 * 1024
const LOG_ROTATE_CHECK_INTERVAL = 100
let _logCallsSinceCheck = 0

function maybeRotateLog(): void {
  try {
    const st = statSync(LOG_FILE)
    if (st.size > LOG_ROTATE_SIZE) {
      try { renameSync(LOG_FILE, `${LOG_FILE}.1`) } catch {}
    }
  } catch {}
}

maybeRotateLog()

export function log(tag: string, msg: string): void {
  if (++_logCallsSinceCheck >= LOG_ROTATE_CHECK_INTERVAL) {
    _logCallsSinceCheck = 0
    maybeRotateLog()
  }
  const line = `${new Date().toISOString()} [${tag}] ${msg}\n`
  process.stderr.write(`wechat channel: ${line}`)
  try { appendFileSync(LOG_FILE, line) } catch {}
}
