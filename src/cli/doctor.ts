import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { platform as osPlatform } from 'node:os'
import { STATE_DIR } from '../lib/config'
import { findOnPath } from '../lib/util'
import { loadAgentConfig, type AgentConfig } from '../lib/agent-config'
import { buildServicePlan, isServiceInstalled, type ServiceKind } from './service-manager'
import { compiledBinaryPath, compiledRepoRoot, isCompiledBundle } from '../lib/runtime-info'

export interface BoundAccount {
  id: string
  botId: string
  userId: string
  baseUrl: string
}

export interface AccessSnapshot {
  dmPolicy: 'allowlist' | 'disabled'
  allowFrom: string[]
}

export interface DaemonSnapshot {
  alive: boolean
  pid: number | null
}

export interface ExpiredBotEntry {
  botId: string
  firstSeenExpiredAt: string
  lastReason?: string
}

export interface ServiceSnapshot {
  installed: boolean
  kind: ServiceKind
}

export type Runtime = 'compiled-bundle' | 'source'

export interface DoctorDeps {
  stateDir: string
  findOnPath: (cmd: string) => string | null
  readAccounts: () => BoundAccount[]
  readAccess: () => AccessSnapshot
  readAgentConfig: () => AgentConfig
  readUserNames: () => Record<string, string>
  readExpiredBots: () => ExpiredBotEntry[]
  daemon: () => DaemonSnapshot
  service: () => ServiceSnapshot
  // 'compiled-bundle' = the bun-compiled wechat-cc-cli sidecar inside the
  // Tauri desktop bundle. In that mode the CLI carries its own bun runtime
  // and never touches the source tree — so a missing system `bun` or `git`
  // doesn't actually block anything end-user-facing. 'source' = `bun cli.ts`
  // ran from a cloned repo, where bun + git ARE real preconditions.
  // Defaults to 'source' when omitted (back-compat with existing callers
  // and tests).
  runtime?: Runtime
  // True on Windows when the `wsl` binary is on PATH. Used by the GUI to
  // surface a "we detected WSL but currently only support Windows-native
  // Claude" hint — preempts the support question from users who run
  // Claude Code in WSL.
  platform?: NodeJS.Platform
}

export type FixHint = { command?: string; action?: string; link?: string }
export type Severity = 'hard' | 'soft'
export interface DoctorCheckBase {
  ok: boolean
  // When !ok: 'hard' = system can't function (e.g. selected agent backend
  // missing → daemon starts but every reply fails); 'soft' = degraded but
  // not catastrophic (e.g. no bound accounts → daemon idle, recoverable).
  // When ok, severity is omitted.
  severity?: Severity
  // One-line concrete fix. UI renders ONE of: command (with copy btn) /
  // action (text) / link (external). Keep copy short — no paragraphs.
  fix?: FixHint
}

export interface DoctorReport {
  ready: boolean
  stateDir: string
  // Source vs compiled-bundle. The GUI uses this to drop bun/git rows from
  // the env-check list and skip parking at the doctor step purely on bun/git
  // misses — those are source-mode developer concerns, not end-user ones.
  runtime: Runtime
  // True iff platform=win32 AND a `wsl` binary is on PATH. Drives the
  // wizard's "WSL detected" hint. We don't probe inside WSL — finding the
  // binary is enough signal to soften user expectations.
  wslDetected: boolean
  checks: {
    bun: DoctorCheckBase & { path: string | null }
    git: DoctorCheckBase & { path: string | null }
    claude: DoctorCheckBase & { path: string | null }
    codex: DoctorCheckBase & { path: string | null }
    accounts: DoctorCheckBase & { count: number; items: BoundAccount[] }
    access: DoctorCheckBase & { dmPolicy: string; allowFromCount: number }
    provider: DoctorCheckBase & { provider: AgentConfig['provider']; model?: string; binaryPath: string | null }
    daemon: DaemonSnapshot
    service: ServiceSnapshot
  }
  userNames: Record<string, string>
  expiredBots: ExpiredBotEntry[]
  nextActions: string[]
}

