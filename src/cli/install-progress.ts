/**
 * install-progress.ts — read + validate the daemon's install-progress.json
 * for the desktop wizard. The producer is `service-manager.ts` (onProgress
 * hook); the consumer is `wechat-cc install-progress --json` polled by the
 * Tauri wizard at ~250ms intervals.
 *
 * Why a helper: prior to 2026-05-07 the cli.ts handler streamed the file
 * contents verbatim with no schema check, so a stale/truncated file would
 * leak garbage to the GUI. This helper enforces InstallProgressOutput and
 * reduces every failure mode to a typed result the cli emit can switch on.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { InstallProgressOutput, type InstallProgressOutputT } from './schema'

export type InstallProgressCliResult =
  | { kind: 'empty' }                                    // no install in flight
  | { kind: 'progress'; value: InstallProgressOutputT }  // valid, structured event
  | { kind: 'invalid'; error: string }                   // malformed file (read fail / bad JSON / wrong shape)

export function readInstallProgress(stateDir: string): InstallProgressCliResult {
  const path = join(stateDir, 'install-progress.json')
  if (!existsSync(path)) return { kind: 'empty' }

  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    return { kind: 'invalid', error: err instanceof Error ? err.message : String(err) }
  }

  const trimmed = raw.trim()
  if (!trimmed || trimmed === '{}') return { kind: 'empty' }

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch (err) {
    return { kind: 'invalid', error: `JSON parse failed: ${err instanceof Error ? err.message : String(err)}` }
  }

  const result = InstallProgressOutput.safeParse(parsed)
  if (!result.success) {
    return { kind: 'invalid', error: result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') }
  }
  return { kind: 'progress', value: result.data }
}
