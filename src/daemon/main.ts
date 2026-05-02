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
import { openDb } from '../lib/db'
import { buildBootstrap } from './bootstrap'
import { createInternalApi } from './internal-api'
import { makeMemoryFS } from './memory/fs-api'
import { makeConversationStore } from '../core/conversation-store'
import { providerDisplayName } from './provider-display-names'
import { makeModeCommands } from './mode-commands'
import { loadAllAccounts, makeIlinkAdapter } from './ilink-glue'
import { startLongPollLoops, parseUpdates, type RawUpdate } from './poll-loop'
import { materializeAttachments, cleanupOldInbox } from './media'
import { log } from '../lib/log'
import { isAdmin, loadAccess } from '../lib/access'
import { makeAdminCommands } from './admin-commands'
import { makeOnboardingHandler } from './onboarding'
import { notifyStartup } from './notify-startup'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { buildMemorySnapshot } from './memory/snapshot.ts'
import { startCompanionScheduler } from './companion/scheduler'
import { loadCompanionConfig, saveCompanionConfig } from './companion/config'
import { startGuardScheduler } from './guard/scheduler'
import { loadGuardConfig } from './guard/store'
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

  // Single SQLite connection for all daemon-owned state stores. Lives at
  // ~/.claude/channels/wechat/wechat-cc.db. Per-store JSON/JSONL files are
  // migrated into this db on first boot post-PR7 (each store knows its own
  // legacy path; old files renamed to .migrated).
  const db = openDb({ path: join(STATE_DIR, 'wechat-cc.db') })
  const ilink = makeIlinkAdapter({ stateDir: STATE_DIR, accounts, db })
  const launchCwd = process.cwd()

  // MemoryFS is shared with the internal-api's memory_* HTTP routes AND
  // the legacy in-process MCP server (RFC 03 P1.B B2). Construct it once
  // here so both paths see the same files.
  const memoryFS = makeMemoryFS({ rootDir: join(STATE_DIR, 'memory') })

  // Per-chat conversation mode store (RFC 03 P2 + P3). Single instance
  // shared between bootstrap (where the coordinator reads/writes mode)
  // and internal-api (where the reply route looks up mode to decide
  // whether to prefix outgoing text with [Claude] / [Codex] in parallel
  // mode). Daemon-owned construction here ensures both consumers see
  // the same in-memory state without polling the file.
  const conversationStore = makeConversationStore(
    db,
    { migrateFromFile: join(STATE_DIR, 'conversations.json') },
  )

  // RFC 03 §5 — start the daemon's internal HTTP API before bootstrap so
  // the wechat-mcp stdio MCP servers we register with each provider can
  // call back. Token-authed, loopback-only.
  const internalApi = createInternalApi({
    stateDir: STATE_DIR,
    daemonPid: process.pid,
    memory: memoryFS,
    projects: ilink.projects,
    setUserName: (chatId, name) => ilink.setUserName(chatId, name),
    voice: {
      replyVoice: (chatId, text) => ilink.voice.replyVoice(chatId, text),
      saveConfig: (input) => ilink.voice.saveConfig(input),
      configStatus: () => ilink.voice.configStatus(),
    },
    sharePage: (title, content, opts) => ilink.sharePage(title, content, opts),
    resurfacePage: (q) => ilink.resurfacePage(q),
    companion: {
      enable: () => ilink.companion.enable(),
      disable: () => ilink.companion.disable(),
      status: () => ilink.companion.status(),
      snooze: (minutes) => ilink.companion.snooze(minutes),
    },
    // Ilink-bound message family (RFC 03 P1.B B1). reply_voice goes
    // through `voice.replyVoice` above; the four below cover the rest of
    // the reply-tool family (reply / send_file / edit_message / broadcast).
    ilink: {
      sendReply: (chatId, text) => ilink.sendMessage(chatId, text).then(r => r as { msgId: string; error?: string }),
      sendFile: (chatId, path) => ilink.sendFile(chatId, path),
      editMessage: (chatId, msgId, text) => ilink.editMessage(chatId, msgId, text),
      broadcast: (text, accountId) => ilink.broadcast(text, accountId),
    },
    // RFC 03 P3 — mode-aware reply prefix. internal-api consults the
    // conversationStore at every /v1/wechat/reply call; if the chat is
    // in parallel/chatroom mode, prefixes the outgoing text with the
    // sender's display name. In solo mode the participant_tag is
    // ignored and text passes through unchanged.
    prefix: {
      conversationStore,
      providerDisplayName,
    },
    log: (tag, line) => log(tag, line),
  })
  const { port: internalApiPort, tokenFilePath: internalTokenFile } = await internalApi.start()
  log('BOOT', `internal-api listening on 127.0.0.1:${internalApiPort} (token: ${internalTokenFile})`)

  const { sessionManager, sessionStore, registry, coordinator, resolve, formatInbound, sdkOptionsForProject, defaultProviderId, dispatchDelegate } = buildBootstrap({
    stateDir: STATE_DIR,
    db,
    ilink,
    loadProjects: ilink.loadProjects,
    lastActiveChatId: ilink.lastActiveChatId,
    log: (tag, line) => log(tag, line),
    fallbackProject: () => ({ alias: '_default', path: launchCwd }),
    dangerouslySkipPermissions: DANGEROUSLY,
    internalApi: {
      baseUrl: `http://127.0.0.1:${internalApiPort}`,
      tokenFilePath: internalTokenFile,
    },
    conversationStore,
  })

  // RFC 03 P4 — late-bind the delegate dispatcher into internal-api.
  // The bare delegate providers live in bootstrap; internal-api was
  // constructed before bootstrap so it couldn't take this at creation
  // time. setDelegate is the seam for this circular dependency.
  internalApi.setDelegate({
    dispatchOneShot: dispatchDelegate,
    knownPeers: () => registry.list(),
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
      // Companion ticks use the daemon-default provider. RFC 03 P2 left
      // companion proactive pushes provider-agnostic for now; later we
      // could honour per-chat mode (look up cfg.default_chat_id's mode)
      // but that requires conversation-store access here.
      const handle = await sessionManager.acquire(proj.alias, proj.path, defaultProviderId)
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
  // surprise comes from user opening memory pane. v0.4.1 wires the real
  // SDK eval (claude-haiku-4-5, single-shot, no tools).
  const INTROSPECT_TICK_INTERVAL_MS = 24 * 60 * 60 * 1000  // 24 h base
  const INTROSPECT_TICK_JITTER = 0.3

  // Shared introspect tick body — used by both the scheduler's onTick AND
  // the startup catch-up (maybeStartupIntrospect). Returns true if the tick
  // ran to completion (success or skip-on-missing-chat); false on agent
  // failure. Stamps `last_introspect_at` on completion so the startup
  // check + scheduler cadence both see the same source of truth.
  async function runIntrospectOnce(): Promise<boolean> {
    const { resolveIntrospectChatId, makeIntrospectAgent } = await import('./companion/introspect-runtime')
    const { runIntrospectTick } = await import('./companion/introspect')
    const { makeEventsStore } = await import('./events/store')
    const { makeObservationsStore } = await import('./observations/store')
    const chatId = resolveIntrospectChatId(STATE_DIR)
    if (!chatId) {
      log('INTROSPECT', 'skip tick — no default_chat_id configured')
      return true
    }
    const memoryRoot = join(STATE_DIR, 'memory')
    const events = makeEventsStore(db, chatId, {
      migrateFromFile: join(memoryRoot, chatId, 'events.jsonl'),
    })
    const observations = makeObservationsStore(db, chatId, {
      migrateFromFile: join(memoryRoot, chatId, 'observations.jsonl'),
    })
    const agent = makeIntrospectAgent({
      chatId,
      events,
      observations,
      memorySnapshot: () => buildMemorySnapshot(STATE_DIR, chatId),
      recentInboundMessages: () => recentInboundForChat(STATE_DIR, chatId),
      sdkEval: isolatedSdkEval,
    })
    await runIntrospectTick({ events, observations, agent, chatId, log: (tag, line) => log(tag, line) })
    // Persist last_introspect_at so successive boots respect the 24h
    // cadence — without this, every daemon restart resets the timer and
    // users who restart daily never see the introspect tick fire.
    await saveCompanionConfig(STATE_DIR, {
      ...loadCompanionConfig(STATE_DIR),
      last_introspect_at: new Date().toISOString(),
    })
    return true
  }

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
      await runIntrospectOnce()
    },
  })

  // On startup, if we haven't introspected within the last 24h (or ever),
  // fire one tick immediately so users who restart their daemon daily
  // (auto-update applied, sleep-wake, crash recovery) still see
  // observations land. Honors the same enabled+snooze gate as the
  // regular scheduler. Non-blocking — does NOT delay daemon boot.
  async function maybeStartupIntrospect(): Promise<void> {
    const cfg = loadCompanionConfig(STATE_DIR)
    if (!cfg.enabled) return
    const snooze = cfg.snooze_until
    if (snooze && Date.parse(snooze) > Date.now()) return
    const last = cfg.last_introspect_at
    if (last && Date.now() - Date.parse(last) < 24 * 60 * 60 * 1000) return
    try {
      await runIntrospectOnce()
      log('INTROSPECT', 'startup tick fired')
    } catch (err) {
      log('INTROSPECT', `startup tick failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  void maybeStartupIntrospect()

  // Network guard — disabled by default. When enabled, polls public IP
  // every 30s; if the IP changes, probes google.com (one HEAD). When the
  // probe fails, hard-shuts all live Claude sessions so the next inbound
  // returns a clear "VPN dropped" message instead of dying with cryptic
  // SDK errors. Recovery is automatic: next IP change that probes
  // reachable lets the next inbound spawn fresh.
  const stopGuard = startGuardScheduler({
    pollMs: 30_000,
    isEnabled: () => loadGuardConfig(STATE_DIR).enabled,
    probeUrl: () => loadGuardConfig(STATE_DIR).probe_url,
    ipifyUrl: () => loadGuardConfig(STATE_DIR).ipify_url,
    log: (tag, line) => log(tag, line),
    onStateChange: async (prev, next) => {
      if (prev.reachable && !next.reachable) {
        log('GUARD', `network DOWN — shutting down all sessions (was ${prev.ip}, now ${next.ip})`)
        await sessionManager.shutdown()
      }
    },
  })

  // First-inbound welcome observation — when a chat has never had ANY
  // observation (active OR archived), drop one playful welcome line so the
  // dashboard's memory pane top zone has content immediately. Once the user
  // archives it ("忽略"), we never auto-write again — checking archived too
  // means we respect that choice. Fire-and-forget; failures logged, never
  // propagated. Per spec §1.3 the welcome is a single observation, not a
  // system banner — should feel like Claude noticing you for the first time.
  async function maybeWriteWelcomeObservation(chatId: string): Promise<void> {
    try {
      const { makeObservationsStore } = await import('./observations/store.ts')
      const memoryRoot = join(STATE_DIR, 'memory')
      const obs = makeObservationsStore(db, chatId, {
        migrateFromFile: join(memoryRoot, chatId, 'observations.jsonl'),
      })
      const existing = await obs.listActive()
      const archived = await obs.listArchived()
      if (existing.length === 0 && archived.length === 0) {
        await obs.append({
          body: '嗨，我是 Claude。我会慢慢理解你，把观察写在这里——你可以随时来翻、纠正、忽略。',
          tone: 'playful',
        })
        log('OBSERVE', `welcome observation written for ${chatId}`)
      }
    } catch (err) {
      // Welcome is decoration — failure must not affect the inbound path.
      log('OBSERVE', `welcome write failed for ${chatId}: ${err instanceof Error ? err.message : err}`)
    }
  }

  // Track daily activity for this chat — feeds milestone detector's
  // 7-day-streak check. Fire-and-forget; failures don't impact reply.
  async function recordActivity(chatId: string, when: Date): Promise<void> {
    try {
      const { makeActivityStore } = await import('./activity/store.ts')
      const memoryRoot = join(STATE_DIR, 'memory')
      const store = makeActivityStore(db, chatId, {
        migrateFromFile: join(memoryRoot, chatId, 'activity.jsonl'),
      })
      await store.recordInbound(when)
    } catch (err) {
      log('ACTIVITY', `record failed for ${chatId}: ${err instanceof Error ? err.message : err}`)
    }
  }

  // Milestone detection — non-blocking, fire-and-forget. Runs once on
  // daemon startup (per known chat) and after each successful inbound. The
  // milestones store dedupes by id so repeated invocations are cheap and
  // idempotent. Errors are logged, never propagated to the caller.
  async function fireMilestonesFor(chatId: string): Promise<void> {
    try {
      const ctx = await buildDetectorContext({ stateDir: STATE_DIR, chatId, db })
      const memRoot = join(STATE_DIR, 'memory')
      const milestones = makeMilestonesStore(db, chatId, {
        migrateFromFile: join(memRoot, chatId, 'milestones.jsonl'),
      })
      const events = makeEventsStore(db, chatId, {
        migrateFromFile: join(memRoot, chatId, 'events.jsonl'),
      })
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
    sendMessage: async (chatId, text) => { await ilink.sendMessage(chatId, text) },
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

  // Per-chat conversation mode commands (RFC 03 P2). Runs in the inbound
  // handler chain right after admin commands; intercepts /cc /codex
  // /solo /mode /both /chat before the coordinator dispatches.
  const modeCommands = makeModeCommands({
    coordinator,
    registry,
    defaultProviderId,
    sendMessage: (chatId, text) => ilink.sendMessage(chatId, text),
    log: (tag, line) => log(tag, line),
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
      // Per-chat mode commands (RFC 03 P2): /cc /codex /solo /mode /both /chat.
      // These flip the conversation's provider/mode and never reach the agent.
      // Run after admin (so /health takes precedence) but before onboarding so
      // a user can re-mode without retyping their nickname.
      if (await modeCommands.handle(msg)) return
      // First-time onboarding for unknown users — capture nickname before
      // anything reaches Claude.
      if (await onboarding.handle(msg)) return
      // Short-circuit permission replies BEFORE routing to Claude
      if (ilink.handlePermissionReply(msg.text)) {
        log('PERMISSION', `consumed reply from chat=${msg.chatId}`)
        return
      }
      // Network guard: if the canary probe last saw the network as
      // unreachable, refuse to spawn Claude (would burn ~10-15s on
      // SDK timeout) and tell the user out loud. Sending the alert
      // via ilink is safe — ilink server is in China, doesn't need
      // VPN. Per design: NO proactive push when guard flips DOWN —
      // we only nag when the user is actively trying to use it.
      const guardCfg = loadGuardConfig(STATE_DIR)
      const guardState = stopGuard.current()
      if (guardCfg.enabled && !guardState.reachable && guardState.ip) {
        log('GUARD', `dropping inbound chat=${msg.chatId} — network DOWN ip=${guardState.ip}`)
        await ilink.sendMessage(msg.chatId, `🛑 出口 IP ${guardState.ip} → 网络探测失败。VPN 掉了？修好再发。`)
        return
      }
      // Download CDN refs to inbox/ before the agent sees the message.
      await materializeAttachments(msg, INBOX_DIR, (tag, line) => log(tag, line))
      // Mode-aware dispatch (RFC 03 P2). Coordinator looks up the chat's
      // persisted mode, acquires the right (provider, alias) session, and
      // dispatches; carries the same reply-tool-fallback semantics that
      // the legacy routeInbound had.
      await coordinator.dispatch(msg)
      // Fire-and-forget milestone detection + welcome observation after
      // successful routing. Non-blocking so an unrelated failure can never
      // delay the next inbound or impact reply latency.
      void maybeWriteWelcomeObservation(msg.chatId)
      void recordActivity(msg.chatId, new Date(msg.createTimeMs || Date.now()))
      void fireMilestonesFor(msg.chatId)
    },
  })

  const shutdown = async () => {
    log('DAEMON', 'shutdown initiated')
    await stopScheduler()
    await stopIntrospect()
    await stopGuard.stop()
    await pollHandle.stop()
    await sessionManager.shutdown()
    await sessionStore.flush()
    await conversationStore.flush()
    await ilink.flush()
    // Stop internal-api LAST: any in-flight wechat-mcp tool call from a
    // session being shut down still needs the HTTP server to be alive.
    // Token file is kept on disk so a fast-restart daemon can be debugged
    // (it's overwritten on next start anyway; see internal-api.ts).
    await internalApi.stop()
    db.close()
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

  // Sweep old media off inbox/ — without this the 30-day TTL is dead code
  // (cleanupOldInbox was exported but never invoked) and inbox/ grows
  // indefinitely. Run async so a slow filesystem can't delay daemon ready.
  void Promise.resolve().then(() => {
    const removed = cleanupOldInbox(INBOX_DIR)
    if (removed > 0) log('INBOX', `cleaned ${removed} files older than 30 days`)
  }).catch((err) => log('INBOX', `cleanup failed: ${err instanceof Error ? err.message : err}`))

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

// ---------- introspect-tick helpers ----------
//
// Module-scope so they can be referenced from runIntrospectOnce without
// capturing closures. All three are pure async functions with explicit
// stateDir / chatId args.

/**
 * Recent inbound messages for the given chat. v0.4.1 returns empty — v0.5
 * will surface per-chat inbound history from the daemon's message log. The
 * introspect prompt's "用户最近发的消息" section will be empty, but memory +
 * observations + events still give Claude enough to decide.
 */
async function recentInboundForChat(_stateDir: string, _chatId: string): Promise<string[]> {
  return []
}

/**
 * Single-shot Haiku eval — no tools, no MCP, no resumed session. Just
 * prompt → assistant text. Mirrors the iterator shape used in
 * src/core/claude-agent-provider.ts (`for await (const raw of q)`, branch
 * on msg.type === 'assistant', extract text parts), but trimmed to one
 * turn since introspect is single-prompt → single-text-response.
 */
async function isolatedSdkEval(prompt: string): Promise<string> {
  const q = query({
    prompt,
    options: {
      model: 'claude-haiku-4-5',
      maxTurns: 1,
    },
  })
  let text = ''
  for await (const raw of q as AsyncGenerator<SDKMessage>) {
    const msg = raw as unknown as { type: string; message?: { content?: unknown } }
    if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
      for (const part of msg.message.content as Array<{ type?: string; text?: string }>) {
        if (part.type === 'text' && typeof part.text === 'string') text += part.text
      }
    }
  }
  return text
}

main().catch((err) => {
  console.error('[wechat-cc] fatal:', err)
  releaseInstanceLock(PID_PATH)
  process.exit(1)
})