export function analyzeDoctor(deps: DoctorDeps): DoctorReport {
  const runtime: Runtime = deps.runtime ?? 'source'
  const isBundle = runtime === 'compiled-bundle'
  const bun = deps.findOnPath('bun')
  const git = deps.findOnPath('git')
  const claude = deps.findOnPath('claude')
  const codex = deps.findOnPath('codex')
  const accounts = deps.readAccounts()
  const access = deps.readAccess()
  const agent = deps.readAgentConfig()
  const daemon = deps.daemon()
  const service = deps.service()
  const providerBinary = agent.provider === 'codex' ? codex : claude
  // WSL is a Windows-only concept; checking findOnPath('wsl') on non-win32
  // would risk false positives (some Linux distros ship `wsl` as an unrelated
  // helper). Gate strictly on platform.
  const wslDetected = (deps.platform ?? 'linux') === 'win32' && !!deps.findOnPath('wsl')

  const nextActions: string[] = []
  // Source-mode users (running `bun cli.ts ...` from a clone) genuinely need
  // bun + git on PATH. Compiled-bundle users get them from inside the
  // sidecar — surfacing "install bun" to a .msi user is a leak of dev-mode
  // contract.
  if (!isBundle && !bun) nextActions.push('install_bun')
  if (!isBundle && !git) nextActions.push('install_git')
  if (!providerBinary) nextActions.push(agent.provider === 'codex' ? 'install_codex' : 'install_claude')
  if (accounts.length === 0) nextActions.push('run_wechat_setup')
  if (accounts.length > 0 && access.allowFrom.length === 0) nextActions.push('fix_access_allowlist')
  if (!service.installed) nextActions.push('install_service')
  else if (!daemon.alive) nextActions.push('start_service')

  // Severity rules:
  //   - selected agent backend missing → hard (daemon starts but every
  //     reply fails — the "fake success" trap)
  //   - non-selected backend missing → soft (you'd only use it after
  //     `wechat-cc provider set`, currently irrelevant)
  //   - bun/git missing in source mode → soft (CLI source needs them)
  //   - bun/git missing in compiled-bundle → ok=true, the GUI hides them
  //     entirely (sidecar carries its own bun runtime, no git operations
  //     possible against a bundle anyway)
  //   - accounts/access missing → soft (daemon runs idle, fixable any
  //     time via setup)
  const claudeIsActive = agent.provider === 'claude'
  const codexIsActive = agent.provider === 'codex'
  const checks = {
    bun: {
      // Bundle mode: report ok=true regardless of system bun, since the
      // sidecar doesn't depend on it. The GUI also filters this row by
      // `report.runtime`, so end-users never see it; ok=true is the safe
      // value if the row ever leaks through (e.g. JSON consumers).
      ok: isBundle ? true : !!bun,
      path: bun,
      ...(isBundle || bun ? {} : { severity: 'soft' as const, fix: { command: 'curl -fsSL https://bun.sh/install | bash' } }),
    },
    git: {
      ok: isBundle ? true : !!git,
      path: git,
      ...(isBundle || git ? {} : { severity: 'soft' as const }),
    },
    claude: {
      ok: !!claude, path: claude,
      ...(claude ? {} : {
        severity: (claudeIsActive ? 'hard' : 'soft') as Severity,
        fix: { command: 'npm install -g @anthropic-ai/claude-code', link: 'https://docs.claude.com/en/docs/claude-code/install' },
      }),
    },
    codex: {
      ok: !!codex, path: codex,
      ...(codex ? {} : {
        severity: (codexIsActive ? 'hard' : 'soft') as Severity,
        fix: { link: 'https://github.com/openai/codex#installation' },
      }),
    },
    accounts: {
      ok: accounts.length > 0,
      count: accounts.length,
      items: accounts,
      ...(accounts.length > 0 ? {} : {
        severity: 'soft' as const,
        fix: { action: '点上方「绑定微信」扫码' },
      }),
    },
    access: {
      ok: access.dmPolicy === 'allowlist' && access.allowFrom.length > 0,
      dmPolicy: access.dmPolicy,
      allowFromCount: access.allowFrom.length,
      ...(access.dmPolicy === 'allowlist' && access.allowFrom.length > 0 ? {} : {
        severity: 'soft' as const,
        fix: { action: '扫码绑定后会自动加入' },
      }),
    },
    provider: {
      ok: !!providerBinary,
      provider: agent.provider,
      ...(agent.model ? { model: agent.model } : {}),
      binaryPath: providerBinary,
      ...(providerBinary ? {} : {
        severity: 'hard' as const,
        fix: agent.provider === 'codex'
          ? { link: 'https://github.com/openai/codex#installation' }
          : { command: 'npm install -g @anthropic-ai/claude-code', link: 'https://docs.claude.com/en/docs/claude-code/install' },
      }),
    },
    daemon,
    service,
  }

  // ready formula: same shape source/bundle, but bun/git slots auto-eval
  // to true in bundle mode (see checks construction above), so this stays
  // the single expression of "all green."
  return {
    ready: checks.bun.ok
      && checks.git.ok
      && checks.accounts.ok
      && checks.access.ok
      && checks.provider.ok
      && daemon.alive,
    stateDir: deps.stateDir,
    runtime,
    wslDetected,
    checks,
    userNames: deps.readUserNames(),
    expiredBots: deps.readExpiredBots(),
    nextActions,
  }
}

