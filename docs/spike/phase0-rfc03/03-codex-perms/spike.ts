#!/usr/bin/env bun
/**
 * Phase 0-RFC03 Spike 3: Codex SDK permission granularity.
 *
 * RFC 03 §9 Spike 3 — empirically map the (sandboxMode × approvalPolicy)
 * matrix to confirm there is no per-tool callback equivalent to Claude's
 * `canUseTool`, and document the actual coarse-grained behaviour we'll
 * have to live with on the Codex side of permission-relay.
 *
 * SDK type-level facts (from `dist/index.d.ts`):
 *   sandboxMode:    'read-only' | 'workspace-write' | 'danger-full-access'
 *   approvalPolicy: 'never' | 'on-request' | 'on-failure' | 'untrusted'
 *   networkAccessEnabled?: boolean
 *   webSearchEnabled?: boolean
 *   additionalDirectories?: string[]
 *
 * No `canUseTool` callback exists on Thread or Codex. Confirmed by
 * grepping the .d.ts — the only thread-level option surface is the
 * ThreadOptions object passed to startThread/resumeThread.
 *
 * What this spike runs:
 *   Trial A: sandboxMode='read-only',       approvalPolicy='never'
 *            → ask Codex to write a file
 *            → expected: refuses or fails the write (read-only sandbox)
 *
 *   Trial B: sandboxMode='workspace-write', approvalPolicy='never'
 *            → ask Codex to write the same file
 *            → expected: succeeds, file appears
 *
 *   Trial C: sandboxMode='workspace-write', approvalPolicy='on-request'
 *            → ask Codex to do something that would normally trigger an
 *              approval (e.g. write to /tmp outside the cwd)
 *            → observe: does the SDK auto-deny? hang waiting? auto-approve?
 *
 * The product question we're answering: in the daemon (no human in the
 * loop for individual tool calls), what's the safe ship default for Codex?
 *
 * Pass criteria (this spike doesn't have a binary pass/fail — it's a
 * mapping exercise):
 *   - All three trials run to a turn.completed or turn.failed (no hangs)
 *   - Trial A's outcome is "refused / failed"
 *   - Trial B's outcome is "wrote successfully"
 *   - Trial C's outcome is documented (whatever it is)
 *
 * Output: matrix.json with the observed behaviour for each trial.
 */
