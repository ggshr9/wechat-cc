#!/usr/bin/env bun
/**
 * Phase 0 Spike 1: Bun + Claude Agent SDK headless stability check.
 *
 * Goal: verify `@anthropic-ai/claude-agent-sdk` starts claude as a headless
 * subprocess on this platform without ANY dialog — no workspace-trust, no
 * dev-channel, no permission prompt. If this passes on Windows, the core
 * architectural bet for the Agent-SDK rebuild is validated.
 *
 * Pass criteria:
 *   - Process returns within ~60s
 *   - No interactive dialog shown to the user
 *   - `result` message received with num_turns >= 1
 *   - Assistant text contains the sentinel "SPIKE_OK"
 */
import { query } from '@anthropic-ai/claude-agent-sdk'

const SENTINEL = 'SPIKE_OK'
const PROMPT = `Reply with exactly the text ${SENTINEL} and nothing else. No punctuation, no quotes, no explanation.`

console.log('[spike] platform:', process.platform, process.arch)
console.log('[spike] runtime:', typeof Bun !== 'undefined' ? `bun ${Bun.version}` : 'not-bun')
console.log('[spike] cwd:', process.cwd())
console.log('[spike] starting query()...')

const started = Date.now()
let assistantText = ''
let sawResult = false
let resultSnapshot: unknown = null
let messageCount = 0

try {
  const q = query({
    prompt: PROMPT,
    options: {
      cwd: process.cwd(),
      permissionMode: 'bypassPermissions',
      // Minimal — no MCP servers, no hooks, no plugins. Pure headless claude.
    },
  })

  for await (const msg of q) {
    messageCount++
    const elapsed = Date.now() - started
    const kind = (msg as { type?: string })?.type ?? 'unknown'
    console.log(`[spike] [${elapsed}ms] msg #${messageCount}: type=${kind}`)

    // Capture assistant text
    if (kind === 'assistant') {
      const m = msg as { message?: { content?: unknown } }
      const content = m.message?.content
      if (typeof content === 'string') {
        assistantText += content
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (
            block &&
            typeof block === 'object' &&
            (block as { type?: string }).type === 'text'
          ) {
            assistantText += (block as { text?: string }).text ?? ''
          }
        }
      }
    }

    if (kind === 'result') {
      sawResult = true
      resultSnapshot = msg
    }
  }
} catch (err) {
  console.error('[spike] query() threw:', err)
  process.exit(2)
}

const totalElapsed = Date.now() - started
const trimmed = assistantText.trim()
const hasSentinel = trimmed.includes(SENTINEL)

console.log('\n=== Spike 1 result ===')
console.log('total elapsed :', totalElapsed, 'ms')
console.log('messages seen :', messageCount)
console.log('got result    :', sawResult)
console.log('assistant txt :', JSON.stringify(trimmed.slice(0, 200)))
console.log('sentinel hit  :', hasSentinel)

if (sawResult && resultSnapshot && typeof resultSnapshot === 'object') {
  const r = resultSnapshot as Record<string, unknown>
  console.log('result.session_id    :', r.session_id)
  console.log('result.num_turns     :', r.num_turns)
  console.log('result.total_cost_usd:', r.total_cost_usd)
  console.log('result.duration_ms   :', r.duration_ms)
}

if (sawResult && hasSentinel) {
  console.log('\n[spike] PASS ✅')
  console.log('[spike] headless claude responded with no dialog on', process.platform)
  process.exit(0)
} else {
  console.error('\n[spike] FAIL ❌')
  if (!sawResult) console.error('  - missing result message')
  if (!hasSentinel) console.error('  - assistant did not emit sentinel; saw:', trimmed)
  process.exit(1)
}