export function setupStatus(deps: Pick<DoctorDeps, 'stateDir' | 'readAccounts' | 'readAccess' | 'readAgentConfig' | 'daemon' | 'service'>) {
  const accounts = deps.readAccounts()
  const access = deps.readAccess()
  const agent = deps.readAgentConfig()
  return {
    stateDir: deps.stateDir,
    bound: accounts.length > 0,
    accounts,
    access,
    provider: agent.provider,
    ...(agent.model ? { model: agent.model } : {}),
    daemon: deps.daemon(),
    service: deps.service(),
  }
}

export interface ServiceStatusReport {
  installed: boolean
  alive: boolean
  pid: number | null
  state: 'missing' | 'running' | 'stale' | 'stopped'
}

// Cross 4 truth states based on (installed, alive, pid):
//   missing  — service unit/plist/task not registered (ALL platforms agree)
//   running  — daemon alive (regardless of whether registered as service —
//              foreground `bun cli.ts run` still reports running here)
//   stale    — pid file exists but process dead (crashed without cleanup)
//   stopped  — service installed, no pid (ready for `service start`)
export function serviceStatus(deps: { daemon: () => DaemonSnapshot; service: () => ServiceSnapshot }): ServiceStatusReport {
  const daemon = deps.daemon()
  const service = deps.service()
  let state: ServiceStatusReport['state']
  if (daemon.alive) state = 'running'
  else if (daemon.pid !== null) state = 'stale'
  else if (service.installed) state = 'stopped'
  else state = 'missing'
  return { installed: service.installed, alive: daemon.alive, pid: daemon.pid, state }
}

export function defaultDoctorDeps(stateDir = STATE_DIR): DoctorDeps {
  return {
    stateDir,
    findOnPath,
    readAccounts: () => readAccounts(stateDir),
    readAccess: () => readAccess(stateDir),
    readAgentConfig: () => loadAgentConfig(stateDir),
    readUserNames: () => readUserNames(stateDir),
    readExpiredBots: () => readExpiredBots(stateDir),
    daemon: () => readDaemon(stateDir),
    service: () => defaultServiceSnapshot(stateDir),
    runtime: isCompiledBundle() ? 'compiled-bundle' : 'source',
    platform: osPlatform(),
  }
}

// Resolve the service plan the way cli.ts service handler does — reusing
// the compiled-mode detection so the GUI doctor agrees with what the
// install path would write. Compiled binaries: ExecStart points at the
// bundle's wechat-cc-cli, cwd = its directory. Source mode: cwd = the
// repo root containing cli.ts.
export function defaultServiceSnapshot(stateDir: string): ServiceSnapshot {
  const repoRoot = compiledRepoRoot() ?? dirname(fileURLToPath(import.meta.url))
  const binaryPath = compiledBinaryPath() ?? undefined
  const config = loadAgentConfig(stateDir)
  const plan = buildServicePlan({
    cwd: repoRoot,
    dangerouslySkipPermissions: config.dangerouslySkipPermissions,
    autoStart: config.autoStart,
    ...(binaryPath ? { binaryPath } : {}),
  })
  return { installed: isServiceInstalled(plan), kind: plan.kind }
}

