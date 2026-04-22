#!/usr/bin/env bun
import { acquireInstanceLock, releaseInstanceLock } from './single-instance'
import { buildBootstrap } from './bootstrap'
import { routeInbound } from '../core/message-router'
import { loadAllAccounts, makeIlinkAdapter } from './ilink-glue'
import { startLongPollLoops, parseUpdates } from './poll-loop'
import { ilinkGetUpdates } from '../../ilink'
import { log } from '../../log'
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

  const stopPolling = startLongPollLoops({
    accounts,
    ilink: {
      getUpdates: async (baseUrl, token, syncBuf) => {
        const resp = await ilinkGetUpdates(baseUrl, token, syncBuf)
        return {
          updates: resp.msgs,
          sync_buf: resp.get_updates_buf,
        }
      },
    },
    parse: parseUpdates,
    resolveUserName: (chatId) => ilink.resolveUserName(chatId),
    log: (tag, line) => log(tag, line),
    onInbound: async (msg) => {
      ilink.markChatActive(msg.chatId)
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
    await stopPolling()
    await sessionManager.shutdown()
    await ilink.flush()
    releaseInstanceLock(PID_PATH)
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
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
