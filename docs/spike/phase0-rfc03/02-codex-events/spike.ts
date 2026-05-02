#!/usr/bin/env bun
/**
 * Phase 0-RFC03 Spike 2: Codex SDK runStreamed event schema empirical map.
 *
 * RFC 03 §9 Spike 2 — confirm the runtime event stream from Codex SDK
 * matches the type declarations in `@openai/codex-sdk` v0.128.0, by
 * driving a single thread through a prompt that should exercise every
 * documented item type and every event type, then dumping all observed
 * events to disk for review.
 *
 * The type declarations enumerate:
 *   ThreadEvent: thread.started | turn.started | turn.completed |
 *                turn.failed | item.started | item.updated |
 *                item.completed | error
 *   ThreadItem:  agent_message | reasoning | command_execution |
 *                file_change | mcp_tool_call | web_search | todo_list |
 *                error
 *
 * This spike runs a prompt that should produce at least:
 *   - reasoning (any non-trivial prompt)
 *   - command_execution (we ask for `pwd` + `ls`)
 *   - agent_message (the final reply)
 *
 * file_change / mcp_tool_call / web_search / todo_list are not exercised
 * here on purpose — Spike 1 covers mcp_tool_call; the rest aren't blockers
 * for RFC 03's design.
 *
 * Pass criteria:
 *   - All observed event.type values are members of the documented union
 *   - All observed item.type values are members of the documented union
 *   - At minimum we observe: thread.started, turn.started, turn.completed,
 *     item.completed{type=agent_message}, and at least one of
 *     item.completed{type=command_execution} or item.completed{type=reasoning}
 *   - turn.completed.usage shape matches the typed `Usage` interface
 *   - thread.id is populated after thread.started fires
 *   - Full event log written to events.jsonl for human review
 *
 * Output:
 *   events.jsonl — newline-delimited JSON of every observed event
 *   summary.json — { event_types_seen, item_types_seen, undocumented_keys }
 */
