#!/usr/bin/env bun
if (!process.env.CLAUDE_CODE_ENTRYPOINT) { process.env.CLAUDE_CODE_ENTRYPOINT = 'sdk-ts' }
import { join } from 'node:path'
import { homedir } from 'node:os'
import { acquireInstanceLock, releaseInstanceLock, isHeartbeatFresh, writeHeartbeat, HEARTBEAT_FILE } from './single-instance'
import { openDb } from '../lib/db'
import { LifecycleSet, wireRef } from '../lib/lifecycle'
import { log } from '../lib/log'
import { dedupeAccountsByUserId } from '../lib/dedupe-accounts'
import { loadAccess, AccessConfigCorruptError } from '../lib/access'
import { buildBootstrap } from './bootstrap'
import { makeMemoryFS } from './memory/fs-api'
import { makeConversationStore } from '../core/conversation-store'
import { makeTurnRecordStore } from '../core/turn-record-store'
import { providerDisplayName } from './provider-display-names'
import { loadAllAccounts, makeIlinkAdapter } from './ilink-glue'
import { registerInternalApi } from './internal-api/lifecycle'
import { registerCompanionPush, registerCompanionIntrospect } from './companion/lifecycle'
import { registerGuard } from './guard/lifecycle'
import { registerPolling } from './polling-lifecycle'
import { registerSessions } from './sessions-lifecycle'
import { registerIlink } from './ilink-lifecycle'
import { buildInboundPipeline } from './inbound/build'
import { runStartupSweeps } from './startup-sweeps'
import { wireMain } from './wiring'
import type { TickBodies } from './wiring/tick-bodies'

function errorDetails(err: unknown): string {
  if (err instanceof Error) return err.stack || err.message
  try { return JSON.stringify(err) } catch { return String(err) }
}

export interface BootDaemonOpts {
  stateDir: string
  dangerously: boolean
  /**
   * Eval-harness override — when set, both companion schedulers use this
   * interval (ms) instead of the production defaults. Eval harness passes
   * `1_000_000_000` (≈11.5 days; jitter-safe under setTimeout's int32 cap)
   * to suppress auto-fire so the engine drives ticks with fireTick().
   * Production callers (cli `run`, signal handlers) never set this.
   */
  schedulerIntervalMs?: number
}
export interface DaemonHandle {
  shutdown(): Promise<void>
  pollingReconcile?(): Promise<void>
  /**
   * Eval-harness seam — manually fire one tick of the named kind, with the
   * given virtual timestamp baked into the envelope. Bypasses the scheduler
   * gates (shouldRun + jitter). Returns when the tick body completes.
   *
   * Production callers never use this; production uses the periodic scheduler
   * registered via registerCompanionPush / registerCompanionIntrospect.
   */
  fireTick(kind: 'push' | 'introspect', at: Date): Promise<void>
}

