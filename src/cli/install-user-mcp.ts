/**
 * install-user-mcp.ts — idempotently add wechat-cc to Claude Code's
 * user-scope MCP config (~/.claude.json).
 *
 * Installing at user scope (vs project scope .mcp.json) means the wechat
 * channel auto-attaches in every Claude Code session regardless of cwd,
 * which is required for the /project switch flow to work — the new
 * session needs the wechat MCP tool available immediately after chdir.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs'

export interface McpServerConfig {
  command: string
  args: string[]
  env?: Record<string, string>
}

interface ClaudeUserConfig {
  mcpServers?: Record<string, McpServerConfig>
  [key: string]: unknown
}

function readConfig(file: string): ClaudeUserConfig {
  if (!existsSync(file)) return {}
  try { return JSON.parse(readFileSync(file, 'utf8')) as ClaudeUserConfig }
  catch { return {} }
}

function writeConfig(file: string, cfg: ClaudeUserConfig): void {
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, file)
}

export function installUserMcp(file: string, name: string, entry: McpServerConfig): void {
  const cfg = readConfig(file)
  if (!cfg.mcpServers) cfg.mcpServers = {}
  cfg.mcpServers[name] = entry
  writeConfig(file, cfg)
}