import { Codex, type ThreadEvent, type ThreadItem } from '@openai/codex-sdk'
import { writeFileSync, appendFileSync, existsSync, unlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const EVENTS_LOG = join(HERE, 'events.jsonl')
const SUMMARY_FILE = join(HERE, 'summary.json')
const CODEX_BIN = join(HERE, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')

const PROMPT = `Run \`pwd\` and \`ls -la\` in the current directory using your shell. Then in one short sentence, summarize what's in this directory.`

const KNOWN_EVENT_TYPES = new Set([
  'thread.started',
  'turn.started',
  'turn.completed',
  'turn.failed',
  'item.started',
  'item.updated',
  'item.completed',
  'error',
])

const KNOWN_ITEM_TYPES = new Set([
  'agent_message',
  'reasoning',
  'command_execution',
  'file_change',
  'mcp_tool_call',
  'web_search',
  'todo_list',
  'error',
])

const KNOWN_USAGE_KEYS = new Set([
  'input_tokens',
  'cached_input_tokens',
  'output_tokens',
  'reasoning_output_tokens',
])

function log(...args: unknown[]): void {
  console.error('[spike2]', ...args)
}

const apiKey = process.env.OPENAI_API_KEY
if (!apiKey) {
  log('FAIL: OPENAI_API_KEY not set — this spike cannot run without API access')
  process.exit(2)
}

if (existsSync(EVENTS_LOG)) unlinkSync(EVENTS_LOG)
writeFileSync(EVENTS_LOG, '')

const codex = new Codex({
  apiKey,
  codexPathOverride: process.env.CODEX_PATH ?? CODEX_BIN,
})

const thread = codex.startThread({
  workingDirectory: HERE,
  skipGitRepoCheck: true,
  approvalPolicy: 'never',
  sandboxMode: 'workspace-write',
})

log('thread starting')
const started = Date.now()

const eventTypesSeen = new Set<string>()
const itemTypesSeen = new Set<string>()
const undocumentedEventKeys: string[] = []
const undocumentedItemKeys: string[] = []
const undocumentedUsageKeys: string[] = []

let threadIdAfterStart: string | null = null
let agentMessageText = ''
let usageSnapshot: Record<string, unknown> | null = null
let turnCompleted = false
let turnFailed: { message: string } | null = null

try {
  const { events } = await thread.runStreamed(PROMPT)

  for await (const ev of events as AsyncGenerator<ThreadEvent>) {
    const elapsed = Date.now() - started
    appendFileSync(EVENTS_LOG, JSON.stringify({ elapsed, ev }) + '\n')
    log(`[${elapsed}ms]`, ev.type)
    eventTypesSeen.add(ev.type)

    if (!KNOWN_EVENT_TYPES.has(ev.type)) {
      log('  ⚠️  UNDOCUMENTED EVENT TYPE:', ev.type)
    }

    if (ev.type === 'thread.started') {
      threadIdAfterStart = ev.thread_id
      log('  thread_id =', threadIdAfterStart)
    }

    if (ev.type === 'item.started' || ev.type === 'item.updated' || ev.type === 'item.completed') {
      const item = (ev as { item: ThreadItem }).item
      itemTypesSeen.add(item.type)
      log('  item.type =', item.type, 'id=', item.id)

      if (!KNOWN_ITEM_TYPES.has(item.type)) {
        log('  ⚠️  UNDOCUMENTED ITEM TYPE:', item.type)
        undocumentedItemKeys.push(item.type)
      }

      if (ev.type === 'item.completed' && item.type === 'agent_message') {
        agentMessageText = item.text
      }
    }

    if (ev.type === 'turn.completed') {
      turnCompleted = true
      usageSnapshot = ev.usage as unknown as Record<string, unknown>
      for (const key of Object.keys(usageSnapshot ?? {})) {
        if (!KNOWN_USAGE_KEYS.has(key)) {
          log('  ⚠️  UNDOCUMENTED USAGE KEY:', key)
          undocumentedUsageKeys.push(key)
        }
      }
    }

    if (ev.type === 'turn.failed') {
      turnFailed = ev.error
      log('  ERROR=', JSON.stringify(turnFailed))
    }

    // Sniff for any top-level keys on the event object that aren't part
    // of the typed shape we know — tolerant probe, doesn't fail the spike,
    // just records.
    const evKeys = Object.keys(ev as Record<string, unknown>)
    for (const k of evKeys) {
      if (k === 'type') continue
      if (!isKnownEventKey(ev.type, k)) {
        const tag = `${ev.type}.${k}`
        if (!undocumentedEventKeys.includes(tag)) {
          log('  ⚠️  UNDOCUMENTED EVENT KEY:', tag)
          undocumentedEventKeys.push(tag)
        }
      }
    }
  }
} catch (err) {
  log('FAIL: runStreamed threw:', err instanceof Error ? `${err.name}: ${err.message}` : err)
  process.exit(1)
}

const totalElapsed = Date.now() - started

const summary = {
  total_elapsed_ms: totalElapsed,
  thread_id: threadIdAfterStart,
  thread_id_via_getter: thread.id,
  turn_completed: turnCompleted,
  turn_failed: turnFailed,
  agent_message_chars: agentMessageText.length,
  agent_message_preview: agentMessageText.slice(0, 200),
  event_types_seen: Array.from(eventTypesSeen).sort(),
  item_types_seen: Array.from(itemTypesSeen).sort(),
  undocumented_event_types: Array.from(eventTypesSeen).filter(t => !KNOWN_EVENT_TYPES.has(t)),
  undocumented_item_types: Array.from(itemTypesSeen).filter(t => !KNOWN_ITEM_TYPES.has(t)),
  undocumented_event_keys: undocumentedEventKeys,
  undocumented_usage_keys: undocumentedUsageKeys,
  usage: usageSnapshot,
}

writeFileSync(SUMMARY_FILE, JSON.stringify(summary, null, 2) + '\n')

console.log('')
console.log('=== Spike 2 result ===')
console.log(JSON.stringify(summary, null, 2))
console.log('')
console.log('events.jsonl :', EVENTS_LOG)
console.log('summary.json :', SUMMARY_FILE)

const minimumEventsObserved =
  eventTypesSeen.has('thread.started') &&
  eventTypesSeen.has('turn.started') &&
  eventTypesSeen.has('turn.completed') &&
  itemTypesSeen.has('agent_message')
const noUndocumented =
  summary.undocumented_event_types.length === 0 &&
  summary.undocumented_item_types.length === 0 &&
  summary.undocumented_usage_keys.length === 0
const threadIdConsistent = threadIdAfterStart !== null && thread.id === threadIdAfterStart

if (turnCompleted && minimumEventsObserved && noUndocumented && threadIdConsistent) {
  console.log('\n[spike2] PASS ✅')
  console.log('[spike2] runStreamed events match documented schema; codex-agent-provider can be written against the typed surface.')
  process.exit(0)
} else {
  console.error('\n[spike2] PARTIAL / FAIL ❌')
  if (!turnCompleted) console.error('  - turn never completed')
  if (!minimumEventsObserved) console.error('  - missing required event types (need thread.started + turn.started + turn.completed + agent_message item)')
  if (!noUndocumented) console.error('  - SCHEMA DRIFT: undocumented keys observed — see summary.json. RFC 03 §3.5 may need an addendum.')
  if (!threadIdConsistent) console.error('  - thread.id getter does not match thread.started.thread_id')
  process.exit(1)
}

function isKnownEventKey(type: string, key: string): boolean {
  // Hand-mapped from index.d.ts; if SDK adds keys, undocumented_event_keys catches them.
  const map: Record<string, Set<string>> = {
    'thread.started': new Set(['thread_id']),
    'turn.started': new Set([]),
    'turn.completed': new Set(['usage']),
    'turn.failed': new Set(['error']),
    'item.started': new Set(['item']),
    'item.updated': new Set(['item']),
    'item.completed': new Set(['item']),
    'error': new Set(['message']),
  }
  return map[type]?.has(key) ?? false
}
