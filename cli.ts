#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { STATE_DIR } from './config'
import { loadAgentConfig, saveAgentConfig, type AgentProviderKind } from './agent-config'
import { analyzeDoctor, defaultDoctorDeps, printDoctor, serviceStatus, setupStatus } from './doctor'
import { buildServicePlan, installService, startService, stopService, uninstallService } from './service-manager'

export type CliArgs =
  | { cmd: 'run'; dangerouslySkipPermissions: boolean }
  | { cmd: 'setup'; qrJson?: boolean }
  | { cmd: 'setup-poll'; qrcode: string; baseUrl?: string; json: boolean }
  | { cmd: 'install'; userScope: boolean }
  | { cmd: 'status' }
  | { cmd: 'list' }
  | { cmd: 'doctor'; json: boolean }
  | { cmd: 'setup-status'; json: boolean }
  | { cmd: 'service'; action: 'status' | 'install' | 'start' | 'stop' | 'uninstall'; json: boolean; unattended?: boolean }
  | { cmd: 'provider-set'; provider: AgentProviderKind; model?: string; unattended?: boolean }
  | { cmd: 'provider-show'; json: boolean }
  | { cmd: 'help' }

export function parseCliArgs(argv: string[], opts?: { warn?: (m: string) => void }): CliArgs {
  const warn = opts?.warn ?? ((m: string) => console.warn(m))
  const [cmd, ...rest] = argv
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') return { cmd: 'help' }
  switch (cmd) {
    case 'run': {
      let dangerouslySkipPermissions = false
      for (const a of rest) {
        if (a === '--dangerously') {
          dangerouslySkipPermissions = true
        } else if (a === '--fresh' || a === '--continue' || a === '--channels' || a.startsWith('--mcp-config')) {
          warn(`[wechat-cc] legacy flag ignored: ${a} (v1.0+ daemon doesn't spawn claude directly)`)
        }
      }
      return { cmd: 'run', dangerouslySkipPermissions }
    }
    case 'setup': return rest.includes('--qr-json') ? { cmd: 'setup', qrJson: true } : { cmd: 'setup' }
    case 'setup-poll': {
      const qrcodeIdx = rest.indexOf('--qrcode')
      const qrcode = qrcodeIdx >= 0 ? rest[qrcodeIdx + 1] : undefined
      if (!qrcode) return { cmd: 'help' }
      const baseUrlIdx = rest.indexOf('--base-url')
      const baseUrl = baseUrlIdx >= 0 ? rest[baseUrlIdx + 1] : undefined
      return baseUrl
        ? { cmd: 'setup-poll', qrcode, baseUrl, json: rest.includes('--json') }
        : { cmd: 'setup-poll', qrcode, json: rest.includes('--json') }
    }
    case 'install': return { cmd: 'install', userScope: rest.includes('--user') }
    case 'status': return { cmd: 'status' }
    case 'list': return { cmd: 'list' }
    case 'doctor': return { cmd: 'doctor', json: rest.includes('--json') }
    case 'setup-status': return { cmd: 'setup-status', json: rest.includes('--json') }
    case 'service': {
      if (rest[0] === 'status' || rest[0] === 'install' || rest[0] === 'start' || rest[0] === 'stop' || rest[0] === 'uninstall') {
        return { cmd: 'service', action: rest[0], json: rest.includes('--json'), unattended: parseBoolFlag(rest, '--unattended') }
      }
      return { cmd: 'help' }
    }
    case 'provider': {
      if (rest[0] === 'show') return { cmd: 'provider-show', json: rest.includes('--json') }
      if (rest[0] === 'set' && (rest[1] === 'claude' || rest[1] === 'codex')) {
        const modelIdx = rest.indexOf('--model')
        const model = modelIdx >= 0 ? rest[modelIdx + 1] : undefined
        const unattended = parseBoolFlag(rest, '--unattended')
        const base: { cmd: 'provider-set'; provider: AgentProviderKind; model?: string; unattended?: boolean } = { cmd: 'provider-set', provider: rest[1] }
        if (model) base.model = model
        if (unattended !== undefined) base.unattended = unattended
        return base
      }
      return { cmd: 'help' }
    }
    default: return { cmd: 'help' }
  }
}

