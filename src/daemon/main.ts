#!/usr/bin/env bun
import { acquireInstanceLock, releaseInstanceLock } from './single-instance'
import { buildBootstrap } from './bootstrap'
import { routeInbound } from '../core/message-router'
import { loadAllAccounts, makeIlinkAdapter } from './ilink-glue'
import { startLongPollLoops, parseUpdates } from './poll-loop'
import { log } from '../../log'
import { isAdmin } from '../../access'
import { makeAdminCommands } from './admin-commands'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { startCompanionScheduler } from './companion/scheduler'
import { loadCompanionConfig } from './companion/config'

const STATE_DIR = join(homedir(), '.claude', 'channels', 'wechat')
const PID_PATH = join(STATE_DIR, 'server.pid')
const DANGEROUSLY = process.argv.includes('--dangerously')

async function main() {
  const lock = acquireInstanceLock(PID_PATH)
  if (!lock.ok) {
    console.error(`[wechat-cc] ${lock.reason} (pid=${lock.pid}). Exiting.`)
    process.exit(1)
  }

  const accounts = await loadAllAccounts(STATE_DIR)
  if (accounts.length === 0) {
    console.error('[wechat-cc] no accounts bound. Run `wechat-cc setup` first.')
    releaseInstanceLock(PID_PATH)
    process.exit(1)
  }

  const ilink = makeIlinkAdapter({ stateDir: STATE_DIR, accounts })
  const launchCwd = process.cwd()
  const { sessionManager, sessionStore, resolve, formatInbound, sdkOptionsForProject } = buildBootstrap({
    stateDir: STATE_DIR,
    ilink,
    loadProjects: ilink.loadProjects,
    lastActiveChatId: ilink.lastActiveChatId,
    log: (tag, line) => log(tag, line),
    fallbackProject: () => ({ alias: '_default', path: launchCwd }),
    dangerouslySkipPermissions: DANGEROUSLY,
  })

  // Companion v2 scheduler — simple interval+jitter tick. When enabled +
  // not snoozed, dispatches a companion_tick message into the current
  // project's live session. Claude reads memory/, checks context, decides
  // whether to push — no hardcoded rules, no isolated eval session. See
  // docs/specs/2026-04-24-companion-memory.md for rationale.
  const COMPANION_TICK_INTERVAL_MS = 20 * 60 * 1000  // 20 min base
  const COMPANION_TICK_JITTER = 0.3                  // ±30%

  const stopScheduler = startCompanionScheduler({
    intervalMs: COMPANION_TICK_INTERVAL_MS,
    jitterRatio: COMPANION_TICK_JITTER,
    isEnabled: () => loadCompanionConfig(STATE_DIR).enabled,
    isSnoozed: () => {
      const snooze = loadCompanionConfig(STATE_DIR).snooze_until
      return !!snooze && Date.parse(snooze) > Date.now()
    },
    log: (tag, line) => log(tag, line),
    onTick: async () => {
      const cfg = loadCompanionConfig(STATE_DIR)
      if (!cfg.default_chat_id) {
        log('SCHED', 'skip tick — no default_chat_id configured')
        return
      }
      const snapshot = ilink.loadProjects()
      const currentAlias = snapshot.current && snapshot.projects[snapshot.current] ? snapshot.current : null
      const proj = currentAlias
        ? { alias: currentAlias, path: snapshot.projects[currentAlias]!.path }
        : { alias: '_default', path: launchCwd }
      const handle = await sessionManager.acquire(proj.alias, proj.path)
      const tickText =
        `<companion_tick ts="${new Date().toISOString()}" default_chat_id="${cfg.default_chat_id}" />\n` +
        `定时唤醒。先 memory_list + memory_read 你觉得相关的文件。` +
        `再看当前时间和用户最近状态。决定是否向 ${cfg.default_chat_id} push，或保持沉默。` +
        `不确定就选不打扰。push 后写一条 memory 记下决策和意图（便于下次 tick 读到效果）。`
      try {
        await handle.dispatch(tickText)
        log('SCHED', `companion tick dispatched to project=${proj.alias} chat=${cfg.default_chat_id}`)
      } catch (err) {
        log('SCHED', `companion tick dispatch failed: ${err instanceof Error ? err.message : err}`)
      }
    },
  })

  const startedAtIso = new Date().toISOString()

  // pollHandle is created after we compose the admin-commands handler, but
  // admin-commands needs a reference to it. Forward-declare a lazy wrapper so
  // the handler can reach the handle that will be assigned below.
  let pollHandle!: ReturnType<typeof startLongPollLoops>

  const adminCommands = makeAdminCommands({
    stateDir: STATE_DIR,
    isAdmin,
    sessionState: ilink.sessionState,
    pollHandle: {
      stopAccount: (id) => pollHandle.stopAccount(id),
      running: () => pollHandle.running(),
    },
    resolveUserName: (chatId) => ilink.resolveUserName(chatId),
    sendMessage: (chatId, text) => ilink.sendMessage(chatId, text),
    log: (tag, line) => log(tag, line),
    startedAt: startedAtIso,
  })

  pollHandle = startLongPollLoops({
    accounts,
    ilink: {
      // Adapter wraps ilinkGetUpdates with errcode=-14 detection — returns
      // { expired: true } when the bot's ilink session is dead so the loop
      // self-terminates; SessionStateStore tracks the flag for /health.
      getUpdates: (accountId, baseUrl, token, syncBuf) =>
        ilink.getUpdatesForLoop(accountId, baseUrl, token, syncBuf) as Promise<{
          updates?: unknown[]
          sync_buf?: string
          expired?: boolean
        }>,
    },
    parse: parseUpdates,
    resolveUserName: (chatId) => ilink.resolveUserName(chatId),
    log: (tag, line) => log(tag, line),
    onInbound: async (msg) => {
      // accountId keeps the persisted user→bot route fresh (self-heals after re-bind).
      ilink.markChatActive(msg.chatId, msg.accountId)
      // Fire "正在输入..." immediately so the user sees activity during
      // Claude's ~8-15s cold-start on first turn. Best-effort.
      void ilink.sendTyping(msg.chatId, msg.accountId)
      // Admin-only slash / natural-language commands (/health, 清理...) get
      // intercepted BEFORE routing to Claude. Non-admin senders silently
      // dropped (consistent with legacy /project command handling).
      if (await adminCommands.handle(msg)) return
      // Short-circuit permission replies BEFORE routing to Claude
      if (ilink.handlePermissionReply(msg.text)) {
        log('PERMISSION', `consumed reply from chat=${msg.chatId}`)
        return
      }
      await routeInbound({
        resolveProject: resolve,
        manager: sessionManager,
        format: formatInbound,
        log: (tag, line) => log(tag, line),
      }, msg)
    },
  })

  const shutdown = async () => {
    log('DAEMON', 'shutdown initiated')
    await stopScheduler()
    await pollHandle.stop()
    await sessionManager.shutdown()
    await sessionStore.flush()
    await ilink.flush()
    releaseInstanceLock(PID_PATH)
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  // SIGUSR1 = "new account(s) bound; re-read accounts dir". Sent by
  // `wechat-cc setup` after a successful QR-scan so the daemon starts
  // polling the new bot without a restart. addAccount() is idempotent,
  // so we simply re-attempt all; existing ids are skipped.
  process.on('SIGUSR1', async () => {
    try {
      const latest = await loadAllAccounts(STATE_DIR)
      const known = new Set(pollHandle.running())
      const fresh = latest.filter(a => !known.has(a.id))
      if (fresh.length === 0) {
        log('RECONCILE', 'SIGUSR1 received; no new accounts')
        return
      }
      for (const a of fresh) pollHandle.addAccount(a)
      log('RECONCILE', `SIGUSR1 picked up ${fresh.length} new account(s): ${fresh.map(a => a.id).join(', ')}`)
    } catch (err) {
      log('RECONCILE', `SIGUSR1 reconcile failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  })
  const modeStr = DANGEROUSLY
    ? 'mode=dangerouslySkipPermissions=true (no WeChat permission prompts will fire)'
    : 'mode=strict (Phase 1 permission relay active)'
  log('DAEMON', `started pid=${process.pid} accounts=${accounts.length} ${modeStr}`)
  if (DANGEROUSLY) {
    log('DAEMON', 'warning: Claude will still confirm destructive ops via natural-language reply, but no permission prompts will appear.')
  }
}

main().catch((err) => {
  console.error('[wechat-cc] fatal:', err)
  releaseInstanceLock(PID_PATH)
  process.exit(1)
})
