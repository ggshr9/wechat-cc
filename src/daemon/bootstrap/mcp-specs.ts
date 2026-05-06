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
import { isCompiledBundle } from '../../lib/runtime-info'

export interface McpStdioSpec {
  command: string
  args: string[]
  env: Record<string, string>
}

export interface McpSpecDeps {
  baseUrl: string
  tokenFilePath: string
}

// Two spawn shapes — picked at runtime by `mcpServerArgs()`:
//
//   Source mode      → args = ['/abs/path/to/src/mcp-servers/<name>/main.ts']
//                      The daemon is `bun <main.ts>`, so process.execPath
//                      is bun and it runs the .ts file directly.
//
//   Compiled binary  → args = ['mcp-server', '<name>']
//                      process.execPath is wechat-cc-cli and the binary
//                      doesn't ship the .ts source on disk, so we re-
//                      invoke ourselves with the hidden `mcp-server`
//                      subcommand, which dynamic-imports the bundled
//                      entrypoint and runs the stdio server in-process.
//
// Bug history: through v0.5.4 this always returned the script-path form.
// In compiled-binary mode `import.meta.url` resolved to `/$bunfs/...`,
// then `path.join(.., '..', '..', ...)` collapsed the prefix and produced
// a literal `/mcp-servers/<name>/main.ts` — a non-existent absolute path.
// The spawn invoked `wechat-cc-cli /mcp-servers/wechat/main.ts`; citty
// didn't recognise the arg, printed help, exited 0. The Claude SDK saw
// no MCP protocol bytes on stdio, no `mcp__wechat__*` tools registered,
// every turn fell into FALLBACK_REPLY, and reply chunks never went through
// the proper outbound recording path. Fixed in v0.5.5.
function mcpServerArgs(name: 'wechat' | 'delegate'): string[] {
  if (isCompiledBundle()) return ['mcp-server', name]
  const here = dirname(fileURLToPath(import.meta.url))
  return [join(here, '..', '..', 'mcp-servers', name, 'main.ts')]
}

export function wechatStdioMcpSpec(
  internalApi: McpSpecDeps,
  participantTag?: ProviderId,
): McpStdioSpec {
  return {
    command: process.execPath,  // bun (source) or wechat-cc-cli (compiled)
    args: mcpServerArgs('wechat'),
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
    args: mcpServerArgs('delegate'),
    env: {
      WECHAT_INTERNAL_API: internalApi.baseUrl,
      WECHAT_INTERNAL_TOKEN_FILE: internalApi.tokenFilePath,
      WECHAT_DELEGATE_PEER: peer,
    },
  }
}