function parseBoolFlag(args: string[], name: string): boolean | undefined {
  const idx = args.indexOf(name)
  if (idx < 0) return undefined
  const value = args[idx + 1]
  if (value === 'true' || value === '1' || value === 'yes' || value === 'on') return true
  if (value === 'false' || value === '0' || value === 'no' || value === 'off') return false
  // Bare flag (no value following) means true.
  if (value === undefined || value.startsWith('--')) return true
  return undefined
}

const HELP_TEXT = `wechat-cc — WeChat bridge for Claude Code (Agent SDK daemon)

Usage:
  wechat-cc setup [--qr-json] Scan QR + bind a WeChat bot
  wechat-cc setup-poll --qrcode TOKEN [--base-url URL] [--json]
  wechat-cc run [--dangerously]   Start the daemon (foreground)
                        --dangerously: skip permission prompts
                        (matches claude --dangerously-skip-permissions)
  wechat-cc install [--user]   Register the MCP plugin entry for claude
  wechat-cc status      Show daemon status + accounts
  wechat-cc list        List bound accounts
  wechat-cc doctor [--json]        Diagnose install/setup state
  wechat-cc setup-status [--json]  Machine-readable setup status for desktop UI
  wechat-cc service <status|install|start|stop|uninstall> [--json] [--unattended true|false]
                        --unattended: persist into agent-config and re-write plist.
                                      Idempotent: install replaces any existing daemon.
  wechat-cc provider show [--json]  Show selected agent provider
  wechat-cc provider set <claude|codex> [--model MODEL] [--unattended true|false]
                        --unattended: when true (default for new installs), the
                          installed daemon runs the daemon with --dangerously so
                          inbound WeChat messages don't hang waiting for human
                          permission prompts. Set false for interactive mode.

Notes for 0.x users:
  * The old --fresh / --continue flags are ignored; --dangerously is restored.
    v1.0 uses @anthropic-ai/claude-agent-sdk; daemon manages claude
    subprocesses internally, per-project session pool.
  * /restart from WeChat is removed. Use /project switch or restart
    the daemon process.
`

