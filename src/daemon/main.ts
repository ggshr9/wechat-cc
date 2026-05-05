#!/usr/bin/env bun
if (!process.env.CLAUDE_CODE_ENTRYPOINT) { process.env.CLAUDE_CODE_ENTRYPOINT = 'sdk-ts' }
import { join } from 'node:path'
import { homedir } from 'node:os'
import { acquireInstanceLock, releaseInstanceLock } from './single-instance'
import { openDb } from '../lib/db'
import { LifecycleSet, wireRef } from '../lib/lifecycle'
import { log } from '../lib/log'
import { buildBootstrap } from './bootstrap'
import { makeMemoryFS } from './memory/fs-api'
import { makeConversationStore } from '../core/conversation-store'
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

export interface BootDaemonOpts { stateDir: string; dangerously: boolean }
export interface DaemonHandle { shutdown(): Promise<void>; pollingReconcile?(): Promise<void> }

export async function bootDaemon(opts: BootDaemonOpts): Promise<DaemonHandle> {
  const { stateDir, dangerously } = opts
  const PID_PATH = join(stateDir, 'server.pid')
  const lock = acquireInstanceLock(PID_PATH)
  if (!lock.ok) throw new Error(`[wechat-cc] ${lock.reason} (pid=${lock.pid})`)
  const accounts = await loadAllAccounts(stateDir)
  if (accounts.length === 0) { releaseInstanceLock(PID_PATH); throw new Error('[wechat-cc] no accounts bound. Run `wechat-cc setup` first.') }
  const db = openDb({ path: join(stateDir, 'wechat-cc.db') })
  const ilink = makeIlinkAdapter({ stateDir, accounts, db })
  const memoryFS = makeMemoryFS({ rootDir: join(stateDir, 'memory') })
  const conversationStore = makeConversationStore(db, { migrateFromFile: join(stateDir, 'conversations.json') })
  const lc = new LifecycleSet((tag, line) => log(tag, line))
  let shuttingDown = false; let didStartup = false
  let pollingLcRef: { reconcile(): Promise<void> } | null = null

  const shutdown = async () => {
    if (shuttingDown) return
    shuttingDown = true; log('DAEMON', 'shutdown initiated')
    if (didStartup) { try { await lc.stopAll() } catch { /* logged by lc */ } }
    try { db.close() } catch (err) { console.error('db close failed:', err) }
    releaseInstanceLock(PID_PATH)
  }

  try {
    // 1. internal-api FIRST — bootstrap needs its baseUrl/token for MCP wiring
    const internalApi = await registerInternalApi({
      stateDir, daemonPid: process.pid, memory: memoryFS, projects: ilink.projects,
      setUserName: (chatId, name) => ilink.setUserName(chatId, name),
      voice: { replyVoice: (c, t) => ilink.voice.replyVoice(c, t), saveConfig: (i) => ilink.voice.saveConfig(i), configStatus: () => ilink.voice.configStatus() },
      sharePage: (t, c, o) => ilink.sharePage(t, c, o), resurfacePage: (q) => ilink.resurfacePage(q),
      companion: { enable: () => ilink.companion.enable(), disable: () => ilink.companion.disable(), status: () => ilink.companion.status(), snooze: (m) => ilink.companion.snooze(m) },
      ilink: { sendReply: (c, t) => ilink.sendMessage(c, t).then(r => r as { msgId: string; error?: string }), sendFile: (c, p) => ilink.sendFile(c, p), editMessage: (c, m, t) => ilink.editMessage(c, m, t), broadcast: (t, a) => ilink.broadcast(t, a) },
      prefix: { conversationStore, providerDisplayName, permissionMode: dangerously ? 'dangerously' as const : 'strict' as const },
      log: (t, l) => log(t, l),
    })
    lc.register(internalApi)
    // 2. bootstrap composes provider registry / session manager / coordinator
    const boot = buildBootstrap({
      stateDir, db, ilink, loadProjects: ilink.loadProjects,
      lastActiveChatId: ilink.lastActiveChatId, log: (t, l) => log(t, l),
      fallbackProject: () => ({ alias: '_default', path: process.cwd() }),
      dangerouslySkipPermissions: dangerously, conversationStore,
      internalApi: { baseUrl: internalApi.baseUrl, tokenFilePath: internalApi.tokenFilePath },
    })
    internalApi.setDelegate({ dispatchOneShot: boot.dispatchDelegate, knownPeers: () => boot.registry.list() })
    // Wire conversation dep now that coordinator is available. Routes access
    // deps.conversation at request time, so this late assignment is safe.
    internalApi.setConversation({ setMode: (chatId, mode) => boot.coordinator.setMode(chatId, mode) })
    // 3. main-wiring builds all deps for pipeline + lifecycles
    const wired = wireMain({ stateDir, db, ilink, accounts, boot, dangerously, log: (t, l) => log(t, l) })
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

  return { shutdown, pollingReconcile: pollingLcRef ? () => pollingLcRef!.reconcile() : undefined }
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
  let alreadyShuttingDown = false
  const cliShutdown = async (sig: string) => {
    if (alreadyShuttingDown) { log('DAEMON', `${sig} during shutdown — forcing exit`); process.exit(130) }
    alreadyShuttingDown = true; log('DAEMON', `${sig} received, shutting down`)
    await handle.shutdown(); process.exit(0)
  }
  process.on('SIGINT', () => void cliShutdown('SIGINT'))
  process.on('SIGTERM', () => void cliShutdown('SIGTERM'))
  process.on('SIGUSR1', () => { handle.pollingReconcile?.()?.catch(err => log('RECONCILE', `SIGUSR1 reconcile failed: ${err instanceof Error ? err.message : String(err)}`)) })
}

// Direct invocation: `bun src/daemon/main.ts` (dev mode). In compiled binaries
// the entry is cli.ts, which imports + calls main() explicitly, so this guard
// only matters for source-mode dev runs.
if (import.meta.main) {
  main().catch((err) => { console.error('[wechat-cc] fatal:', err); process.exit(1) })
}
