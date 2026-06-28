/**
 * Pipeline dep builder — admin/mode/onboarding handler construction +
 * 13-mw deps assembly into InboundPipelineDeps.
 *
 * Refs are passed in for late-bound polling/guard access from closures.
 */
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import type { Ref } from '../../lib/lifecycle'
import type { IlinkAdapter } from '../ilink-glue'
import type { Bootstrap } from '../bootstrap'
import type { GuardLifecycle } from '../guard/lifecycle'
import type { PollingLifecycle } from '../polling-lifecycle'
import type { InboundPipelineDeps } from '../inbound/build'
import type { PipelineRun } from '../inbound/types'
import { isAdmin, loadAccess } from '../../lib/access'
import { makeAdminCommands } from '../admin-commands'
import { makeModeCommands } from '../mode-commands'
import { makeOnboardingHandler } from '../onboarding'
import { botName, botNameFromModeFallback } from '../bot-name'
import { loadAgentConfig, saveAgentConfig } from '../../lib/agent-config'
import { findOnPath } from '../../lib/util'
import type { A2AAgentRecord } from '../../lib/agent-config'
import { materializeAttachments } from '../media'
import { loadGuardConfig } from '../guard/store'
import { makeFireMilestonesFor, makeRecordInbound, makeMaybeWriteWelcomeObservation } from './side-effects'
import { makeMessagesStore } from '../../lib/messages-store'
import { makeDedupStore } from '../../lib/dedup-store'
import type { YiHub, YiDispatch } from '../../core/yi-hub'
import type { ExecResult } from '../../core/a2a-server'

export interface DelegateDeps {
  listHands: () => readonly A2AAgentRecord[]
  hub: Pick<YiHub, 'dispatchTask' | 'isConnected'>
  pushDelegate: (hand: A2AAgentRecord, task: YiDispatch, selfId: string, timeoutMs: number) => Promise<ExecResult>
  selfId: string
  timeoutMs: number
}

export function makeDelegateToHand(deps: DelegateDeps) {
  return async (handName: string, task: string): Promise<ExecResult & { knownHands?: string[] }> => {
    const hands = deps.listHands().filter(a => a.capabilities?.includes('exec'))
    const hand = hands.find(a => a.id === handName || a.name === handName)
    if (!hand) return { ok: false, reason: 'unknown_hand', knownHands: hands.map(a => a.name || a.id) }
    const dispatch: YiDispatch = { peer: 'claude', prompt: task }
    if (hand.transport === 'ws') return deps.hub.dispatchTask(hand.id, dispatch, deps.timeoutMs)
    return deps.pushDelegate(hand, dispatch, deps.selfId, deps.timeoutMs)
  }
}

export interface PipelineDepsOpts {
  stateDir: string
  db: import('../../lib/db').Db
  ilink: IlinkAdapter
  boot: Bootstrap
  log: (tag: string, line: string, fields?: Record<string, unknown>) => void
}

export interface PipelineDepsRefs {
  polling: Ref<PollingLifecycle>
  guard: Ref<GuardLifecycle>
  pipeline: Ref<PipelineRun>
}

const STARTED_AT_ISO = new Date().toISOString()
const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..', '..', '..')
const CLI_ENTRY = join(REPO_ROOT, 'cli.ts')

