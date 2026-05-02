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
      logErr(`ping failed: ${formatError(err)}`)
      return {
        content: [{ type: 'text', text: `ping failed: ${formatError(err)}` }],
        isError: true,
      }
    }
  },
)

// ─── memory_* (RFC 03 P1.B B2) ──────────────────────────────────────────
// Mirror legacy wire shapes (features/tools.ts:313-357) so the system
// prompt's tool documentation continues to read true. These tools were
// in the in-process `wechat` server before B2; now they live exclusively
// here. P1.B keeps them sandboxed under `<stateDir>/memory/` via
// MemoryFS — same instance as before, called over loopback.

server.registerTool(
  'memory_read',
  {
    title: 'Read memory file',
    description: '读 memory/ 下的一个文件。不存在返回 exists:false。相对路径，只允许 .md。',
    inputSchema: { path: z.string() },
  },
  async ({ path }) => {
    try {
      const resp = await client.request<{ exists: boolean; content?: string; error?: string }>(
        'POST', '/v1/memory/read', { path },
      )
      // Preserve legacy wire shape: agent sees the same JSON it always saw.
      return { content: [{ type: 'text', text: JSON.stringify(resp) }] }
    } catch (err) {
      return memoryErrorResult(err, 'memory_read')
    }
  },
)

server.registerTool(
  'memory_write',
  {
    title: 'Write memory file',
    description: '写 memory/ 下的一个文件（atomic, 覆盖）。相对路径，只允许 .md。单文件 100KB 上限。父目录自动创建。',
    inputSchema: { path: z.string(), content: z.string() },
  },
  async ({ path, content }) => {
    try {
      const resp = await client.request<{ ok: boolean; error?: string }>(
        'POST', '/v1/memory/write', { path, content },
      )
      return { content: [{ type: 'text', text: JSON.stringify(resp) }] }
    } catch (err) {
      return memoryErrorResult(err, 'memory_write')
    }
  },
)

server.registerTool(
  'memory_list',
  {
    title: 'List memory files',
    description: '列 memory/ 下所有 .md 文件（递归）。传 dir 只列该子目录。返回相对路径数组。',
    inputSchema: { dir: z.string().optional() },
  },
  async ({ dir }) => {
    try {
      const qs = dir ? `?dir=${encodeURIComponent(dir)}` : ''
      const resp = await client.request<{ files: string[]; error?: string }>(
        'GET', `/v1/memory/list${qs}`,
      )
      return { content: [{ type: 'text', text: JSON.stringify(resp) }] }
    } catch (err) {
      return memoryErrorResult(err, 'memory_list')
    }
  },
)

function memoryErrorResult(err: unknown, tool: string): { content: Array<{ type: 'text'; text: string }> } {
  // The legacy in-process tools never threw — they caught everything and
  // returned `{error: "..."}` JSON so the agent could see the failure
  // mode. We do the same shape here on transport-layer failures (cannot
  // reach internal-api, etc.); MemoryFS errors come back as 200 + body
  // already in this shape via the route handler.
  const detail = formatError(err)
  logErr(`${tool} transport failed: ${detail}`)
  return { content: [{ type: 'text', text: JSON.stringify({ error: detail }) }] }
}

function formatError(err: unknown): string {
  if (err instanceof InternalApiError) {
    return `internal-api ${err.status}: ${JSON.stringify(err.body).slice(0, 200)}`
  }
  return err instanceof Error ? err.message : String(err)
}

const transport = new StdioServerTransport()
await server.connect(transport)
logErr(`ready (pid=${process.pid}, base=${baseUrl})`)