import { Codex, type ThreadEvent, type ThreadItem } from '@openai/codex-sdk'
import { writeFileSync, existsSync, unlinkSync, mkdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const CODEX_BIN = join(HERE, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
const SCRATCH = join(HERE, 'scratch')
const MATRIX_FILE = join(HERE, 'matrix.json')
const OUT_TMP = join(tmpdir(), `wechat-cc-spike3-${Date.now()}.txt`)

function log(...args: unknown[]): void {
  console.error('[spike3]', ...args)
}

const apiKey = process.env.OPENAI_API_KEY
if (!apiKey) {
  log('FAIL: OPENAI_API_KEY not set')
  process.exit(2)
}

mkdirSync(SCRATCH, { recursive: true })

interface TrialResult {
  name: string
  sandboxMode: 'read-only' | 'workspace-write' | 'danger-full-access'
  approvalPolicy: 'never' | 'on-request' | 'on-failure' | 'untrusted'
  prompt: string
  expected: string
  turn_outcome: 'completed' | 'failed' | 'timeout' | 'threw'
  duration_ms: number
  command_executions: Array<{ command: string; status: string; exit_code: number | null }>
  file_changes: Array<{ path: string; kind: string; status: string }>
  errors: string[]
  agent_message_preview: string
  side_effect_check: { description: string; observed: string }
}

async function runTrial(
  name: string,
  sandboxMode: TrialResult['sandboxMode'],
  approvalPolicy: TrialResult['approvalPolicy'],
  prompt: string,
  expected: string,
  sideEffectCheck: () => string,
  sideEffectDescription: string,
): Promise<TrialResult> {
  log('===', name, '===')
  log('  sandboxMode:', sandboxMode, '  approvalPolicy:', approvalPolicy)

  const codex = new Codex({
    apiKey,
    codexPathOverride: process.env.CODEX_PATH ?? CODEX_BIN,
  })

  const thread = codex.startThread({
    workingDirectory: SCRATCH,
    skipGitRepoCheck: true,
    sandboxMode,
    approvalPolicy,
    additionalDirectories: [tmpdir()],
  })

  const result: TrialResult = {
    name,
    sandboxMode,
    approvalPolicy,
    prompt,
    expected,
    turn_outcome: 'timeout',
    duration_ms: 0,
    command_executions: [],
    file_changes: [],
    errors: [],
    agent_message_preview: '',
    side_effect_check: { description: sideEffectDescription, observed: '' },
  }

  const started = Date.now()
  const TRIAL_TIMEOUT_MS = 90_000
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    log('  ⚠️  trial exceeded', TRIAL_TIMEOUT_MS, 'ms — abandoning')
  }, TRIAL_TIMEOUT_MS)

  try {
    const { events } = await thread.runStreamed(prompt)
    for await (const ev of events as AsyncGenerator<ThreadEvent>) {
      if (timedOut) break
      const elapsed = Date.now() - started
      log(`  [${elapsed}ms]`, ev.type)

      if (ev.type === 'item.completed') {
        const item = (ev as { item: ThreadItem }).item
        if (item.type === 'command_execution') {
          result.command_executions.push({
            command: item.command,
            status: item.status,
            exit_code: item.exit_code ?? null,
          })
          log('    cmd:', item.command, '→', item.status, 'exit=', item.exit_code)
        } else if (item.type === 'file_change') {
          for (const ch of item.changes) {
            result.file_changes.push({ path: ch.path, kind: ch.kind, status: item.status })
          }
          log('    file_change:', item.changes.map((c: { kind: string; path: string }) => `${c.kind} ${c.path}`).join(', '), '→', item.status)
        } else if (item.type === 'error') {
          result.errors.push(item.message)
        } else if (item.type === 'agent_message') {
          result.agent_message_preview = item.text.slice(0, 300)
        }
      } else if (ev.type === 'turn.completed') {
        result.turn_outcome = 'completed'
      } else if (ev.type === 'turn.failed') {
        result.turn_outcome = 'failed'
        result.errors.push(ev.error.message)
      } else if (ev.type === 'error') {
        result.errors.push((ev as { message: string }).message)
      }
    }
  } catch (err) {
    result.turn_outcome = 'threw'
    result.errors.push(err instanceof Error ? `${err.name}: ${err.message}` : String(err))
    log('  trial threw:', err instanceof Error ? err.message : err)
  } finally {
    clearTimeout(timer)
  }

  result.duration_ms = Date.now() - started
  if (timedOut) result.turn_outcome = 'timeout'

  try {
    result.side_effect_check.observed = sideEffectCheck()
  } catch (err) {
    result.side_effect_check.observed = `error: ${err instanceof Error ? err.message : String(err)}`
  }

  log('  outcome:', result.turn_outcome, ' duration:', result.duration_ms, 'ms')
  log('  side_effect:', result.side_effect_check.observed)
  return result
}

const FILE_A = join(SCRATCH, 'wrote-from-A.txt')
const FILE_B = join(SCRATCH, 'wrote-from-B.txt')
const checkFile = (p: string) => () => {
  if (existsSync(p)) {
    const sz = statSync(p).size
    return `EXISTS (${sz} bytes)`
  }
  return 'MISSING'
}

// Reset scratch state
for (const f of [FILE_A, FILE_B, OUT_TMP]) if (existsSync(f)) unlinkSync(f)

const trials: TrialResult[] = []

trials.push(await runTrial(
  'A · read-only sandbox + never-approve',
  'read-only',
  'never',
  `Write a file at ${FILE_A} containing exactly the text "spike3-trial-A". Use your shell or whatever tool you have. If the sandbox blocks you, do not retry — just say so in your final message.`,
  'Write should be denied / fail (read-only sandbox forbids writes).',
  checkFile(FILE_A),
  `does ${FILE_A} exist after the trial?`,
))

