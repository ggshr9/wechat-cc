#!/usr/bin/env bun
/**
 * Phase 0-RFC03 Spike 1: Codex SDK programmatic MCP injection.
 *
 * RFC 03 §9 Spike 1 — verify that `Codex({ config: { mcp_servers: {...} } })`
 * causes the underlying Codex CLI session to actually load + invoke a stdio
 * MCP server during a `thread.run()` call.
 *
 * If this passes, RFC 03's two-MCP-server design (wechat-mcp + delegate-mcp
 * loaded by both Claude and Codex via programmatic config) is green-lit.
 * If it fails, we fall back to writing `~/.codex/config.toml` from the
 * installer (Appendix B in RFC 03).
 *
 * Pass criteria:
 *   - thread.runStreamed yields an `item.completed` event whose item is
 *     `{ type: 'mcp_tool_call', server: 'echo', tool: 'echo', ... }`
 *   - The tool call's `result.content[0].text` echoes back the SENTINEL
 *   - The final `agent_message` mentions the SENTINEL (proving Codex saw
 *     the tool's response)
 *
 * Auth: this spike is auth-agnostic. The SDK transparently inherits
 * process.env into the spawned codex child (dist/index.js:222-241), so
 * any of the following will work:
 *   - `codex login` previously run → ~/.codex/auth.json (ChatGPT subscription)
 *   - OPENAI_API_KEY / CODEX_API_KEY in env
 *   - api key in ~/.codex/config.toml
 * We deliberately do NOT pass `apiKey` to `new Codex({...})` — that would
 * override stored auth and lock the spike to the API-key path. RFC 03
 * principle: wechat-cc daemon never cares which auth mode a user is on.
 */
import { Codex, type ThreadEvent, type ThreadItem } from '@openai/codex-sdk'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ECHO_SERVER = join(HERE, 'echo-mcp-server.ts')
const SENTINEL = 'SPIKE-MCP-OK-9b3e7f'

const PROMPT = `Call the \`echo\` MCP tool with the argument {"text":"${SENTINEL}"}. Then in your final message, repeat back the exact string the tool returned. No commentary, no quotes — just the raw string on its own line.`

function log(...args: unknown[]): void {
  console.error('[spike1]', ...args)
}

log('cwd:', process.cwd())
log('echo MCP server path:', ECHO_SERVER)
log('auth: deferred to codex CLI (codex login OR OPENAI_API_KEY/CODEX_API_KEY in env OR ~/.codex/config.toml)')

// Path to the bundled codex CLI from @openai/codex (peer dep installed in this folder)
const CODEX_BIN = join(HERE, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')

// Note: NO apiKey passed. SDK transparently inherits process.env, so codex
// CLI uses whichever auth method the user has set up (subscription or API
// key — we don't care). If neither is configured, the CLI fails fast with
// its own auth error message, which is more useful than us pre-checking.
const codex = new Codex({
  codexPathOverride: process.env.CODEX_PATH ?? CODEX_BIN,
  config: {
    // This is THE thing Spike 1 is testing: does the SDK's `--config
    // <dotted.path>=<toml>` flattening result in a Codex CLI session that
    // actually loads the echo MCP server?
    mcp_servers: {
      echo: {
        command: process.execPath, // bun or node, whichever is running this spike
        args: [ECHO_SERVER],
      },
    },
  },
})

const thread = codex.startThread({
  workingDirectory: process.cwd(),
  skipGitRepoCheck: true,
  approvalPolicy: 'never',
  sandboxMode: 'workspace-write',
})

log('thread starting, prompt:', JSON.stringify(PROMPT.slice(0, 100)))
const started = Date.now()

let sawMcpToolCall = false
let mcpToolCallResultText: string | null = null
let finalAgentMessage = ''
let threadId: string | null = null
let turnCompleted = false

try {
  const { events } = await thread.runStreamed(PROMPT)

  for await (const ev of events as AsyncGenerator<ThreadEvent>) {
    const elapsed = Date.now() - started
    log(`[${elapsed}ms]`, ev.type)

    if (ev.type === 'thread.started') {
      threadId = ev.thread_id
      log('  thread_id =', threadId)
    } else if (ev.type === 'item.completed') {
      const item = (ev as { item: ThreadItem }).item
      log('  item.type =', item.type, 'id=', item.id)

      if (item.type === 'mcp_tool_call') {
        sawMcpToolCall = true
        log('    server=', item.server, 'tool=', item.tool, 'status=', item.status)
        log('    arguments=', JSON.stringify(item.arguments))
        if (item.status === 'completed' && item.result) {
          const blocks = item.result.content as Array<{ type?: string; text?: string }>
          const textBlock = blocks.find(b => b?.type === 'text')
          mcpToolCallResultText = textBlock?.text ?? null
          log('    result.text=', JSON.stringify(mcpToolCallResultText))
        }
        if (item.status === 'failed' && item.error) {
          log('    ERROR=', item.error.message)
        }
      } else if (item.type === 'agent_message') {
        finalAgentMessage = item.text
      }
    } else if (ev.type === 'turn.completed') {
      turnCompleted = true
      log('  usage=', JSON.stringify(ev.usage))
    } else if (ev.type === 'turn.failed' || ev.type === 'error') {
      log('  ERROR=', JSON.stringify(ev))
    }
  }
} catch (err) {
  log('FAIL: runStreamed threw:', err instanceof Error ? `${err.name}: ${err.message}\n${err.stack}` : err)
  process.exit(1)
}

const totalElapsed = Date.now() - started
console.log('')
console.log('=== Spike 1 result ===')
console.log('total elapsed       :', totalElapsed, 'ms')
console.log('thread_id           :', threadId)
console.log('turn completed      :', turnCompleted)
console.log('saw mcp_tool_call   :', sawMcpToolCall)
console.log('tool result text    :', JSON.stringify(mcpToolCallResultText))
console.log('final agent message :', JSON.stringify(finalAgentMessage.slice(0, 200)))

const toolHitSentinel = mcpToolCallResultText === SENTINEL
const replyHitSentinel = finalAgentMessage.includes(SENTINEL)

console.log('tool returned       :', toolHitSentinel ? `OK (matches ${SENTINEL})` : 'MISMATCH')
console.log('reply contains      :', replyHitSentinel ? 'OK' : 'NO')

if (sawMcpToolCall && toolHitSentinel && replyHitSentinel && turnCompleted) {
  console.log('\n[spike1] PASS ✅')
  console.log('[spike1] Codex SDK programmatic MCP injection works end-to-end.')
  console.log('[spike1] RFC 03 §5.2 design (programmatic mcp_servers config) is green-lit.')
  process.exit(0)
} else {
  console.error('\n[spike1] FAIL ❌')
  if (!sawMcpToolCall) console.error('  - no mcp_tool_call item observed → Codex CLI did not load the echo server')
  if (!toolHitSentinel) console.error('  - tool result did not match sentinel')
  if (!replyHitSentinel) console.error('  - final agent message did not contain sentinel')
  if (!turnCompleted) console.error('  - turn never completed')
  console.error('  → fall back to ~/.codex/config.toml strategy (RFC 03 Appendix B)')
  process.exit(1)
}