export function readExpiredBots(stateDir: string): ExpiredBotEntry[] {
  try {
    const parsed = JSON.parse(readFileSync(join(stateDir, 'session-state.json'), 'utf8')) as {
      bots?: Record<string, { status?: string; first_seen_expired_at?: string; last_reason?: string }>
    }
    if (!parsed.bots) return []
    const out: ExpiredBotEntry[] = []
    for (const [botId, entry] of Object.entries(parsed.bots)) {
      if (entry?.status !== 'expired' || typeof entry.first_seen_expired_at !== 'string') continue
      out.push({
        botId,
        firstSeenExpiredAt: entry.first_seen_expired_at,
        ...(typeof entry.last_reason === 'string' ? { lastReason: entry.last_reason } : {}),
      })
    }
    out.sort((a, b) => a.firstSeenExpiredAt.localeCompare(b.firstSeenExpiredAt))
    return out
  } catch {
    return []
  }
}

export function readUserNames(stateDir: string): Record<string, string> {
  try {
    const parsed = JSON.parse(readFileSync(join(stateDir, 'user_names.json'), 'utf8')) as Record<string, unknown>
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string') out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

export function readAccounts(stateDir: string): BoundAccount[] {
  const dir = join(stateDir, 'accounts')
  if (!existsSync(dir)) return []
  const out: BoundAccount[] = []
  for (const id of safeReaddir(dir)) {
    try {
      const account = JSON.parse(readFileSync(join(dir, id, 'account.json'), 'utf8')) as {
        botId?: string
        userId?: string
        baseUrl?: string
      }
      out.push({
        id,
        botId: account.botId ?? id,
        userId: account.userId ?? '',
        baseUrl: account.baseUrl ?? '',
      })
    } catch {}
  }
  return out
}

export function readAccess(stateDir: string): AccessSnapshot {
  try {
    const parsed = JSON.parse(readFileSync(join(stateDir, 'access.json'), 'utf8')) as Partial<AccessSnapshot>
    return {
      dmPolicy: parsed.dmPolicy === 'disabled' ? 'disabled' : 'allowlist',
      allowFrom: Array.isArray(parsed.allowFrom) ? parsed.allowFrom : [],
    }
  } catch {
    return { dmPolicy: 'allowlist', allowFrom: [] }
  }
}

export function readDaemon(stateDir: string): DaemonSnapshot {
  try {
    const pid = Number(readFileSync(join(stateDir, 'server.pid'), 'utf8').trim())
    if (!Number.isFinite(pid) || pid <= 0) return { alive: false, pid: null }
    try {
      process.kill(pid, 0)
      return { alive: true, pid }
    } catch {
      return { alive: false, pid }
    }
  } catch {
    return { alive: false, pid: null }
  }
}

function safeReaddir(path: string): string[] {
  try { return readdirSync(path) } catch { return [] }
}

export function printDoctor(report: DoctorReport): void {
  console.log(report.ready ? 'wechat-cc: ready' : 'wechat-cc: needs attention')
  console.log(`runtime: ${report.runtime}`)
  console.log(`state: ${report.stateDir}`)
  // Bundle mode owns its own bun runtime; printing "bun: ok (some path)"
  // would invite confusion ("which bun?"). Skip these two rows entirely.
  if (report.runtime === 'source') {
    console.log(`bun: ${fmt(report.checks.bun)}`)
    console.log(`git: ${fmt(report.checks.git)}`)
  }
  console.log(`claude: ${fmt(report.checks.claude)}`)
  console.log(`codex: ${fmt(report.checks.codex)}`)
  console.log(`provider: ${report.checks.provider.provider}${report.checks.provider.model ? ` (${report.checks.provider.model})` : ''}`)
  console.log(`accounts: ${report.checks.accounts.count}`)
  console.log(`access: ${report.checks.access.dmPolicy}, allowed=${report.checks.access.allowFromCount}`)
  console.log(`service: ${report.checks.service.installed ? `installed (${report.checks.service.kind})` : 'missing'}`)
  console.log(`daemon: ${report.checks.daemon.alive ? `running pid=${report.checks.daemon.pid}` : report.checks.daemon.pid ? `stale pid=${report.checks.daemon.pid}` : 'stopped'}`)
  if (report.wslDetected) console.log('wsl: detected (Windows-native Claude only — WSL integration on roadmap)')
  if (report.nextActions.length) console.log(`next: ${report.nextActions.join(', ')}`)
}

function fmt(c: { ok: boolean; path: string | null }): string {
  return c.ok ? `ok (${c.path})` : 'missing'
}
