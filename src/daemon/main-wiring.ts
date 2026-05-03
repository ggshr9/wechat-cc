import { join } from 'node:path'
import type { Db } from '../lib/db'
import type { IlinkAdapter, IlinkAccount } from './ilink-glue'
import type { Bootstrap } from './bootstrap'
import { isAdmin } from '../lib/access'
import { makeAdminCommands } from './admin-commands'
import { makeModeCommands } from './mode-commands'
import { makeOnboardingHandler } from './onboarding'
import { materializeAttachments } from './media'
import { loadCompanionConfig, saveCompanionConfig } from './companion/config'
import { loadGuardConfig } from './guard/store'
import { buildMemorySnapshot } from './memory/snapshot'
import { buildDetectorContext } from './milestones/build-context'
import { detectMilestones } from './milestones/detector'
import { makeMilestonesStore } from './milestones/store'
import { makeEventsStore } from './events/store'
import { makeActivityStore } from './activity/store'
import { makeObservationsStore } from './observations/store'
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { InboundPipelineDeps } from './inbound/build'
import type { CompanionPushDeps, CompanionIntrospectDeps } from './companion/lifecycle'
import type { SchedulerDeps } from './guard/scheduler'   // NOTE: not GuardSchedulerDeps
import type { SessionsLifecycleDeps } from './sessions-lifecycle'
import type { IlinkLifecycleDeps } from './ilink-lifecycle'
import type { PollingDeps, PollingLifecycle } from './polling-lifecycle'
import type { StartupSweepDeps } from './startup-sweeps'
import type { GuardLifecycle } from './guard/lifecycle'
import { runIntrospectTick } from './companion/introspect'
import { resolveIntrospectChatId, makeIntrospectAgent } from './companion/introspect-runtime'

export interface WireMainOpts {
  stateDir: string
  db: Db
  ilink: IlinkAdapter
  /**
   * Accounts loaded before makeIlinkAdapter — passed separately because
   * IlinkAdapter does not expose the accounts array as a property.
   */
  accounts: IlinkAccount[]
  boot: Bootstrap
  dangerously: boolean
  log: (tag: string, line: string, fields?: Record<string, unknown>) => void
}

export interface WiredDeps {
  pipelineDeps: InboundPipelineDeps
  companionPushDeps: CompanionPushDeps
  companionIntrospectDeps: CompanionIntrospectDeps
  guardDeps: SchedulerDeps
  sessionsDeps: SessionsLifecycleDeps
  ilinkDeps: IlinkLifecycleDeps
  pollingDeps: Omit<PollingDeps, 'runPipeline'>
  startupDeps: StartupSweepDeps
  /**
   * Late-bound references — main.ts populates `.current` after the corresponding
   * lifecycle is registered. wireMain captures these Refs into closures
   * (admin handler's pollHandle, mwGuard's guardState) so the closures see
   * the live handle without circular construction.
   */
  refs: {
    polling: { current: PollingLifecycle | null }
    guard: { current: GuardLifecycle | null }
  }
}

const STARTED_AT_ISO = new Date().toISOString()

function errMsg(err: unknown): string { return err instanceof Error ? err.message : String(err) }