export function buildPipelineDeps(opts: PipelineDepsOpts, refs: PipelineDepsRefs): { pipelineDeps: InboundPipelineDeps } {
  const { stateDir, db, ilink, boot, log } = opts
  const inboxDir = join(stateDir, 'inbox')

  // A2A exec (delegate a task to a hand) runs a FULL agent on the hand —
  // often tens of seconds to minutes. The shared a2aDeps.client's 10s timeout
  // is tuned for notify/send; exec needs a long one. Lazily built + reused.
  let execA2AClient: import('../../core/a2a-client').A2AClient | undefined

  const fireMilestonesFor = makeFireMilestonesFor({ stateDir, db })

  // Disk-first then mutate: if saveAgentConfig throws (EACCES, ENOSPC),
  // the in-memory boot.agentConfig stays untouched so callers can retry.
  // Mutate via index access so existing readers (who hold the same object
  // reference) see the new value on next lookup.
  //
  // Read fresh from disk before merging: another process (CLI
  // `wechat-cc agent add`, the dashboard install route, a future
  // a2a-registry mutation) may have written to agent-config.json
  // since boot. Using the boot-time snapshot here would clobber
  // those fields. Read → spread → write keeps a2a_agents and any
  // other fields written by sibling processes intact.
  const setBotName = async (name: string | null): Promise<void> => {
    const current = loadAgentConfig(stateDir)
    const next: typeof current = { ...current, bot_name: name }
    await saveAgentConfig(stateDir, next)
    boot.agentConfig.bot_name = name
  }
  const getBotName = (): string | null => boot.agentConfig.bot_name ?? null

  const recordInbound = makeRecordInbound({ stateDir, db })
  const messagesStore = makeMessagesStore(db)
  const dedupStore = makeDedupStore(db)
  const maybeWriteWelcomeObservation = makeMaybeWriteWelcomeObservation({
    stateDir,
    db,
    agentConfig: boot.agentConfig,
    getMode: (cid) => boot.coordinator.getMode(cid),
  })

  const adminCommandsHandler = makeAdminCommands({
    stateDir, isAdmin,
    sessionState: ilink.sessionState,
    pollHandle: {
      stopAccount: (id) => refs.polling.current?.stopAccount(id) ?? Promise.resolve(),
      stopAccountAndWait: async (id) => { await refs.polling.current?.stopAccountAndWait(id) },
      running: () => refs.polling.current?.running() ?? [],
    },
    resolveUserName: (cid) => ilink.resolveUserName(cid),
    sendMessage: (cid, txt) => ilink.sendMessage(cid, txt),
    sharePage: (t, c, o) => ilink.sharePage(t, c, o),
    // /reset and /health ai need to see the same registry/sessionManager/
    // sessionStore the coordinator drives — that's how dropping a session
    // here is visible on the next inbound dispatch.
    resolveProject: boot.resolve,
    registry: boot.registry,
    sessionManager: boot.sessionManager,
    sessionStore: boot.sessionStore,
    log,
    startedAt: STARTED_AT_ISO,
    getBotName,
    setBotName,
    botNameFallback: (cid) => botNameFromModeFallback(boot.coordinator.getMode(cid)),
    synthesizeMemory: async (adminChatId) => {
      const { synthesizeOverview } = await import('../../lib/memory-synthesis')
      const { makeLifeStoresReader } = await import('../life-stores')
      // Follow the admin conversation's provider (decided design); fall back
      // to the registry's cheapest eval when the mode isn't solo / unknown.
      const mode = boot.coordinator.getMode(adminChatId)
      const provider = mode && mode.kind === 'solo' ? mode.provider : undefined
      const cheapEval = (provider ? boot.registry.get(provider)?.provider.cheapEval : null) ?? boot.registry.getCheapEval()
      if (!cheapEval) throw new Error('no LLM provider available for synthesis')
      // Bridge the daemon db → life stores so the overview also folds in the
      // life-side memory (kept on the daemon side of the cli/daemon boundary).
      return synthesizeOverview({ stateDir, adminChatId, sdkEval: (p) => cheapEval(p), lifeStores: makeLifeStoresReader(db, stateDir), includeFileSurvey: true })
    },
    // Read back the synthesized overview so the admin can see what the bot
    // understands about them ("看记忆" / "你对我的理解" from WeChat).
    readOverview: async (adminChatId) => {
      const { readFile } = await import('node:fs/promises')
      const { OVERVIEW_FILENAME } = await import('../../lib/memory-synthesis')
      try { return await readFile(join(stateDir, 'memory', adminChatId, OVERVIEW_FILENAME), 'utf8') }
      catch { return null }
    },
    // Delegate a task to a registered "hand" (another machine running wechat-cc
    // with A2A exec). Resolves the hand by id or name, routes ws hands through
    // the hub and push hands via HTTP /a2a/exec (one-brain-many-hands).
    delegateToHand: async (handName, task) => {
      const a2a = boot.a2aDeps
      if (!a2a) return { ok: false as const, reason: 'A2A 未启用(agent-config 没配 a2a_listen / 没注册手)' }
      const selfId = process.env.WECHAT_A2A_SELF_ID || 'wechat-cc'
      const timeoutMs = Number(process.env.WECHAT_A2A_EXEC_TIMEOUT_MS) || 300_000
      // Stub hub: when Part B hasn't wired yiHub yet, ws hands fall back to
      // a graceful offline error rather than crashing.
      const stubHub: Pick<YiHub, 'dispatchTask' | 'isConnected'> = {
        dispatchTask: () => Promise.resolve({ ok: false, reason: 'ws_hub_unavailable' }),
        isConnected: () => false,
      }
      const hub = (boot as { yiHub?: Pick<YiHub, 'dispatchTask' | 'isConnected'> }).yiHub ?? stubHub
      return makeDelegateToHand({
        listHands: () => a2a.registry.list(),
        hub,
        pushDelegate: async (hand, dispatch, sid, tms) => {
          const { delegateToHand: doDelegate } = await import('../../core/a2a-delegate')
          const { createA2AClient } = await import('../../core/a2a-client')
          execA2AClient ??= createA2AClient({ timeoutMs: tms })
          return doDelegate(execA2AClient, { hand, selfId: sid, prompt: dispatch.prompt })
        },
        selfId,
        timeoutMs,
      })(handName, task)
    },
    updateSelf: async () => {
      if (!existsSync(CLI_ENTRY)) return { ok: false as const, reason: 'source_cli_not_found' }
      const bun = findOnPath('bun')
      if (!bun) return { ok: false as const, reason: 'bun_not_found' }
      const child = spawn(bun, [CLI_ENTRY, 'update', '--json'], {
        cwd: REPO_ROOT,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: process.env,
      })
      child.unref()
      return { ok: true as const, pid: child.pid }
    },
  })

  const modeHandler = makeModeCommands({
    coordinator: boot.coordinator,
    registry: boot.registry,
    defaultProviderId: boot.defaultProviderId,
    agentConfig: boot.agentConfig,
    sendMessage: (cid, txt) => ilink.sendMessage(cid, txt),
    setUserName: (cid, name) => ilink.setUserName(cid, name),
    getUserName: (cid) => ilink.resolveUserName(cid) ?? null,
    log,
    isAdmin,
  })

  const onboardingHandler = makeOnboardingHandler({
    isKnownUser: (uid) => ilink.resolveUserName(uid) !== undefined,
    setUserName: (cid, name) => ilink.setUserName(cid, name),
    sendMessage: async (cid, txt) => { await ilink.sendMessage(cid, txt) },
    botName: (cid) => botName(boot.coordinator.getMode(cid), boot.agentConfig),
    dispatchInbound: async (msg) => {
      // Re-fire this inbound through the normal pipeline. Onboarding has
      // already cleared its awaiting state and persisted the nickname, so
      // mw-onboarding will short-circuit (isKnownUser=true) and the message
      // flows to the provider as if it were just received.
      await refs.pipeline.deref('onboarding echo dispatch')({
        msg,
        receivedAtMs: Date.now(),
        requestId: randomBytes(4).toString('hex'),
      })
    },
    log,
    isAdmin,
    getBotName,
    setBotName,
  })

  const pipelineDeps: InboundPipelineDeps = {
    trace: { log },
    identity: {
      upsertIdentity: (cid, ids) => boot.conversationStore.upsertIdentity(cid, ids),
    },
    access: {
      // loadAccess() has a 5s in-process TTL cache — safe to call per inbound.
      loadAccess,
      log,
    },
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
      guardState: () => refs.guard.current?.current() ?? { reachable: true, ip: null },
      sendMessage: (c, t) => ilink.sendMessage(c, t).then(r => r as { msgId: string }),
      log,
    },
    attachments: { materializeAttachments, inboxDir, log },
    dedup: {
      isHandled: id => dedupStore.isHandled(id),
      markHandled: id => dedupStore.markHandled(id, new Date().toISOString()),
      recordAttempt: id => dedupStore.recordAttempt(id, new Date().toISOString()),
      log,
    },
    messages: {
      append: rec => messagesStore.append(rec),
      log,
    },
    activity: { recordInbound, log },
    milestone: { fireMilestonesFor, log },
    welcome: { maybeWriteWelcomeObservation, log },
    dispatch: { coordinator: { dispatch: (msg) => boot.coordinator.dispatch(msg) } },
  }

  return { pipelineDeps }
}
