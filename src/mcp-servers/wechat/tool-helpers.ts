/**
 * Shared helpers for the wechat-mcp tool handlers. Extracted from main.ts so
 * tool groups can live in their own files (tools-daemon.ts, …) without each
 * re-implementing the error/logging plumbing. Stdout is the MCP transport —
 * logs go to stderr only.
 */
import { InternalApiError } from './client'

export function logErr(line: string): void {
  process.stderr.write(`[wechat-mcp] ${line}\n`)
}

export function passthroughErrorResult(err: unknown, tool: string): { content: Array<{ type: 'text'; text: string }> } {
  // Surface transport-layer failures as `{error: "..."}` JSON in a text
  // block. Keeps the legacy "tool never throws" promise that the
  // in-process versions enforced — agent sees a structured failure
  // result, not an MCP exception.
  //
  // STDERR log gets the short, body-free form (status + endpoint only)
  // — Phase 4 polish. The downstream JSON returned to the agent still
  // carries the full detail; we just don't spam channel-log readers
  // with redacted-feeling response bodies.
  logErr(`${tool} transport failed: ${formatErrorShort(err)}`)
  return { content: [{ type: 'text', text: JSON.stringify({ error: formatError(err) }) }] }
}

export function formatError(err: unknown): string {
  if (err instanceof InternalApiError) {
    return `internal-api ${err.status}: ${JSON.stringify(err.body).slice(0, 200)}`
  }
  return err instanceof Error ? err.message : String(err)
}

export function formatErrorShort(err: unknown): string {
  // Body-free form for stderr logging — omits response payload so
  // sensitive content doesn't end up in operator log scrollback.
  if (err instanceof InternalApiError) {
    return `internal-api ${err.status} ${err.path}`
  }
  return err instanceof Error ? err.message : String(err)
}
