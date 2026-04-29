#!/usr/bin/env bun
// Claude SDK stream-json input mode requires CLAUDE_CODE_ENTRYPOINT to be
// set; otherwise the spawned `claude` binary ignores --input-format=stream-json
// and waits for terminal input forever (silent hang — typing indicator goes
// out, no reply ever lands). The SDK *should* set this on the child env, but
// in the bun --compile build of wechat-cc the propagation is unreliable, so
// we set it on the daemon's own env here, before any SDK spawn happens.
if (!process.env.CLAUDE_CODE_ENTRYPOINT) {
  process.env.CLAUDE_CODE_ENTRYPOINT = 'sdk-ts'
}
import { acquireInstanceLock, releaseInstanceLock } from './single-instance'
import { buildBootstrap } from './bootstrap'
import { routeInbound } from '../core/message-router'
import { loadAllAccounts, makeIlinkAdapter } from './ilink-glue'
import { startLongPollLoops, parseUpdates, type RawUpdate } from './poll-loop'
import { materializeAttachments } from './media'
import { log } from '../../log'
import { isAdmin, loadAccess } from '../../access'
import { makeAdminCommands } from './admin-commands'
import { makeOnboardingHandler } from './onboarding'
import { notifyStartup } from './notify-startup'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { startCompanionScheduler } from './companion/scheduler'
import { loadCompanionConfig } from './companion/config'
import { buildDetectorContext } from './milestones/build-context'
import { detectMilestones } from './milestones/detector'
import { makeMilestonesStore } from './milestones/store'
import { makeEventsStore } from './events/store'

