#!/usr/bin/env bun
if (!process.env.CLAUDE_CODE_ENTRYPOINT) { process.env.CLAUDE_CODE_ENTRYPOINT = 'sdk-ts' }
import { join } from 'node:path'
import { homedir } from 'node:os'
import { acquireInstanceLock, releaseInstanceLock } from './single-instance'
import { openDb } from '../lib/db'
import { LifecycleSet } from '../lib/lifecycle'
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
import { wireMain } from './main-wiring'
const STATE_DIR = join(homedir(), '.claude', 'channels', 'wechat')
const PID_PATH = join(STATE_DIR, 'server.pid')
const DANGEROUSLY = process.argv.includes('--dangerously')
let shuttingDown = false
async function main() {
  const lock = acquireInstanceLock(PID_PATH)
  if (!lock.ok) { console.error(`[wechat-cc] ${lock.reason} (pid=${lock.pid}). Exiting.`); process.exit(1) }
  const accounts = await loadAllAccounts(STATE_DIR)
  if (accounts.length === 0) {
    console.error('[wechat-cc] no accounts bound. Run `wechat-cc setup` first.')
    releaseInstanceLock(PID_PATH); process.exit(1)
  }
  const db = openDb({ path: join(STATE_DIR, 'wechat-cc.db') })
  const ilink = makeIlinkAdapter({ stateDir: STATE_DIR, accounts, db })
  const memoryFS = makeMemoryFS({ rootDir: join(STATE_DIR, 'memory') })
  const conversationStore = makeConversationStore(db, { migrateFromFile: join(STATE_DIR, 'conversations.json') })
  const lc = new LifecycleSet((tag, line) => log(tag, line))
  try {
    // 1. internal-api FIRST — bootstrap needs its baseUrl/token for MCP wiring
    const internalApi = await registerInternalApi({
      stateDir: STATE_DIR, daemonPid: process.pid, memory: memoryFS, projects: ilink.projects,
      setUserName: (chatId, name) => ilink.setUserName(chatId, name),
      voice: { replyVoice: (c, t) => ilink.voice.replyVoice(c, t), saveConfig: (i) => ilink.voice.saveConfig(i), configStatus: () => ilink.voice.configStatus() },
      sharePage: (t, c, o) => ilink.sharePage(t, c, o), resurfacePage: (q) => ilink.resurfacePage(q),
      companion: { enable: () => ilink.companion.enable(), disable: () => ilink.companion.disable(), status: () => ilink.companion.status(), snooze: (m) => ilink.companion.snooze(m) },
      ilink: { sendReply: (c, t) => ilink.sendMessage(c, t).then(r => r as { msgId: string; error?: string }), sendFile: (c, p) => ilink.sendFile(c, p), editMessage: (c, m, t) => ilink.editMessage(c, m, t), broadcast: (t, a) => ilink.broadcast(t, a) },
      prefix: { conversationStore, providerDisplayName, permissionMode: DANGEROUSLY ? 'dangerously' as const : 'strict' as const },
      log: (t, l) => log(t, l),
    })
    lc.register(internalApi)
    // 2. bootstrap composes provider registry / session manager / coordinator
    const boot = buildBootstrap({
      stateDir: STATE_DIR, db, ilink, loadProjects: ilink.loadProjects,
      lastActiveChatId: ilink.lastActiveChatId, log: (t, l) => log(t, l),
      fallbackProject: () => ({ alias: '_default', path: process.cwd() }),
      dangerouslySkipPermissions: DANGEROUSLY, conversationStore,
      internalApi: { baseUrl: internalApi.baseUrl, tokenFilePath: internalApi.tokenFilePath },
    })
    internalApi.setDelegate({ dispatchOneShot: boot.dispatchDelegate, knownPeers: () => boot.registry.list() })
    // 3. main-wiring builds all deps for pipeline + lifecycles
    const wired = wireMain({ stateDir: STATE_DIR, db, ilink, accounts, boot, dangerously: DANGEROUSLY, log: (t, l) => log(t, l) })
    const pipeline = buildInboundPipeline(wired.pipelineDeps)
    // 4. register lifecycles (LIFO stop = startup order reversed)
    lc.register(registerCompanionPush(wired.companionPushDeps))
    lc.register(registerCompanionIntrospect(wired.companionIntrospectDeps))
    const guardLc = registerGuard(wired.guardDeps)
    wired.refs.guard.current = guardLc; lc.register(guardLc)
    lc.register(registerSessions(wired.sessionsDeps))
    lc.register(registerIlink(wired.ilinkDeps))
    const pollingLc = registerPolling({ ...wired.pollingDeps, runPipeline: pipeline })
    wired.refs.polling.current = pollingLc; lc.register(pollingLc)
    // 5. one-shot startup sweeps — fire-and-forget
    runStartupSweeps(wired.startupDeps)
    // 6. signal handlers
    const shutdown = async (sig: string) => {
      if (shuttingDown) { log('DAEMON', `${sig} during shutdown — forcing exit`); process.exit(130) }
      shuttingDown = true; log('DAEMON', `${sig} received, shutting down`)
      try { await lc.stopAll() } catch { /* logged by lc */ }
      try { db.close() } catch (err) { console.error('db close failed:', err) }
      releaseInstanceLock(PID_PATH); process.exit(0)
    }
    process.on('SIGINT', () => shutdown('SIGINT'))
    process.on('SIGTERM', () => shutdown('SIGTERM'))
    process.on('SIGUSR1', () => pollingLc.reconcile().catch(err =>
      log('RECONCILE', `SIGUSR1 reconcile failed: ${err instanceof Error ? err.message : String(err)}`),
    ))
    log('DAEMON', `started pid=${process.pid} accounts=${accounts.length} mode=${DANGEROUSLY ? 'dangerouslySkipPermissions' : 'strict'}`)
    if (DANGEROUSLY) log('DAEMON', 'warning: Claude will still confirm destructive ops via natural-language reply, but no permission prompts will appear.')
  } catch (err) {
    log('DAEMON', `startup failed mid-init: ${err instanceof Error ? err.message : String(err)}`)
    try { await lc.stopAll() } catch {}
    db.close(); releaseInstanceLock(PID_PATH); throw err
  }
}
main().catch((err) => { console.error('[wechat-cc] fatal:', err); process.exit(1) })