async function main() {
  const parsed = parseCliArgs(process.argv.slice(2))
  const here = dirname(fileURLToPath(import.meta.url))
  switch (parsed.cmd) {
    case 'run': {
      const daemonPath = join(here, 'src', 'daemon', 'main.ts')
      const args = parsed.dangerouslySkipPermissions ? [daemonPath, '--dangerously'] : [daemonPath]
      const r = spawnSync(process.execPath, args, { stdio: 'inherit' })
      process.exit(r.status ?? 1)
    }
    case 'setup': {
      if (parsed.qrJson) {
        const { requestSetupQrCode } = await import('./setup-flow.ts')
        console.log(JSON.stringify(await requestSetupQrCode(), null, 2))
        return
      }
      const setupPath = join(here, 'setup.ts')
      const r = spawnSync(process.execPath, [setupPath], { stdio: 'inherit' })
      process.exit(r.status ?? 1)
    }
    case 'setup-poll': {
      const { pollSetupQrStatus } = await import('./setup-flow.ts')
      const result = await pollSetupQrStatus({ qrcode: parsed.qrcode, baseUrl: parsed.baseUrl, stateDir: STATE_DIR })
      if (parsed.json) console.log(JSON.stringify(result, null, 2))
      else console.log(result.status)
      return
    }
    case 'install': {
      const { installUserMcp } = await import('./install-user-mcp.ts')
      const { join: pathJoin } = await import('node:path')
      const { homedir } = await import('node:os')
      if (parsed.userScope) {
        const configFile = pathJoin(homedir(), '.claude.json')
        installUserMcp(configFile, 'wechat', {
          command: process.execPath,
          args: ['run', '--cwd', here, '--silent', 'start'],
        })
        console.log(`Updated user-scope MCP config: ${configFile}`)
        console.log('\nNext: wechat-cc run or start claude in any project')
      } else {
        console.log('Project-scope install: run `wechat-cc install --user` to register globally,')
        console.log('or manually add the wechat entry to your project .mcp.json.')
      }
      return
    }
    case 'status': case 'list': {
      const { runStatus } = await import('./cli-status.ts')
      await runStatus(parsed.cmd)
      return
    }
    case 'doctor': {
      const report = analyzeDoctor(defaultDoctorDeps())
      if (parsed.json) console.log(JSON.stringify(report, null, 2))
      else printDoctor(report)
      return
    }
    case 'setup-status': {
      const deps = defaultDoctorDeps()
      const status = setupStatus(deps)
      if (parsed.json) console.log(JSON.stringify(status, null, 2))
      else console.log(status.bound ? 'wechat: bound' : 'wechat: not bound')
      return
    }
    case 'service': {
      // If the caller passed --unattended, persist it into agent-config first
      // so this is the source of truth (re-installs from the GUI re-pick the same value).
      if (parsed.unattended !== undefined) {
        const existing = loadAgentConfig(STATE_DIR)
        saveAgentConfig(STATE_DIR, { ...existing, dangerouslySkipPermissions: parsed.unattended })
      }
      const config = loadAgentConfig(STATE_DIR)
      const plan = buildServicePlan({ cwd: here, dangerouslySkipPermissions: config.dangerouslySkipPermissions })
      if (parsed.action === 'status') {
        const status = serviceStatus(defaultDoctorDeps())
        if (parsed.json) console.log(JSON.stringify({ ...status, plan, agentConfig: config }, null, 2))
        else console.log(`service: ${status.state}${status.pid ? ` pid=${status.pid}` : ''}`)
        return
      }
      // WECHAT_CC_DRY_RUN=1 makes install/uninstall/start/stop a no-op (still
      // returns the plan in JSON). Used by the apps/desktop e2e shim so tests
      // exercise real cli.ts without touching ~/Library/LaunchAgents/launchd.
      const dryRun = process.env.WECHAT_CC_DRY_RUN === '1'
      const sideOpts = { dryRun }
      if (parsed.action === 'install') {
        // Idempotent: best-effort tear down any previous install so we can
        // re-write the plist (e.g. unattended toggle changed). Swallow errors
        // — a partial/stale state (plist missing, launchd doesn't have it)
        // would otherwise block the fresh install.
        try { uninstallService(plan, sideOpts) } catch { /* tolerate */ }
        installService(plan, sideOpts)
      } else if (parsed.action === 'start') startService(plan, sideOpts)
      else if (parsed.action === 'stop') stopService(plan, sideOpts)
      else if (parsed.action === 'uninstall') uninstallService(plan, sideOpts)
      const out = { ok: true, action: parsed.action, plan, agentConfig: config, dryRun }
      if (parsed.json) console.log(JSON.stringify(out, null, 2))
      else console.log(`service ${parsed.action}: ok${dryRun ? ' (dry-run)' : ''}`)
      return
    }
    case 'provider-show': {
      const config = loadAgentConfig(STATE_DIR)
      if (parsed.json) console.log(JSON.stringify(config, null, 2))
      else console.log(`provider: ${config.provider}${config.model ? ` (${config.model})` : ''} unattended=${config.dangerouslySkipPermissions}`)
      return
    }
    case 'provider-set': {
      const existing = loadAgentConfig(STATE_DIR)
      const next = {
        ...existing,
        provider: parsed.provider,
        ...(parsed.model !== undefined ? { model: parsed.model } : {}),
        ...(parsed.unattended !== undefined ? { dangerouslySkipPermissions: parsed.unattended } : {}),
      }
      // When switching provider, drop a stale model from the previous provider
      // unless the caller explicitly set one.
      if (existing.provider !== parsed.provider && parsed.model === undefined) {
        delete (next as Partial<typeof next>).model
      }
      saveAgentConfig(STATE_DIR, next)
      console.log(`provider set: ${next.provider}${next.model ? ` (${next.model})` : ''} unattended=${next.dangerouslySkipPermissions}`)
      return
    }
    case 'help': {
      console.log(HELP_TEXT)
      return
    }
  }
}

if (import.meta.main) {
  main().catch((e) => { console.error(e); process.exit(1) })
}
