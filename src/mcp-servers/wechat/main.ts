#!/usr/bin/env bun
/**
 * wechat-mcp — standalone stdio MCP server (RFC 03 §5).
 *
 * Loaded by both the Claude Agent SDK and Codex SDK as a stdio MCP
 * server. Exposes the wechat tool family (P1.B will populate it: reply,
 * memory_*, voice_*, projects_*, ...). For P1.A there's only one tool —
 * `ping` — which calls daemon's internal-api `/v1/health` to prove the
 * full provider → stdio MCP → loopback HTTP → daemon round-trip works.
 *
 * Two env vars must be set by the spawning daemon:
 *   WECHAT_INTERNAL_API        e.g. http://127.0.0.1:54321
 *   WECHAT_INTERNAL_TOKEN_FILE absolute path to mode-0600 token file
 *
 * Stdout is the MCP transport — DO NOT write logs there. All logs go
 * to stderr.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { createInternalApiClient, InternalApiError } from './client'

function logErr(line: string): void {
  process.stderr.write(`[wechat-mcp] ${line}\n`)
}

const baseUrl = process.env.WECHAT_INTERNAL_API
const tokenFilePath = process.env.WECHAT_INTERNAL_TOKEN_FILE

if (!baseUrl || !tokenFilePath) {
  logErr('FATAL: WECHAT_INTERNAL_API and WECHAT_INTERNAL_TOKEN_FILE env vars are required')
  logErr(`got WECHAT_INTERNAL_API=${baseUrl ?? '(unset)'} WECHAT_INTERNAL_TOKEN_FILE=${tokenFilePath ?? '(unset)'}`)
  process.exit(2)
}

const client = createInternalApiClient({
  baseUrl,
  tokenFilePath,
  logger: logErr,
})

const server = new McpServer(
  { name: 'wechat-mcp', version: '0.1.0' },
  { capabilities: { tools: {} } },
)

// ──────────────────────────────────────────────────────────────────────
// Tools
// ──────────────────────────────────────────────────────────────────────
//
// P1.A: just `ping`. Tool list will grow in P1.B. Each tool's
// implementation is a thin wrapper over the internal-api client; the
// real logic lives in src/features/tools.ts → bridged via internal-api.

server.registerTool(
  'ping',
  {
    title: 'Ping daemon',
    description: 'Round-trips a request through the daemon internal-api and returns its pid. Used by integration tests to verify the full MCP-over-stdio + internal-api channel is alive.',
    inputSchema: {},
    outputSchema: {
      ok: z.boolean(),
      daemon_pid: z.number(),
    },
  },
  async () => {
    try {
      const resp = await client.request<{ ok: boolean; daemon_pid: number }>('GET', '/v1/health')
      return {
        content: [{ type: 'text', text: JSON.stringify(resp) }],
        structuredContent: resp,
      }
    } catch (err) {
      const detail = err instanceof InternalApiError
        ? `internal-api ${err.status}: ${JSON.stringify(err.body).slice(0, 200)}`
        : err instanceof Error ? err.message : String(err)
      logErr(`ping failed: ${detail}`)
      return {
        content: [{ type: 'text', text: `ping failed: ${detail}` }],
        isError: true,
      }
    }
  },
)

const transport = new StdioServerTransport()
await server.connect(transport)
logErr(`ready (pid=${process.pid}, base=${baseUrl})`)
