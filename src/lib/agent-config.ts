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
  // v0.6 default: true — first-time GUI users expect the daemon to
  // survive reboot without an extra step.
  autoStart: boolean
  // When true, closing the desktop window terminates the daemon. Default
  // false (advanced setting): the GUI is the daemon's launcher, not its
  // host — closing the window should not stop inbound message handling.
  closeStopsDaemon: boolean
}

const CONFIG_FILE = 'agent-config.json'

export function loadAgentConfig(stateDir: string): AgentConfig {
  try {
    const raw = readFileSync(join(stateDir, CONFIG_FILE), 'utf8')
    const parsed = JSON.parse(raw) as Partial<AgentConfig> & { keepAlive?: boolean }
    const dangerouslySkipPermissions = parsed.dangerouslySkipPermissions ?? true
    const autoStart = parsed.autoStart ?? true
    const closeStopsDaemon = parsed.closeStopsDaemon ?? false
    const provider: AgentProviderKind = parsed.provider === 'codex' ? 'codex' : 'claude'
    // Preserve `model` for both providers. Pre-2026-05-08 only codex
    // honored it; claude inherited the spawned CLI's default which read
    // `~/.claude/.claude.json` and broke daemons whenever the user's
    // interactive alias was something the SDK subprocess couldn't resolve
    // (e.g. fast-mode `opus[1m]` returning 404 from 2.1.133).
    return parsed.model
      ? { provider, model: parsed.model, dangerouslySkipPermissions, autoStart, closeStopsDaemon }
      : { provider, dangerouslySkipPermissions, autoStart, closeStopsDaemon }
  } catch {
    return { provider: 'claude', dangerouslySkipPermissions: true, autoStart: true, closeStopsDaemon: false }
  }
}

export function saveAgentConfig(stateDir: string, config: AgentConfig): void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const file = join(stateDir, CONFIG_FILE)
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, file)
}
