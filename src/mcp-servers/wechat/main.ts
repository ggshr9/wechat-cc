#!/usr/bin/env bun
/**
 * wechat-mcp — standalone stdio MCP server (RFC 03 §5).
 *
 * Loaded by both the Claude Agent SDK and Codex SDK as a stdio MCP server.
 * This file is the orchestrator: it sets up the client + server, registers the
 * `ping` probe inline, then delegates each tool family to its own module
 * (tools-memory / tools-projects / tools-voice-share / tools-messaging /
 * tools-companion / tools-a2a, and tools-daemon for admin sessions). Shared
 * error/log plumbing lives in tool-helpers.
 *
 * Two env vars must be set by the spawning daemon:
 *   WECHAT_INTERNAL_API        e.g. http://127.0.0.1:54321
 *   WECHAT_INTERNAL_TOKEN_FILE absolute path to mode-0600 token file
 *
 * Stdout is the MCP transport — DO NOT write logs there. All logs go to stderr.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { createInternalApiClient } from './client'
import { logErr, formatError } from './tool-helpers'
import { registerMemoryTools } from './tools-memory'
import { registerProjectTools } from './tools-projects'
import { registerVoiceShareTools } from './tools-voice-share'
import { registerMessagingTools } from './tools-messaging'
import { registerCompanionTools } from './tools-companion'
import { registerA2ASendTool } from './tools-a2a'
import { registerDaemonTools } from './tools-daemon'
import { registerFileTools } from './tools-files'

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

// Admin-session flag, derived from the non-secret WECHAT_SESSION_TIER the
// daemon bakes into THIS MCP child's env at spawn (next to the secret
// WECHAT_SESSION_TOKEN). The agent runs in the LLM and cannot alter this env,
// so gating the daemon-control tools (diagnostic_* / model_* / session_release
// / daemon_restart) on it is robust on EVERY provider — including codex, which
// has no per-tool canUseTool callback. Non-admin sessions simply don't get the
// tools registered, AND the route layer rejects a non-admin token anyway
// (defence in depth).
const SESSION_IS_ADMIN = process.env.WECHAT_SESSION_TIER === 'admin'

// `ping` stays inline — the canonical "is the MCP-over-stdio + internal-api
// channel alive" probe that integration tests assert against.
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

// Tool families — each module registers its own group (thin wrappers over the
// internal-api client). Order is preserved from the original single-file table.
registerMemoryTools(server, client)
registerProjectTools(server, client)
registerVoiceShareTools(server, client)
registerMessagingTools(server, client)
registerCompanionTools(server, client)
registerA2ASendTool(server, client)

// Daemon self-diagnosis + remediation — admin-tier sessions only (the
// provider-agnostic gate; non-admin sessions never see these tools).
if (SESSION_IS_ADMIN) {
  registerDaemonTools(server, client)
  registerFileTools(server, client)
}

const transport = new StdioServerTransport()
await server.connect(transport)
logErr(`ready (pid=${process.pid}, base=${baseUrl})`)
