import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { STATE_DIR } from './config'
import { findOnPath } from './util'
import { loadAgentConfig, type AgentConfig } from './agent-config'

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

export interface DoctorDeps {
  stateDir: string
  findOnPath: (cmd: string) => string | null
  readAccounts: () => BoundAccount[]
  readAccess: () => AccessSnapshot
  readAgentConfig: () => AgentConfig
  daemon: () => DaemonSnapshot
}

export interface DoctorReport {
  ready: boolean
  stateDir: string
  checks: {
    bun: { ok: boolean; path: string | null }
    git: { ok: boolean; path: string | null }
    claude: { ok: boolean; path: string | null }
    codex: { ok: boolean; path: string | null }
    accounts: { ok: boolean; count: number; items: BoundAccount[] }
    access: { ok: boolean; dmPolicy: string; allowFromCount: number }
    provider: { ok: boolean; provider: AgentConfig['provider']; model?: string; binaryPath: string | null }
    daemon: DaemonSnapshot
  }
  nextActions: string[]
}

export function analyzeDoctor(deps: DoctorDeps): DoctorReport {
  const bun = deps.findOnPath('bun')
  const git = deps.findOnPath('git')
  const claude = deps.findOnPath('claude')
  const codex = deps.findOnPath('codex')
  const accounts = deps.readAccounts()
  const access = deps.readAccess()
  const agent = deps.readAgentConfig()
  const daemon = deps.daemon()
  const providerBinary = agent.provider === 'codex' ? codex : claude

  const nextActions: string[] = []
  if (!bun) nextActions.push('install_bun')
  if (!git) nextActions.push('install_git')
  if (!providerBinary) nextActions.push(agent.provider === 'codex' ? 'install_codex' : 'install_claude')
  if (accounts.length === 0) nextActions.push('run_wechat_setup')
  if (accounts.length > 0 && access.allowFrom.length === 0) nextActions.push('fix_access_allowlist')
  if (!daemon.alive) nextActions.push('start_service')

  const checks = {
    bun: { ok: !!bun, path: bun },
    git: { ok: !!git, path: git },
    claude: { ok: !!claude, path: claude },
    codex: { ok: !!codex, path: codex },
    accounts: { ok: accounts.length > 0, count: accounts.length, items: accounts },
    access: {
      ok: access.dmPolicy === 'allowlist' && access.allowFrom.length > 0,
      dmPolicy: access.dmPolicy,
      allowFromCount: access.allowFrom.length,
    },
    provider: {
      ok: !!providerBinary,
      provider: agent.provider,
      ...(agent.model ? { model: agent.model } : {}),
      binaryPath: providerBinary,
    },
    daemon,
  }

  return {
    ready: checks.bun.ok
      && checks.git.ok
      && checks.accounts.ok
      && checks.access.ok
      && checks.provider.ok
      && daemon.alive,
    stateDir: deps.stateDir,
    checks,
    nextActions,
  }
}

export function setupStatus(deps: Pick<DoctorDeps, 'stateDir' | 'readAccounts' | 'readAccess' | 'readAgentConfig' | 'daemon'>) {
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
  }
}

export function serviceStatus(deps: { daemon: () => DaemonSnapshot }) {
  const daemon = deps.daemon()
  return {
    installed: daemon.alive,
    alive: daemon.alive,
    pid: daemon.pid,
    state: daemon.alive ? 'running' : daemon.pid !== null ? 'stale' : 'stopped',
  }
}

export function defaultDoctorDeps(stateDir = STATE_DIR): DoctorDeps {
  return {
    stateDir,
    findOnPath,
    readAccounts: () => readAccounts(stateDir),
    readAccess: () => readAccess(stateDir),
    readAgentConfig: () => loadAgentConfig(stateDir),
    daemon: () => readDaemon(stateDir),
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
  console.log(`state: ${report.stateDir}`)
  console.log(`bun: ${fmt(report.checks.bun)}`)
  console.log(`git: ${fmt(report.checks.git)}`)
  console.log(`claude: ${fmt(report.checks.claude)}`)
  console.log(`codex: ${fmt(report.checks.codex)}`)
  console.log(`provider: ${report.checks.provider.provider}${report.checks.provider.model ? ` (${report.checks.provider.model})` : ''}`)
  console.log(`accounts: ${report.checks.accounts.count}`)
  console.log(`access: ${report.checks.access.dmPolicy}, allowed=${report.checks.access.allowFromCount}`)
  console.log(`daemon: ${report.checks.daemon.alive ? `running pid=${report.checks.daemon.pid}` : report.checks.daemon.pid ? `stale pid=${report.checks.daemon.pid}` : 'stopped'}`)
  if (report.nextActions.length) console.log(`next: ${report.nextActions.join(', ')}`)
}

function fmt(c: { ok: boolean; path: string | null }): string {
  return c.ok ? `ok (${c.path})` : 'missing'
}
