/**
 * Stdio MCP server spec builders for the wechat + delegate MCP children.
 * Both providers (Claude and Codex) receive these specs in their respective
 * SDK options, then spawn the MCP child as a subprocess that talks back
 * to the daemon's internal-api over loopback HTTP (RFC 03 §5).
 *
 * The optional `participantTag` (RFC 03 P3) is the providerId baked into
 * the wechat-mcp child's env so the stdio reply tool can identify which
 * agent generated each reply. internal-api uses this to prefix `[Claude]`
 * / `[Codex]` in parallel + chatroom modes.
 *
 * History: from P1.A through P1.B B6 the wechat stdio server was named
 * `wechat_ipc` to coexist with the legacy in-process `wechat` server.
 * After B1 the legacy server is gone and the stdio one inherits the
 * canonical `wechat` name — keeping tool names like `mcp__wechat__reply`
 * stable for the agent and the providers' replyToolCalled detection.
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ProviderId } from '../../core/conversation'

export interface McpStdioSpec {
  command: string
  args: string[]
  env: Record<string, string>
}

export interface McpSpecDeps {
  baseUrl: string
  tokenFilePath: string
}

function mcpServerScriptPath(name: 'wechat' | 'delegate'): string {
  // Resolve relative to this file's location.
  // src/daemon/bootstrap/mcp-specs.ts → ../../mcp-servers/<name>/main.ts
  const here = dirname(fileURLToPath(import.meta.url))
  return join(here, '..', '..', 'mcp-servers', name, 'main.ts')
}

export function wechatStdioMcpSpec(
  internalApi: McpSpecDeps,
  participantTag?: ProviderId,
): McpStdioSpec {
  return {
    command: process.execPath,  // bun or node — whichever is running the daemon
    args: [mcpServerScriptPath('wechat')],
    env: {
      WECHAT_INTERNAL_API: internalApi.baseUrl,
      WECHAT_INTERNAL_TOKEN_FILE: internalApi.tokenFilePath,
      ...(participantTag ? { WECHAT_PARTICIPANT_TAG: participantTag } : {}),
    },
  }
}

export function delegateStdioMcpSpec(
  internalApi: McpSpecDeps,
  peer: ProviderId,
): McpStdioSpec {
  return {
    command: process.execPath,
    args: [mcpServerScriptPath('delegate')],
    env: {
      WECHAT_INTERNAL_API: internalApi.baseUrl,
      WECHAT_INTERNAL_TOKEN_FILE: internalApi.tokenFilePath,
      WECHAT_DELEGATE_PEER: peer,
    },
  }
}
