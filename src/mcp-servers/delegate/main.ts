#!/usr/bin/env bun
/**
 * delegate-mcp — RFC 03 P4. Standalone stdio MCP server that exposes
 * the OTHER provider as a `delegate_<peer>` tool, so the primary agent
 * can run a one-shot consultation against the peer.
 *
 * Loaded alongside wechat-mcp on each provider's session. The daemon
 * sets WECHAT_DELEGATE_PEER on the spawn env to declare which peer
 * this child should expose:
 *   Claude session → WECHAT_DELEGATE_PEER=codex → registers `delegate_codex`
 *   Codex  session → WECHAT_DELEGATE_PEER=claude → registers `delegate_claude`
 *
 * Recursion prevention: structural, not counter-based. The daemon's
 * /v1/delegate handler spawns the peer with a BARE-BONES SDK config
 * (no wechat-mcp, no delegate-mcp). The spawned peer therefore has no
 * `delegate_*` tool to call — recursion is impossible by construction.
 *
 * Stdout is the MCP transport — DO NOT write logs there. All logs go
 * to stderr.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { createInternalApiClient, InternalApiError } from '../wechat/client'

function logErr(line: string): void {
  process.stderr.write(`[delegate-mcp] ${line}\n`)
}

const baseUrl = process.env.WECHAT_INTERNAL_API
const tokenFilePath = process.env.WECHAT_INTERNAL_TOKEN_FILE
const peer = process.env.WECHAT_DELEGATE_PEER

if (!baseUrl || !tokenFilePath) {
  logErr('FATAL: WECHAT_INTERNAL_API and WECHAT_INTERNAL_TOKEN_FILE env vars are required')
  process.exit(2)
}
if (!peer) {
  logErr('FATAL: WECHAT_DELEGATE_PEER env var is required (e.g. "claude" or "codex")')
  process.exit(2)
}

const client = createInternalApiClient({
  baseUrl,
  tokenFilePath,
  logger: logErr,
})

const server = new McpServer(
  { name: 'delegate-mcp', version: '0.1.0' },
  { capabilities: { tools: {} } },
)

// Display-cased peer name for the tool description (English title-case;
// the daemon's provider-display-names.ts is canonical for the user-
// facing prefix in parallel mode, but for the tool description we just
// want a readable hint).
function titleCase(s: string): string {
  if (s.length === 0) return s
  return s.charAt(0).toUpperCase() + s.slice(1)
}
const peerDisplay = titleCase(peer)

server.registerTool(
  `delegate_${peer}`,
  {
    title: `Delegate to ${peerDisplay}`,
    description:
      `把一个具体问题交给 ${peerDisplay}（另一个 AI 助手）做一次性咨询，常用于二意见 / 代码审计 / 不同视角对比。` +
      `${peerDisplay} 不会看到当前对话历史 — 你需要把背景概括在 prompt 里。` +
      `${peerDisplay} 是只读环境（不能改文件、不能发微信、不能再 delegate）。返回它的回答全文。` +
      `成本：每次约 3-5 秒冷启动。仅在用户明确要求二意见，或你认为另一视角真的能改善答案时使用。`,
    inputSchema: {
      prompt: z.string().describe(`The question or task to send to ${peerDisplay}. Self-contained — include any context the peer needs since it sees no conversation history.`),
      context_summary: z.string().optional().describe('Optional: a 1-3 sentence summary of the surrounding context if the prompt alone is ambiguous.'),
    },
  },
  async ({ prompt, context_summary }) => {
    try {
      const resp = await client.request<{ ok: boolean; response?: string; reason?: string }>(
        'POST', '/v1/delegate', { peer, prompt, context_summary },
      )
      // Pass through the daemon's structured response so the agent can
      // distinguish success / failure cleanly.
      return { content: [{ type: 'text', text: JSON.stringify(resp) }] }
    } catch (err) {
      const detail = err instanceof InternalApiError
        ? `internal-api ${err.status}: ${JSON.stringify(err.body).slice(0, 200)}`
        : err instanceof Error ? err.message : String(err)
      logErr(`delegate_${peer} failed: ${detail}`)
      return { content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: detail }) }] }
    }
  },
)

const transport = new StdioServerTransport()
await server.connect(transport)
logErr(`ready (pid=${process.pid}, peer=${peer}, base=${baseUrl})`)
