#!/usr/bin/env bun
/**
 * Companion eval runner.
 *
 * Usage:
 *   bun run eval:companion                                        # run all trajectories
 *   bun run eval:companion --trajectory tech_stress_followup_v1   # one
 */

// SessionManager.shutdown uses Promise.all over multiple session.close() calls.
// When the SDK's ProcessTransport throws "not ready for writing" during cleanup,
// one rejection is caught by daemon-shim's try/catch but the parallel rejections
// become unhandled — Bun then aborts the process before the report is written.
// Swallow only that specific known message; let any other unhandled rejection
// crash as it normally would.
process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason)
  if (msg.includes('ProcessTransport is not ready')) return
  console.error('[eval] unhandled rejection:', reason)
  process.exit(1)
})

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadTrajectory } from './engine/trajectory'
import { replay } from './engine/replay'
import { writeReport } from './engine/reporter'
import { makeClaudeSdkJudge } from './engine/judge-claude-sdk'
import { makeCodexSdkJudge, makeAnthropicApiJudge, type Judge } from './engine/judge'
import { findOnPath } from '../../src/lib/util'

const HERE = fileURLToPath(new URL('.', import.meta.url))

// Mirror the daemon's bootstrap/resolveClaudeBinary preference (env → PATH) so
// the claude-sdk judge passes a working binary to query(). Without this the SDK
// mis-detects the musl native binary under bun on glibc and every probe errors.
function resolveClaudeBinary(configured?: string): string | undefined {
  if (configured && existsSync(configured)) return configured
  const env = process.env.CLAUDE_CODE_EXECUTABLE
  if (env && existsSync(env)) return env
  const onPath = findOnPath('claude')
  return onPath && existsSync(onPath) ? onPath : undefined
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const trajArgIdx = args.indexOf('--trajectory')
  const requested = trajArgIdx >= 0 ? args[trajArgIdx + 1] : undefined

  const judge = loadJudge()
  console.log(`[eval] judge: ${judge.name}`)

  const trajDir = join(HERE, 'trajectories')
  const files = readdirSync(trajDir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'))
  if (files.length === 0) throw new Error(`No trajectories found in ${trajDir}`)

  const startedAt = new Date()
  const runDir = join(HERE, 'runs', startedAt.toISOString().replace(/[:.]/g, '-'))

  const out: Array<{ trajectory: ReturnType<typeof loadTrajectory>; results: Awaited<ReturnType<typeof replay>> }> = []
  for (const file of files) {
    const traj = loadTrajectory(join(trajDir, file))
    if (requested !== undefined && traj.id !== requested) continue
    console.log(`[eval] running ${traj.id} (${traj.failure_mode}) — ${traj.events.length} events`)
    const results = await replay(traj, { judge })
    out.push({ trajectory: traj, results })
  }

  if (out.length === 0) {
    throw new Error(`No trajectory matched ${requested ?? '(all)'}`)
  }

  const finishedAt = new Date()
  writeReport(runDir, { judgeName: judge.name, startedAt, finishedAt, trajectories: out })
  console.log(`[eval] done — report: ${join(runDir, 'report.md')}`)
}

function loadJudge(): Judge {
  const cfgPath = join(HERE, 'judge-config.json')
  if (!existsSync(cfgPath)) throw new Error(`Missing ${cfgPath}`)
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as { kind: string; model?: string; apiKey?: string; pathToClaudeCodeExecutable?: string }
  switch (cfg.kind) {
    case 'claude-sdk': {
      const bin = resolveClaudeBinary(cfg.pathToClaudeCodeExecutable)
      if (!bin) console.warn('[eval] WARN: no claude binary resolved (env CLAUDE_CODE_EXECUTABLE / PATH) — judge dimension scores will fail')
      return makeClaudeSdkJudge({
        ...(cfg.model !== undefined ? { model: cfg.model } : {}),
        ...(bin ? { pathToClaudeCodeExecutable: bin } : {}),
      })
    }
    case 'codex-sdk': return makeCodexSdkJudge({ ...(cfg.model !== undefined ? { model: cfg.model } : {}) })
    case 'anthropic-api':
      if (!cfg.apiKey) throw new Error('anthropic-api judge requires apiKey in judge-config.json')
      return makeAnthropicApiJudge({ apiKey: cfg.apiKey, ...(cfg.model !== undefined ? { model: cfg.model } : {}) })
    default: throw new Error(`Unknown judge kind: ${cfg.kind}`)
  }
}

main().catch(err => {
  console.error('[eval] fatal:', err)
  process.exit(1)
})