trials.push(await runTrial(
  'B · workspace-write sandbox + never-approve',
  'workspace-write',
  'never',
  `Write a file at ${FILE_B} containing exactly the text "spike3-trial-B".`,
  'Write should succeed (workspace-write covers cwd).',
  checkFile(FILE_B),
  `does ${FILE_B} exist after the trial?`,
))

trials.push(await runTrial(
  'C · workspace-write + on-request',
  'workspace-write',
  'on-request',
  `Write a file at ${OUT_TMP} containing exactly the text "spike3-trial-C". This is OUTSIDE the cwd, in the system tmp directory.`,
  'on-request: SDK might auto-deny, hang, or auto-approve via additionalDirectories. Document whichever.',
  checkFile(OUT_TMP),
  `does ${OUT_TMP} exist after the trial? (additionalDirectories=[tmpdir] is set)`,
))

const summary = {
  spec_version: '@openai/codex-sdk@0.128.0',
  trials,
  conclusions: [] as string[],
}

const A = trials[0]!
const B = trials[1]!
const C = trials[2]!

if (A.side_effect_check.observed === 'MISSING' && (A.turn_outcome === 'completed' || A.turn_outcome === 'failed')) {
  summary.conclusions.push('A confirms read-only sandbox blocks writes (good — matches docs).')
} else {
  summary.conclusions.push(`A UNEXPECTED: outcome=${A.turn_outcome}, side_effect=${A.side_effect_check.observed}`)
}

if (B.side_effect_check.observed.startsWith('EXISTS') && B.turn_outcome === 'completed') {
  summary.conclusions.push('B confirms workspace-write + never-approve writes within cwd unattended.')
} else {
  summary.conclusions.push(`B UNEXPECTED: outcome=${B.turn_outcome}, side_effect=${B.side_effect_check.observed}`)
}

summary.conclusions.push(`C observed behaviour with on-request: outcome=${C.turn_outcome}, side_effect=${C.side_effect_check.observed}, duration=${C.duration_ms}ms`)

if (C.turn_outcome === 'timeout') {
  summary.conclusions.push('C TIMED OUT — on-request likely waits for human approval that never comes. Daemon-mode default MUST be approvalPolicy=never to avoid hangs.')
} else if (C.side_effect_check.observed.startsWith('EXISTS')) {
  summary.conclusions.push('C wrote OUTSIDE cwd via additionalDirectories. additionalDirectories does extend write scope.')
} else {
  summary.conclusions.push('C did NOT write — on-request auto-denied or Codex chose not to.')
}

summary.conclusions.push(
  'There is NO per-tool callback (canUseTool equivalent) in @openai/codex-sdk@0.128.0. ' +
  'Permission relay on the Codex side must degrade to (sandboxMode + approvalPolicy + additionalDirectories) coarse config. ' +
  'Daemon ship default: sandboxMode=workspace-write, approvalPolicy=never, additionalDirectories=[]. ' +
  'For dangerouslySkipPermissions=false, no fine-grained approval is currently possible — surface this as a documented Codex-side limitation in RFC 03 §10.',
)

writeFileSync(MATRIX_FILE, JSON.stringify(summary, null, 2) + '\n')

console.log('')
console.log('=== Spike 3 result matrix ===')
console.log(JSON.stringify(summary, null, 2))
console.log('')
console.log('matrix.json written to:', MATRIX_FILE)

const allTrialsCompleted = trials.every(t => t.turn_outcome === 'completed' || t.turn_outcome === 'failed')
if (allTrialsCompleted) {
  console.log('\n[spike3] PASS ✅')
  console.log('[spike3] permission matrix mapped; codex-agent-provider can be configured against documented behaviour')
  process.exit(0)
} else {
  console.error('\n[spike3] PARTIAL ⚠️')
  console.error('  - one or more trials timed out / threw — this is informational, not blocking. See matrix.json.')
  process.exit(0) // Spike 3 is exploratory, not pass/fail; record matrix and move on.
}