export function wireMain(opts: WireMainOpts): WiredDeps {
  const { stateDir, db, ilink, accounts, boot, log } = opts
  const pollingRef: { current: PollingLifecycle | null } = { current: null }
  const guardRef: { current: GuardLifecycle | null } = { current: null }

  // Closures over per-chat side effects (formerly inline in main.ts)
  async function fireMilestonesFor(chatId: string): Promise<void> {
    const ctx = await buildDetectorContext({ stateDir, chatId, db })
    const memRoot = join(stateDir, 'memory')
    const milestones = makeMilestonesStore(db, chatId, { migrateFromFile: join(memRoot, chatId, 'milestones.jsonl') })
    const events = makeEventsStore(db, chatId, { migrateFromFile: join(memRoot, chatId, 'events.jsonl') })
    const fired = await detectMilestones(milestones, ctx)
    for (const id of fired) {
      await events.append({ kind: 'milestone', trigger: 'detector', reasoning: `milestone ${id} fired`, milestone_id: id })
    }
  }

  async function recordInbound(chatId: string, when: Date): Promise<void> {
    const memRoot = join(stateDir, 'memory')
    const store = makeActivityStore(db, chatId, { migrateFromFile: join(memRoot, chatId, 'activity.jsonl') })
    await store.recordInbound(when)
  }

  async function maybeWriteWelcomeObservation(chatId: string): Promise<void> {
    const memRoot = join(stateDir, 'memory')
    const obs = makeObservationsStore(db, chatId, { migrateFromFile: join(memRoot, chatId, 'observations.jsonl') })
    const existing = await obs.listActive()
    const archived = await obs.listArchived()
    if (existing.length === 0 && archived.length === 0) {
      await obs.append({
        body: '嗨，我是 Claude。我会慢慢理解你，把观察写在这里——你可以随时来翻、纠正、忽略。',
        tone: 'playful',
      })
    }
  }

  async function isolatedSdkEval(prompt: string): Promise<string> {
    const q = query({ prompt, options: { model: 'claude-haiku-4-5', maxTurns: 1 } })
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

  const inboxDir = join(stateDir, 'inbox')
  const launchCwd = process.cwd()

  // Companion push tick body — same logic as legacy main.ts
  async function pushTick(): Promise<void> {
    const cfg = loadCompanionConfig(stateDir)
    if (!cfg.default_chat_id) { log('SCHED', 'skip tick — no default_chat_id'); return }
    const snapshot = ilink.loadProjects()
    const currentAlias = snapshot.current && snapshot.projects[snapshot.current] ? snapshot.current : null
    const proj = currentAlias
      ? { alias: currentAlias, path: snapshot.projects[currentAlias]!.path }
      : { alias: '_default', path: launchCwd }
    const handle = await boot.sessionManager.acquire(proj.alias, proj.path, boot.defaultProviderId)
    const tickText =
      `<companion_tick ts="${new Date().toISOString()}" default_chat_id="${cfg.default_chat_id}" />\n` +
      `定时唤醒。先 memory_list + memory_read 你觉得相关的文件。` +
      `再看当前时间和用户最近状态。决定是否向 ${cfg.default_chat_id} push，或保持沉默。` +
      `不确定就选不打扰。push 后写一条 memory 记下决策和意图（便于下次 tick 读到效果）。`
    try { await handle.dispatch(tickText) }
    catch (err) { log('SCHED', `companion tick dispatch failed: ${errMsg(err)}`) }
  }

  // Companion introspect tick body
  async function introspectTick(): Promise<void> {
    const chatId = resolveIntrospectChatId(stateDir)
    if (!chatId) { log('INTROSPECT', 'skip tick — no default_chat_id'); return }
    const memoryRoot = join(stateDir, 'memory')
    const events = makeEventsStore(db, chatId, { migrateFromFile: join(memoryRoot, chatId, 'events.jsonl') })
    const observations = makeObservationsStore(db, chatId, { migrateFromFile: join(memoryRoot, chatId, 'observations.jsonl') })
    const agent = makeIntrospectAgent({
      chatId, events, observations,
      memorySnapshot: () => buildMemorySnapshot(stateDir, chatId),
      recentInboundMessages: () => Promise.resolve([] as string[]),
      sdkEval: isolatedSdkEval,
    })
    await runIntrospectTick({ events, observations, agent, chatId, log })
    await saveCompanionConfig(stateDir, { ...loadCompanionConfig(stateDir), last_introspect_at: new Date().toISOString() })
  }

  // Build pipelineDeps
  const adminHandler = {
    handle: (msg: Parameters<ReturnType<typeof makeAdminCommands>['handle']>[0]) =>
      adminCommandsHandler.handle(msg),
  }
  const adminCommandsHandler = makeAdminCommands({
    stateDir, isAdmin,
    sessionState: ilink.sessionState,
    // Ref-indirected: pollingRef.current is null at construction time; main.ts
    // populates it after registerPolling(). Closures fire after startup so by
    // the time anyone calls /health the ref is live.
    pollHandle: {
      stopAccount: (id) => pollingRef.current?.stopAccount(id) ?? Promise.resolve(),
      running: () => pollingRef.current?.running() ?? [],
    },
    resolveUserName: (cid) => ilink.resolveUserName(cid),
    sendMessage: (cid, txt) => ilink.sendMessage(cid, txt),
    sharePage: (t, c, o) => ilink.sharePage(t, c, o),
    log,
    startedAt: STARTED_AT_ISO,
  })

  // Silence unused variable warning — adminHandler is declared for symmetry
  // with legacy main.ts structure; pipelineDeps wires adminCommandsHandler directly.
  void adminHandler

  const modeHandler = makeModeCommands({
    coordinator: boot.coordinator,
    registry: boot.registry,
    defaultProviderId: boot.defaultProviderId,
    sendMessage: (cid, txt) => ilink.sendMessage(cid, txt),
    log,
  })

  const onboardingHandler = makeOnboardingHandler({
    isKnownUser: (uid) => ilink.resolveUserName(uid) !== undefined,
    setUserName: (cid, name) => ilink.setUserName(cid, name),
    sendMessage: async (cid, txt) => { await ilink.sendMessage(cid, txt) },
    log,
  })

  const pipelineDeps: InboundPipelineDeps = {
    trace: { log },
    capture: {
      markChatActive: (c, a) => ilink.markChatActive(c, a),
      captureContextToken: (c, t) => ilink.captureContextToken(c, t),
    },
    typing: { sendTyping: (c, a) => ilink.sendTyping(c, a) },
    admin: { adminHandler: adminCommandsHandler },
    mode: { modeHandler },
    onboarding: { onboardingHandler },
    permissionReply: {
      handlePermissionReply: (text: string) => ilink.handlePermissionReply(text),
      log,
    },
    guard: {
      guardEnabled: () => loadGuardConfig(stateDir).enabled,
      guardState: () => guardRef.current?.current() ?? { reachable: true, ip: null },
      sendMessage: (c, t) => ilink.sendMessage(c, t).then(r => r as { msgId: string }),
      log,
    },
    attachments: { materializeAttachments, inboxDir, log },
    activity: { recordInbound, log },
    milestone: { fireMilestonesFor, log },
    welcome: { maybeWriteWelcomeObservation, log },
    dispatch: { coordinator: { dispatch: (msg) => boot.coordinator.dispatch(msg) } },
  }

  return {
    pipelineDeps,
    companionPushDeps: {
      isEnabled: () => loadCompanionConfig(stateDir).enabled,
      isSnoozed: () => {
        const s = loadCompanionConfig(stateDir).snooze_until
        return !!s && Date.parse(s) > Date.now()
      },
      log,
      onTick: pushTick,
    },
    companionIntrospectDeps: {
      isEnabled: () => loadCompanionConfig(stateDir).enabled,
      isSnoozed: () => {
        const s = loadCompanionConfig(stateDir).snooze_until
        return !!s && Date.parse(s) > Date.now()
      },
      log,
      onTick: introspectTick,
    },
    guardDeps: {
      pollMs: 30_000,
      isEnabled: () => loadGuardConfig(stateDir).enabled,
      probeUrl: () => loadGuardConfig(stateDir).probe_url,
      ipifyUrl: () => loadGuardConfig(stateDir).ipify_url,
      log,
      onStateChange: async (prev, next) => {
        if (prev.reachable && !next.reachable) {
          log('GUARD', `network DOWN — shutting down all sessions (was ${prev.ip}, now ${next.ip})`)
          await boot.sessionManager.shutdown()
        }
      },
    },
    sessionsDeps: {
      sessionManager: boot.sessionManager,
      sessionStore: boot.sessionStore,
      conversationStore: boot.conversationStore,
    },
    ilinkDeps: { ilink: { flush: () => ilink.flush() } },
    pollingDeps: {
      stateDir,
      accounts,
      ilink: {
        getUpdates: (id, base, tok, sb) =>
          ilink.getUpdatesForLoop(id, base, tok, sb ?? '') as ReturnType<PollingDeps['ilink']['getUpdates']>,
      },
      parse: (raws) => raws as never,  // parseUpdates re-exported from poll-loop
      resolveUserName: (cid) => ilink.resolveUserName(cid),
      log,
    },
    startupDeps: {
      stateDir, db, ilink, log,
      runIntrospectOnce: introspectTick,
    },
    refs: { polling: pollingRef, guard: guardRef },
  }
}
