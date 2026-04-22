import { appendFileSync, existsSync, statSync, renameSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { runsPath, pushLogPath } from './paths'

export interface RunEntry {
  ts: string
  trigger_id: string
  persona: string
  duration_ms: number
  pushed: boolean
  reason: string
  tool_uses_count: number
  cost_usd: number
  error_message?: string
}

export interface PushEntry {
  ts: string
  trigger_id: string
  persona: string
  message: string
  chat_id: string
  delivery_status: 'ok' | 'failed'
  error?: string
}

const ROTATE_BYTES = 10 * 1024 * 1024 // 10 MB

function makeLogger<T>(filePath: string) {
  function ensureDir(): void {
    const d = dirname(filePath)
    if (!existsSync(d)) mkdirSync(d, { recursive: true })
  }
  return {
    append(entry: T): void {
      ensureDir()
      appendFileSync(filePath, JSON.stringify(entry) + '\n', 'utf8')
    },
    rotate(): void {
      if (!existsSync(filePath)) return
      try {
        const size = statSync(filePath).size
        if (size >= ROTATE_BYTES) {
          renameSync(filePath, `${filePath}.1`)
        }
      } catch {
        // best-effort
      }
    },
  }
}

export function makeRunsLogger(stateDir: string) {
  return makeLogger<RunEntry>(runsPath(stateDir))
}

export function makePushLogger(stateDir: string) {
  return makeLogger<PushEntry>(pushLogPath(stateDir))
}
