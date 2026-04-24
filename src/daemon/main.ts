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
import { startScheduler } from './companion/scheduler'
import { makeEvalTrigger } from './companion/eval-session'
import { makeRunsLogger, makePushLogger } from './companion/logs'
import { loadCompanionConfig } from './companion/config'
import { loadPersona } from './companion/persona'
import { profilePath } from './companion/paths'
import { readFileSync, existsSync } from 'node:fs'

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
  const { sessionManager, resolve, formatInbound, sdkOptionsForProject } = buildBootstrap({
    stateDir: STATE_DIR,
    ilink,
    loadProjects: ilink.loadProjects,
    lastActiveChatId: ilink.lastActiveChatId,
    log: (tag, line) => log(tag, line),
    fallbackProject: () => ({ alias: '_default', path: launchCwd }),
    dangerouslySkipPermissions: DANGEROUSLY,
  })

  // Companion scheduler (proactive push). Default-off via config.enabled=false;
  // only fires when user opts in via `companion_enable` tool.
  const companionRuns = makeRunsLogger(STATE_DIR)
  const companionPushes = makePushLogger(STATE_DIR)

  const evalTrigger = makeEvalTrigger({
    sdkOptionsBase: () => {
      const sample = sdkOptionsForProject('_default', launchCwd)
      return {
        cwd: launchCwd,
        mcpServers: sample.mcpServers,
      }
    },
    log: (tag, line) => log(tag, line),
  })

  const stopScheduler = startScheduler({
    loadConfig: () => loadCompanionConfig(STATE_DIR),
    runs: companionRuns,
    pushes: companionPushes,
    evalTrigger: async (trigger, { cfg }) => {
      const personaName =
        cfg.per_project_persona[trigger.project] ??
        cfg.per_project_persona['_default'] ??
        'assistant'
      const persona = loadPersona(STATE_DIR, personaName)
      if (!persona) {
        log('SCHED', `persona '${personaName}' not found; skipping trigger ${trigger.id}`)
        return { pushed: false, cost_usd: 0, tool_uses_count: 0, duration_ms: 0, error_message: `persona ${personaName} missing` }
      }
      const profileContent = existsSync(profilePath(STATE_DIR))
        ? readFileSync(profilePath(STATE_DIR), 'utf8')
        : ''
      const result = await evalTrigger(trigger, {
        recent_pushes: [],
        recent_runs: [],
        profile: profileContent,
        persona,
        chat_id: cfg.default_chat_id ?? '',
      })
      if (result.pushed && result.message && cfg.default_chat_id) {
        try {
          await ilink.sendMessage(cfg.default_chat_id, result.message)
        } catch (err) {
          log('PUSH', `delivery failed for trigger=${trigger.id}: ${err}`)
        }
      }
      return result
    },
    now: () => new Date(),
  }, (tag, line) => log(tag, line))

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
