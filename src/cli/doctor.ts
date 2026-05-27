import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { platform as osPlatform } from 'node:os'
import { createRequire } from 'node:module'
import { STATE_DIR } from '../lib/config'
import { findOnPath, probeBinaryVersion } from '../lib/util'
import { loadAgentConfig, type AgentConfig } from '../lib/agent-config'
import { buildServicePlan, isServiceInstalled, type ServiceKind } from './service-manager'
import { compiledBinaryPath, compiledRepoRoot, isCompiledBundle } from '../lib/runtime-info'
import { openWechatDb } from '../lib/db'
import { makeConversationStore } from '../core/conversation-store'

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
  /** Present only when daemon is alive and internal-api-info.json is readable. */
  internal_api?: { port: number; token_file_path: string }
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
  /**
   * Sync probe of `<path> --version` — used to surface CLI versions for
   * claude/codex in the doctor report. Returns the first non-empty stdout
   * line, or null on timeout/error/binary refuses. Optional so existing
   * callers without the probe wired continue to typecheck; defaults to a
   * null-returning stub, which leaves `version` fields as `null`. Real
   * implementation in `defaultDoctorDeps` uses `spawnSync` with a 3 s cap.
   */
  probeBinaryVersion?: (path: string) => string | null
  /**
   * Probe for the Cursor agent backend — Cursor has no PATH binary (unlike
   * claude/codex CLI), it's a Node SDK. Reports whether CURSOR_API_KEY is
   * set in the environment and whether `@cursor/sdk` resolves from
   * node_modules. Both must be true for the daemon to register the cursor
   * provider at boot (mirrors the gate in src/daemon/bootstrap/index.ts).
   * Optional so test callers can inject deterministic states; defaults to
   * a real env+resolve check in defaultDoctorDeps.
   */
  probeCursor?: () => { apiKeySet: boolean; sdkInstalled: boolean }
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
    // `version`: first line of `<binary> --version`; null when the binary
    // isn't on disk, when --version timed out, or when no probe is wired.
    // Surfaced so support flows can spot SDK↔CLI protocol mismatches
    // (see src/lib/find-codex-binary.ts for the codex 0.125/0.128 trap).
    claude: DoctorCheckBase & { path: string | null; version: string | null }
    codex: DoctorCheckBase & { path: string | null; version: string | null }
    // Cursor has no PATH binary — it's a Node SDK loaded via dynamic import
    // by the daemon's bootstrap. Both apiKeySet AND sdkInstalled must be true
    // for cursor to register (see src/daemon/bootstrap/index.ts ~L514). The
    // derived `ok` mirrors that AND so doctor's gating aligns with what the
    // boot path will actually do.
    cursor: DoctorCheckBase & { apiKeySet: boolean; sdkInstalled: boolean }
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
  const probe = deps.probeBinaryVersion ?? (() => null)
  const claudeVersion = claude ? probe(claude) : null
  const codexVersion = codex ? probe(codex) : null
  const cursorProbe = (deps.probeCursor ?? defaultProbeCursor)()
  const accounts = deps.readAccounts()
  const access = deps.readAccess()
  const agent = deps.readAgentConfig()
  const daemon = deps.daemon()
  const service = deps.service()
  // Cursor has no PATH binary — providerBinary stays null for cursor and the
  // provider check below treats SDK+key presence as the "binary" equivalent.
  const providerBinary = agent.provider === 'codex'
    ? codex
    : agent.provider === 'cursor'
      ? null
      : claude
  const claudeIsActive = agent.provider === 'claude'
  const codexIsActive = agent.provider === 'codex'
  const cursorIsActive = agent.provider === 'cursor'
  const cursorOk = cursorProbe.apiKeySet && cursorProbe.sdkInstalled
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
  // For cursor, "missing backend" = SDK/api-key absent. Existing JSON
  // consumers don't know about `install_cursor`, so reuse the same hook
  // name ('install_cursor') only when cursor is selected; claude/codex
  // continue to emit their existing action strings unchanged.
  if (!providerBinary && agent.provider !== 'cursor') {
    nextActions.push(agent.provider === 'codex' ? 'install_codex' : 'install_claude')
  } else if (agent.provider === 'cursor' && !cursorOk) {
    nextActions.push('install_cursor')
  }
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
      ok: !!claude, path: claude, version: claudeVersion,
      ...(claude ? {} : {
        severity: (claudeIsActive ? 'hard' : 'soft') as Severity,
        fix: { command: 'npm install -g @anthropic-ai/claude-code', link: 'https://docs.claude.com/en/docs/claude-code/install' },
      }),
    },
    codex: {
      ok: !!codex, path: codex, version: codexVersion,
      ...(codex ? {} : {
        severity: (codexIsActive ? 'hard' : 'soft') as Severity,
        fix: { link: 'https://github.com/openai/codex#installation' },
      }),
    },
    cursor: {
      ok: cursorOk,
      apiKeySet: cursorProbe.apiKeySet,
      sdkInstalled: cursorProbe.sdkInstalled,
      ...(cursorOk ? {} : {
        severity: (cursorIsActive ? 'hard' : 'soft') as Severity,
        // Fix hint picks the missing leg — env var or SDK install. When both
        // are missing we surface the env var first (operators reading the
        // doctor output left-to-right will fix that, then re-run to see
        // the SDK leg).
        fix: !cursorProbe.apiKeySet
          ? { action: 'export CURSOR_API_KEY=<your-key>' }
          : { command: 'bun add @cursor/sdk' },
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
      // Cursor's "backend ready" check is SDK+key, not a PATH binary —
      // fall through to cursorOk when the active provider is cursor so
      // the gate aligns with what bootstrap will register at boot.
      ok: cursorIsActive ? cursorOk : !!providerBinary,
      provider: agent.provider,
      ...(agent.model ? { model: agent.model } : {}),
      binaryPath: providerBinary,
      ...((cursorIsActive ? cursorOk : !!providerBinary) ? {} : {
        severity: 'hard' as const,
        fix: agent.provider === 'codex'
          ? { link: 'https://github.com/openai/codex#installation' }
          : agent.provider === 'cursor'
            ? (!cursorProbe.apiKeySet
                ? { action: 'export CURSOR_API_KEY=<your-key>' }
                : { command: 'bun add @cursor/sdk' })
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

/**
 * Real-environment cursor probe used by `defaultDoctorDeps`. Reports whether
 * CURSOR_API_KEY is exported and whether `@cursor/sdk` resolves from
 * node_modules — the two conditions bootstrap checks before registering the
 * cursor provider. Uses `createRequire` so resolution works both under
 * `bun cli.ts` (ESM) and the compiled-bundle sidecar.
 */
export function defaultProbeCursor(): { apiKeySet: boolean; sdkInstalled: boolean } {
  const apiKeySet = !!process.env.CURSOR_API_KEY
  let sdkInstalled = false
  try {
    createRequire(import.meta.url).resolve('@cursor/sdk')
    sdkInstalled = true
  } catch { /* @cursor/sdk not installed — operators can `bun add @cursor/sdk` */ }
  return { apiKeySet, sdkInstalled }
}

export function defaultDoctorDeps(stateDir = STATE_DIR): DoctorDeps {
  return {
    stateDir,
    findOnPath,
    probeBinaryVersion,
    probeCursor: defaultProbeCursor,
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
  // PR5 (Task 22): user_names.json was deprecated in favor of the
  // conversations table's last_user_name column (Task 21 renamed the
  // legacy file to .migrated). Source the dashboard's name lookup from
  // the same SQLite table the daemon writes to so freshly-installed
  // installations populate as soon as the first inbound message lands.
  let db: ReturnType<typeof openWechatDb> | undefined
  try {
    db = openWechatDb(stateDir)
    const store = makeConversationStore(db)
    const out: Record<string, string> = {}
    for (const chatId of Object.keys(store.all())) {
      const id = store.getIdentity(chatId)
      if (id?.last_user_name) out[chatId] = id.last_user_name
    }
    return out
  } catch {
    return {}
  } finally {
    try { db?.close() } catch { /* best-effort */ }
  }
}

export function readAccounts(stateDir: string): BoundAccount[] {
  const dir = join(stateDir, 'accounts')
  if (!existsSync(dir)) return []
  const out: BoundAccount[] = []
  for (const id of safeReaddir(dir)) {
    // v0.5.6 — skip dedupe-archived dirs (`<botId>.superseded.<iso>`).
    // The dashboard reads doctor output for the bound-accounts table,
    // so excluding here is what makes superseded bots disappear from
    // the user's view without losing the audit trail on disk.
    if (id.includes('.superseded.')) continue
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
      // Daemon is alive — try to read internal-api-info.json for health-probe
      const internal_api = readInternalApiInfo(stateDir)
      return { alive: true, pid, ...(internal_api ? { internal_api } : {}) }
    } catch {
      return { alive: false, pid }
    }
  } catch {
    return { alive: false, pid: null }
  }
}

/**
 * Read `<stateDir>/internal-api-info.json` and extract the port + token-file
 * path. Returns null if the file is absent, malformed, or missing required
 * fields — callers treat null as "info not available".
 */
function readInternalApiInfo(stateDir: string): { port: number; token_file_path: string } | null {
  try {
    const raw = readFileSync(join(stateDir, 'internal-api-info.json'), 'utf8')
    const info = JSON.parse(raw) as { baseUrl?: string; tokenFilePath?: string }
    if (typeof info.baseUrl !== 'string' || typeof info.tokenFilePath !== 'string') return null
    const match = /\:(\d+)$/.exec(info.baseUrl.replace(/\/$/, ''))
    if (!match) return null
    const port = Number(match[1])
    if (!Number.isFinite(port) || port <= 0 || port > 65535) return null
    return { port, token_file_path: info.tokenFilePath }
  } catch {
    return null
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
  console.log(`claude: ${fmtWithVersion(report.checks.claude)}`)
  console.log(`codex: ${fmtWithVersion(report.checks.codex)}`)
  console.log(`cursor: ${fmtCursor(report.checks.cursor)}`)
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

function fmtWithVersion(c: { ok: boolean; path: string | null; version: string | null }): string {
  if (!c.ok) return 'missing'
  return c.version ? `ok (${c.path}, ${c.version})` : `ok (${c.path})`
}

// Cursor's status line shows which leg is missing so operators can spot
// "API key set but SDK not installed" without parsing JSON. The 4 states
// collapse to: ok / missing api key / missing sdk / missing api key + sdk.
function fmtCursor(c: { ok: boolean; apiKeySet: boolean; sdkInstalled: boolean }): string {
  if (c.ok) return 'ok'
  const missing: string[] = []
  if (!c.apiKeySet) missing.push('api key')
  if (!c.sdkInstalled) missing.push('sdk')
  return `missing ${missing.join(' + ')}`
}