export async function bootDaemon(opts: BootDaemonOpts): Promise<DaemonHandle> {
  const { stateDir, dangerously } = opts
  const PID_PATH = join(stateDir, 'server.pid')
  const HEARTBEAT_PATH = join(stateDir, HEARTBEAT_FILE)
  // Health-aware lock: refuse only if the existing holder is alive AND its
  // heartbeat is fresh (it's actually serving). A wedged/half-started daemon
  // — the desktop-launchd "holds the pidfile but never replies" case — lets
  // its heartbeat go stale, so we take the lock over instead of forcing the
  // user to kill it by hand. A holder with no heartbeat file (predates this,
  // or just started) is treated as fresh, so we never steal an unproven lock.
  const lock = acquireInstanceLock(PID_PATH, { isHealthy: () => isHeartbeatFresh(HEARTBEAT_PATH) })
  if (!lock.ok) throw new Error(`[wechat-cc] ${lock.reason} (pid=${lock.pid})`)
  // Stamp an initial heartbeat immediately so this just-started daemon reads
  // as healthy before its first poll cycle lands (the poll loop refreshes it
  // on every round-trip thereafter — see lifecycle-deps onPollCycle).
  writeHeartbeat(HEARTBEAT_PATH)
  // v0.5.6: collapse duplicate ilink bot bindings to one per wechat userId
  // BEFORE loading accounts. ilink only allows one active bot per user — when
  // the user re-scans, the old bot's session is invalidated server-side. The
  // dedupe archives stale dirs to `<botId>.superseded.<iso>` and loadAllAccounts
  // skips that infix. Idempotent on already-clean state.
  dedupeAccountsByUserId(join(stateDir, 'accounts'), {}, { log: (t, l) => log(t, l) })
  // Validate access.json eagerly. If the file is unparseable we refuse
  // to boot — preserves the prior process.exit(1) behavior from
  // readAccessFile, but now goes through the typed exception so tests
  // can catch it instead of needing process.exit interception.
  try { loadAccess() }
  catch (err) {
    if (err instanceof AccessConfigCorruptError) {
      releaseInstanceLock(PID_PATH)
      process.stderr.write(`wechat channel: FATAL ${err.message}\n`)
      process.exit(1)
    }
    throw err
  }
  const accounts = await loadAllAccounts(stateDir)
  if (accounts.length === 0) { releaseInstanceLock(PID_PATH); throw new Error('[wechat-cc] no accounts bound. Run `wechat-cc setup` first.') }
  const db = openDb({ path: join(stateDir, 'wechat-cc.db') })
  // Per-turn observability store — written by the coordinator's recordTurn
  // (via bootstrap onTurnRecord) and read by internal-api GET /v1/turns.
  // Created here so both the internal-api registration and bootstrap below
  // share the one instance.
  const turnRecordStore = makeTurnRecordStore(db)
  // ConversationStore must be constructed BEFORE the ilink adapter —
  // PR5 Task 21 routes the adapter's setUserName/resolveUserName through
  // it, replacing the deprecated user_names.json store. Both legacy
  // conversations.json and user_names.json are backfilled here on first
  // boot and renamed to *.migrated when done.
  const conversationStore = makeConversationStore(db, {
    migrateFromFile: join(stateDir, 'conversations.json'),
    migrateFromUserNamesFile: join(stateDir, 'user_names.json'),
  })
  const ilink = makeIlinkAdapter({ stateDir, accounts, db, conversationStore })
  const memoryFS = makeMemoryFS({ rootDir: join(stateDir, 'memory') })
  const lc = new LifecycleSet((tag, line) => log(tag, line))
  let shuttingDown = false; let didStartup = false
  let pollingLcRef: { reconcile(): Promise<void> } | null = null
  let ticksRef: TickBodies | null = null
  let bootRef: import('./bootstrap').Bootstrap | null = null

  const shutdown = async () => {
    if (shuttingDown) return
    shuttingDown = true; log('DAEMON', 'shutdown initiated')
    if (didStartup) { try { await lc.stopAll() } catch { /* logged by lc */ } }
    // Stop A2A server if it was started (a2a_listen was configured).
    try { await bootRef?.a2aServer?.stop() } catch (err) { log('A2A', `server stop error: ${err instanceof Error ? err.message : String(err)}`) }
    try { db.close() } catch (err) { console.error('db close failed:', err) }
    releaseInstanceLock(PID_PATH)
  }

  try {
    // 1. internal-api FIRST — bootstrap needs its baseUrl/token for MCP wiring
    const internalApi = await registerInternalApi({
      stateDir, daemonPid: process.pid, memory: memoryFS, db, projects: ilink.projects,
      setUserName: (chatId, name) => ilink.setUserName(chatId, name),
      voice: { replyVoice: (c, t) => ilink.voice.replyVoice(c, t), saveConfig: (i) => ilink.voice.saveConfig(i), configStatus: () => ilink.voice.configStatus() },
      sharePage: (t, c, o) => ilink.sharePage(t, c, o), resurfacePage: (q) => ilink.resurfacePage(q),
      companion: { enable: () => ilink.companion.enable(), disable: () => ilink.companion.disable(), status: () => ilink.companion.status(), snooze: (m) => ilink.companion.snooze(m) },
      ilink: { sendReply: (c, t) => ilink.sendMessage(c, t).then(r => r as { msgId: string; error?: string }), sendFile: (c, p) => ilink.sendFile(c, p), editMessage: (c, m, t) => ilink.editMessage(c, m, t), broadcast: (t, a) => ilink.broadcast(t, a) },
      prefix: { conversationStore, providerDisplayName, permissionMode: dangerously ? 'dangerously' as const : 'strict' as const },
      turns: turnRecordStore,
      // Live-session lister + heartbeat probe back the admin self-diagnosis
      // tools (GET /v1/sessions, ops fields in /v1/health). listSessions is a
      // thunk over bootRef because SessionManager is built by bootstrap below
      // (after this registration) — returns null until then, so the route 503s.
      listSessions: () => bootRef?.sessionManager?.list() ?? null,
      heartbeatFresh: () => isHeartbeatFresh(HEARTBEAT_PATH),
      log: (t, l) => log(t, l),
    })
    lc.register(internalApi)
    // 2. bootstrap composes provider registry / session manager / coordinator
    const boot = await buildBootstrap({
      stateDir, db, ilink, loadProjects: ilink.loadProjects,
      lastActiveChatId: ilink.lastActiveChatId, log: (t, l, f) => log(t, l, f),
      fallbackProject: () => ({ alias: '_default', path: process.cwd() }),
      dangerouslySkipPermissions: dangerously, conversationStore,
      onTurnRecord: (r) => turnRecordStore.append(r),
      internalApi: { baseUrl: internalApi.baseUrl, tokenFilePath: internalApi.tokenFilePath },
    })
    bootRef = boot
    internalApi.setDelegate({ dispatchOneShot: boot.dispatchDelegate, knownPeers: () => boot.registry.list() })
    // Wire conversation dep now that coordinator is available. Routes access
    // deps.conversation at request time, so this late assignment is safe.
    internalApi.setConversation({ setMode: (chatId, mode) => boot.coordinator.setMode(chatId, mode) })
    // Wire A2A deps — registry, client, recordEvent — so POST /v1/a2a/send works.
    internalApi.setA2A(boot.a2aDeps)
    // 3. main-wiring builds all deps for pipeline + lifecycles
    const wired = wireMain({
      stateDir, db, ilink, accounts, boot, dangerously,
      // Task 11 — tick-bodies pass this to resolveTier() when computing
      // the companion's tierProfile. Same singleton import the bootstrap
      // coordinator uses; 5s TTL cache inside `loadAccess` keeps the
      // per-tick lookup cheap.
      loadAccess,
      log: (t, l) => log(t, l),
      schedulerIntervalMs: opts.schedulerIntervalMs,
    })
    ticksRef = wired.ticks
    const pipeline = buildInboundPipeline(wired.pipelineDeps)
    wireRef(wired.refs.pipeline, pipeline)
    // 4. register lifecycles (LIFO stop = startup order reversed)
    lc.register(registerCompanionPush(wired.companionPushDeps))
    lc.register(registerCompanionIntrospect(wired.companionIntrospectDeps))
    const guardLc = registerGuard(wired.guardDeps); wireRef(wired.refs.guard, guardLc); lc.register(guardLc)
    lc.register(registerSessions(wired.sessionsDeps))
    lc.register(registerIlink(wired.ilinkDeps))
    const pollingLc = registerPolling({ ...wired.pollingDeps, runPipeline: pipeline })
    wireRef(wired.refs.polling, pollingLc); lc.register(pollingLc); pollingLcRef = pollingLc
    // 5. one-shot startup sweeps — fire-and-forget
    runStartupSweeps(wired.startupDeps)
    const modeStr = dangerously ? 'mode=dangerouslySkipPermissions=true (no WeChat permission prompts will fire)' : 'mode=strict (Phase 1 permission relay active)'
    log('DAEMON', `started pid=${process.pid} accounts=${accounts.length} ${modeStr}`)
    if (dangerously) log('DAEMON', 'warning: Claude will still confirm destructive ops via natural-language reply, but no permission prompts will appear.')
    didStartup = true
  } catch (err) {
    log('DAEMON', `startup failed mid-init: ${err instanceof Error ? err.message : String(err)}`)
    await shutdown(); throw err
  }

  return {
    shutdown,
    pollingReconcile: pollingLcRef ? () => pollingLcRef!.reconcile() : undefined,
    fireTick: async (kind, at) => {
      const nowIso = at.toISOString()
      if (kind === 'push') await ticksRef!.pushTick({ nowIso })
      else await ticksRef!.introspectTick({ nowIso })
    },
  }
}

