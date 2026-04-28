import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export type AgentProviderKind = 'claude' | 'codex'

export interface AgentConfig {
  provider: AgentProviderKind
  model?: string
  // When true, the daemon spawned by `service install` runs with
  // `cli.ts run --dangerously` (Claude SDK permissionMode=bypassPermissions).
  // Wizard-installed daemons need this on by default — there is no human
  // to answer permission prompts triggered by inbound WeChat messages.
  dangerouslySkipPermissions: boolean
  // When true, `service install` registers the unit for auto-start at
  // login/boot (macOS RunAtLoad, systemd `enable`, schtasks ONLOGON).
  // When false (default), the daemon is started this session only —
  // opt-in design per user request 2026-04-26.
  autoStart: boolean
  // When true (default), the daemon is restarted automatically on crash
  // (macOS KeepAlive, systemd Restart=always). Decoupled from autoStart
  // per user request 2026-04-28: most users want crash-recovery on, but
  // not everyone wants the daemon launched at every login.
  keepAlive: boolean
}

const CONFIG_FILE = 'agent-config.json'

export function loadAgentConfig(stateDir: string): AgentConfig {
  try {
    const raw = readFileSync(join(stateDir, CONFIG_FILE), 'utf8')
    const parsed = JSON.parse(raw) as Partial<AgentConfig>
    const dangerouslySkipPermissions = parsed.dangerouslySkipPermissions ?? true
    const autoStart = parsed.autoStart ?? false
    // Migration: pre-2026-04-28 configs only have `autoStart`. Mirror it
    // into `keepAlive` so existing installs preserve their crash-restart
    // behavior. New configs written by the GUI set both explicitly.
    const keepAlive = parsed.keepAlive ?? autoStart
    if (parsed.provider === 'codex') {
      return parsed.model
        ? { provider: 'codex', model: parsed.model, dangerouslySkipPermissions, autoStart, keepAlive }
        : { provider: 'codex', dangerouslySkipPermissions, autoStart, keepAlive }
    }
    return { provider: 'claude', dangerouslySkipPermissions, autoStart, keepAlive }
  } catch {
    return { provider: 'claude', dangerouslySkipPermissions: true, autoStart: false, keepAlive: false }
  }
}

export function saveAgentConfig(stateDir: string, config: AgentConfig): void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const file = join(stateDir, CONFIG_FILE)
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, file)
}
