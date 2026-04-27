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
}

const CONFIG_FILE = 'agent-config.json'

export function loadAgentConfig(stateDir: string): AgentConfig {
  try {
    const raw = readFileSync(join(stateDir, CONFIG_FILE), 'utf8')
    const parsed = JSON.parse(raw) as Partial<AgentConfig>
    const dangerouslySkipPermissions = parsed.dangerouslySkipPermissions ?? true
    if (parsed.provider === 'codex') {
      return parsed.model
        ? { provider: 'codex', model: parsed.model, dangerouslySkipPermissions }
        : { provider: 'codex', dangerouslySkipPermissions }
    }
    return { provider: 'claude', dangerouslySkipPermissions }
  } catch {
    return { provider: 'claude', dangerouslySkipPermissions: true }
  }
}

export function saveAgentConfig(stateDir: string, config: AgentConfig): void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const file = join(stateDir, CONFIG_FILE)
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, file)
}