// CLI entry — sets up signal handlers, calls bootDaemon, waits. Exported so
// cli.ts's `run` command can call it explicitly. Previously cli.ts relied on
// `await import('./src/daemon/main.ts')` triggering a top-level main() via
// side-effect, but that broke the moment we added the e2e bootDaemon export
// and gated the side-effect on `import.meta.main` — when cli.ts imports this
// module, import.meta.main is false (standard ESM semantics), so no daemon
// would start. Compiled `wechat-cc-cli.exe run` would silently no-op.
export async function main() {
  const stateDir = process.env.WECHAT_CC_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'wechat')
  const dangerously = process.argv.includes('--dangerously')
  let handle: DaemonHandle
  try { handle = await bootDaemon({ stateDir, dangerously }) } catch (err) { console.error('[wechat-cc] fatal:', err); process.exit(1) }
  process.on('beforeExit', (code) => log('DAEMON', `beforeExit code=${code}`))
  process.on('exit', (code) => log('DAEMON', `exit code=${code}`))
  process.on('uncaughtException', (err) => {
    log('DAEMON', `uncaughtException: ${errorDetails(err)}`)
    process.exit(1)
  })
  process.on('unhandledRejection', (reason) => {
    log('DAEMON', `unhandledRejection: ${errorDetails(reason)}`)
    process.exit(1)
  })
  let alreadyShuttingDown = false
  const cliShutdown = async (sig: string) => {
    if (alreadyShuttingDown) { log('DAEMON', `${sig} during shutdown — forcing exit`); process.exit(130) }
    alreadyShuttingDown = true; log('DAEMON', `${sig} received, shutting down`)
    await handle.shutdown(); process.exit(0)
  }
  process.on('SIGINT', () => void cliShutdown('SIGINT'))
  process.on('SIGTERM', () => void cliShutdown('SIGTERM'))
  process.on('SIGUSR1', () => { handle.pollingReconcile?.()?.catch(err => log('RECONCILE', `SIGUSR1 reconcile failed: ${err instanceof Error ? err.message : String(err)}`)) })
  // SIGUSR2 — fire a companion push tick now (instead of waiting for the ~20min
  // scheduler). Sent by `wechat-cc companion push`. See cli/companion-push.ts.
  process.on('SIGUSR2', () => {
    log('SCHED', 'SIGUSR2 — manual push tick requested')
    handle.fireTick('push', new Date()).catch(err => log('SCHED', `SIGUSR2 push tick failed: ${err instanceof Error ? err.message : String(err)}`))
  })
}

// Direct invocation: `bun src/daemon/main.ts` (dev mode). In compiled binaries
// the entry is cli.ts, which imports + calls main() explicitly, so this guard
// only matters for source-mode dev runs.
if (import.meta.main) {
  main().catch((err) => { console.error('[wechat-cc] fatal:', err); process.exit(1) })
}