const STATE_DIR = join(homedir(), '.claude', 'channels', 'wechat')
const PID_PATH = join(STATE_DIR, 'server.pid')
const INBOX_DIR = join(STATE_DIR, 'inbox')
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
    name: 'push',
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

  // Introspect tick — slower than the push scheduler (24h ± 30%), never
  // pushes to user. Output goes to observations.jsonl + events.jsonl;
  // surprise comes from user opening memory pane. v0.4 ships a stub agent
  // (always returns write=false); real SDK integration in v0.4.1.
  const INTROSPECT_TICK_INTERVAL_MS = 24 * 60 * 60 * 1000  // 24 h base
  const INTROSPECT_TICK_JITTER = 0.3
  const stopIntrospect = startCompanionScheduler({
    name: 'introspect',
    intervalMs: INTROSPECT_TICK_INTERVAL_MS,
    jitterRatio: INTROSPECT_TICK_JITTER,
    isEnabled: () => loadCompanionConfig(STATE_DIR).enabled,
    isSnoozed: () => {
      const snooze = loadCompanionConfig(STATE_DIR).snooze_until
      return !!snooze && Date.parse(snooze) > Date.now()
    },
    log: (tag, line) => log(tag, line),
    onTick: async () => {
      const { resolveIntrospectChatId, makeIntrospectAgent } = await import('./companion/introspect-runtime')
      const { runIntrospectTick } = await import('./companion/introspect')
      const { makeEventsStore } = await import('./events/store')
      const { makeObservationsStore } = await import('./observations/store')
      const chatId = resolveIntrospectChatId(STATE_DIR)
      if (!chatId) {
        log('INTROSPECT', 'skip tick — no default_chat_id configured')
        return
      }
      const memoryRoot = join(STATE_DIR, 'memory')
      const events = makeEventsStore(memoryRoot, chatId)
      const observations = makeObservationsStore(memoryRoot, chatId)
      const agent = makeIntrospectAgent()
      await runIntrospectTick({ events, observations, agent, chatId, log: (tag, line) => log(tag, line) })
    },
  })

  // Milestone detection — non-blocking, fire-and-forget. Runs once on
  // daemon startup (per known chat) and after each successful inbound. The
  // milestones store dedupes by id so repeated invocations are cheap and
  // idempotent. Errors are logged, never propagated to the caller.
  async function fireMilestonesFor(chatId: string): Promise<void> {
    try {
      const ctx = await buildDetectorContext({ stateDir: STATE_DIR, chatId })
      const memRoot = join(STATE_DIR, 'memory')
      const milestones = makeMilestonesStore(memRoot, chatId)
      const events = makeEventsStore(memRoot, chatId)
      const fired = await detectMilestones(milestones, ctx)
      for (const id of fired) {
        await events.append({
          kind: 'milestone',
          trigger: 'detector',
          reasoning: `milestone ${id} fired`,
          milestone_id: id,
        })
      }
    } catch (err) {
      log('MILESTONE', `detect failed for ${chatId}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const startedAtIso = new Date().toISOString()

  // pollHandle is created after we compose the admin-commands handler, but
  // admin-commands needs a reference to it. Forward-declare a lazy wrapper so
  // the handler can reach the handle that will be assigned below.
  let pollHandle!: ReturnType<typeof startLongPollLoops>

  // Deterministic first-time greeting: when an unknown wechat user (not in
  // user_names.json) sends their first message, the daemon answers with a
  // greeting + nickname prompt INSTEAD of routing to Claude. Prevents the
  // common case where Claude jumps straight into the task and never learns
  // who's talking. State is in-memory (30 min window). See onboarding.ts.
  const onboarding = makeOnboardingHandler({
    isKnownUser: (userId) => ilink.resolveUserName(userId) !== undefined,
    setUserName: (chatId, name) => ilink.setUserName(chatId, name),
    sendMessage: (chatId, text) => ilink.sendMessage(chatId, text),
    log: (tag, line) => log(tag, line),
  })

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
    sharePage: (title, content, opts) => ilink.sharePage(title, content, opts),
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
          updates?: RawUpdate[]
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
      // ilink requires context_token on outbound sendmessage; capture it
      // from each inbound so replies don't fail with errcode=-14 ("session
      // timeout"). The OLD server.ts did this; the v1.0 rebuild dropped
      // it. Re-added in v0.3.1.
      if (msg.contextToken) ilink.captureContextToken(msg.chatId, msg.contextToken)
      // Fire "正在输入..." immediately so the user sees activity during
      // Claude's ~8-15s cold-start on first turn. Best-effort.
      void ilink.sendTyping(msg.chatId, msg.accountId)
      // Admin-only slash / natural-language commands (/health, 清理...) get
      // intercepted BEFORE routing to Claude. Non-admin senders silently
      // dropped (consistent with legacy /project command handling). Admins
      // run before onboarding so an admin can use /health on the first
      // message without being held up by the nickname prompt.
      if (await adminCommands.handle(msg)) return
      // First-time onboarding for unknown users — capture nickname before
      // anything reaches Claude.
      if (await onboarding.handle(msg)) return
      // Short-circuit permission replies BEFORE routing to Claude
      if (ilink.handlePermissionReply(msg.text)) {
        log('PERMISSION', `consumed reply from chat=${msg.chatId}`)
        return
      }
      // Download CDN refs to inbox/ before Claude sees the message.
      await materializeAttachments(msg, INBOX_DIR, (tag, line) => log(tag, line))
      await routeInbound({
        resolveProject: resolve,
        manager: sessionManager,
        format: formatInbound,
        // Plain assistant text is intentionally NOT forwarded to wechat —
        // the system prompt tells Claude to use the `reply` MCP tool, and
        // forwarding plain text on top of that produced duplicate messages
        // ("2" + "已回复 2。"). Drop plain text; tool calls remain the
        // only outbound path.
        log: (tag, line) => log(tag, line),
      }, msg)
      // Fire-and-forget milestone detection after successful routing.
      // Non-blocking so an unrelated detector failure can never delay the
      // next inbound or impact reply latency.
      void fireMilestonesFor(msg.chatId)
    },
  })

  const shutdown = async () => {
    log('DAEMON', 'shutdown initiated')
    await stopScheduler()
    await stopIntrospect()
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

  // Startup milestone sweep — gives the detector a chance to fire on chats
  // whose facts already met a threshold before the daemon ever started
  // (e.g. an upgrader who already has 100+ turns). v0.4 is single-chat:
  // only the configured default_chat_id is checked. v0.5 will enumerate
  // all bound chats from memory/.
  const bootChatId = loadCompanionConfig(STATE_DIR).default_chat_id
  if (bootChatId) {
    void fireMilestonesFor(bootChatId)
  }

  // Best-effort startup notification to the bound owner over WeChat. Throttled
  // to avoid spamming on KeepAlive crash-loops; never blocks daemon readiness.
  notifyStartup(
    {
      stateDir: STATE_DIR,
      loadAccess: () => {
        const a = loadAccess()
        return { allowFrom: a.allowFrom, admins: a.admins }
      },
      send: (chatId, text) => ilink.sendMessage(chatId, text),
      log: (tag, line) => log(tag, line),
    },
    { pid: process.pid, accounts: accounts.length, dangerously: DANGEROUSLY }
  ).catch((err) => log('NOTIFY', `unhandled: ${err instanceof Error ? err.message : String(err)}`))
}

main().catch((err) => {
  console.error('[wechat-cc] fatal:', err)
  releaseInstanceLock(PID_PATH)
  process.exit(1)
})
