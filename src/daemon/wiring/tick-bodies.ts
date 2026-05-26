/**
 * Companion scheduler tick bodies — pushTick (20m interval) + introspectTick (24h).
 *
 * Both have real branching logic (config gates, project resolution, store access),
 * so they earn their own file vs side-effects.ts which is pure helper factories.
 */
import { join } from 'node:path'
import type { Db } from '../../lib/db'
import type { IlinkAdapter } from '../ilink-glue'
import type { Bootstrap } from '../bootstrap'
import { loadCompanionConfig, saveCompanionConfig } from '../companion/config'
import { buildMemorySnapshot } from '../memory/snapshot'
import { makeEventsStore } from '../events/store'
import { makeObservationsStore } from '../observations/store'
import { runIntrospectTick } from '../companion/introspect'
import { resolveIntrospectChatId, makeIntrospectAgent } from '../companion/introspect-runtime'
import { resolveEffectiveTier, TIER_PROFILES } from '../../core/user-tier'
import type { Access } from '../../lib/access'
import type { PermissionMode } from '../../core/capability-matrix'

function errMsg(err: unknown): string { return err instanceof Error ? err.message : String(err) }

export interface TickDeps {
  stateDir: string
  db: Db
  ilink: IlinkAdapter
  boot: Bootstrap
  /**
   * Task 11 — companion ticks aren't user-initiated, but the session
   * they acquire is still keyed by `chatId` (the configured
   * `default_chat_id`). Resolving the tier of that chat lets us reuse
   * the same per-chat session isolation as user-initiated dispatch.
   * Typically resolves to admin (operator's own chatId); a non-admin
   * `default_chat_id` is a misconfiguration the tick surfaces via log.
   */
  loadAccess: () => Access
  /**
   * Daemon-wide permission mode. When 'dangerously', the companion tick
   * promotes the resolved tier to admin so the operator's `--dangerously`
   * intent applies to background ticks as well as user-initiated dispatch.
   */
  permissionMode: PermissionMode
  log: (tag: string, line: string, fields?: Record<string, unknown>) => void
}

export interface TickBodies {
  pushTick: (opts?: { nowIso?: string }) => Promise<void>
  introspectTick: (opts?: { nowIso?: string }) => Promise<void>  // introspect ignores nowIso for MVP — keeps signatures symmetric
}

export interface BuildPushTickTextOpts {
  nowIso: string
  defaultChatId: string
}

/**
 * Pure helper — assembles the push-tick envelope text. Extracted from
 * pushTick so the eval harness can drive the body with a virtual `ts`
 * without going through the scheduler. Production code path is unchanged.
 */
export function buildPushTickText(opts: BuildPushTickTextOpts): string {
  return (
    `<companion_tick ts="${opts.nowIso}" default_chat_id="${opts.defaultChatId}" />\n` +
    `定时唤醒。先 memory_list + memory_read 你觉得相关的文件。` +
    `再看当前时间和用户最近状态。决定是否向 ${opts.defaultChatId} push。` +
    `\n\n要 push：调 reply 工具，内容就是要发给用户的话。` +
    `\n不 push：直接结束这一轮，**不调用 reply**，**也不产生任何 assistant text**——不要解释你为什么不打扰、不要总结你看到的状态。沉默就是沉默。` +
    `\n不确定就选不 push（结束）。push 后写一条 memory 记下决策和意图（便于下次 tick 读到效果）。`
  )
}

export function buildTickBodies(deps: TickDeps): TickBodies {
  const launchCwd = process.cwd()

  async function pushTick(opts?: { nowIso?: string }): Promise<void> {
    const cfg = loadCompanionConfig(deps.stateDir)
    if (!cfg.default_chat_id) { deps.log('SCHED', 'skip tick — no default_chat_id'); return }
    const snapshot = deps.ilink.loadProjects()
    const currentAlias = snapshot.current && snapshot.projects[snapshot.current] ? snapshot.current : null
    const proj = currentAlias
      ? { alias: currentAlias, path: snapshot.projects[currentAlias]!.path }
      : { alias: '_default', path: launchCwd }
    // PR D — don't contend with an in-flight user-initiated dispatch on
    // the same (alias, providerId, chatId) session. Companion pushes are
    // best-effort background work — skipping a tick when the user is
    // mid-conversation is strictly better than queueing behind their
    // turn (push would land delayed and disrupt the user's flow) or
    // forking a parallel turn against the same session (the providers
    // serialise inside the SDK; result would be either rejection or
    // unpredictable interleaving). Plan recommends skip + warn over
    // abort because aborting the user's turn for a push tick is
    // user-hostile.
    // Task 11 — chatId is now `cfg.default_chat_id`, so this isInFlight
    // check shares the same per-chat session bucket as user-initiated
    // dispatch for that chat. Tier comes from access.json so a
    // misconfigured default_chat_id (pointing at a non-admin) runs with
    // reduced capabilities rather than silently inheriting admin.
    const chatId = cfg.default_chat_id
    const tier = resolveEffectiveTier(chatId, deps.loadAccess(), deps.permissionMode)
    if (tier !== 'admin') {
      deps.log('COMPANION', `default_chat_id=${chatId} is non-admin tier (${tier}); push tick will run with reduced capabilities`)
    }
    const tierProfile = TIER_PROFILES[tier]
    if (deps.boot.sessionManager.isInFlight({ alias: proj.alias, providerId: deps.boot.defaultProviderId, chatId })) {
      deps.log('SCHED', `[companion] skipping push tick: user session in-flight (alias=${proj.alias} provider=${deps.boot.defaultProviderId} chat=${chatId})`)
      return
    }
    const handle = await deps.boot.sessionManager.acquire({
      alias: proj.alias,
      path: proj.path,
      providerId: deps.boot.defaultProviderId,
      chatId,
      tierProfile,
    })
    const tickText = buildPushTickText({
      nowIso: opts?.nowIso ?? new Date().toISOString(),
      defaultChatId: cfg.default_chat_id,
    })
    // `handle.dispatch` returns AsyncIterable<AgentEvent>, not a Promise —
    // `await` alone is a no-op (it resolves to the iterable itself without
    // ever calling .next()). The wrapper's enter/finally hooks (inFlight
    // counter increment, sessionStore.set on result, droppedAssistantChunks
    // accounting) live inside the generator body and only run when the
    // consumer iterates. Drain the iterable so those hooks fire.
    try {
      for await (const _ev of handle.dispatch(tickText)) { /* drain */ }
    } catch (err) {
      deps.log('SCHED', `companion tick dispatch failed: ${errMsg(err)}`)
    }
  }

  async function introspectTick(_opts?: { nowIso?: string }): Promise<void> {
    // _opts.nowIso ignored for MVP — observations/memory internal timestamps
    // stay wall-clock. Keeping the symmetric signature avoids churn when
    // introspect virtual time is added later.
    const chatId = resolveIntrospectChatId(deps.stateDir)
    if (!chatId) { deps.log('INTROSPECT', 'skip tick — no default_chat_id'); return }
    // PR F — resolve cheap eval via the registry. Picks the cheapest
    // available provider (claude haiku, then codex-mini, then anything
    // else registered). null if no registered provider implements
    // cheapEval → skip the tick with a log line instead of hard-failing.
    //
    // Per-tick resolution (not boot-time) is forward-looking for a
    // future where ProviderRegistry supports hot registration; TODAY a
    // user installing a new provider still needs to restart the daemon
    // (registry is built once at bootstrap) AND the codex provider's
    // cheapModel was resolved at provider construction so `codex login`
    // unlocking a cheaper tier requires a restart too.
    const sdkEval = deps.boot.registry.getCheapEval()
    if (!sdkEval) {
      deps.log('INTROSPECT', 'skip tick — no registered provider implements cheapEval')
      return
    }
    const memoryRoot = join(deps.stateDir, 'memory')
    const events = makeEventsStore(deps.db, chatId, { migrateFromFile: join(memoryRoot, chatId, 'events.jsonl') })
    const observations = makeObservationsStore(deps.db, chatId, { migrateFromFile: join(memoryRoot, chatId, 'observations.jsonl') })
    const agent = makeIntrospectAgent({
      chatId, events, observations,
      memorySnapshot: () => buildMemorySnapshot(deps.stateDir, chatId),
      // Matches legacy main.ts v0.4.1 — recentInboundForChat() also returned [].
      recentInboundMessages: () => Promise.resolve([] as string[]),
      sdkEval,
    })
    await runIntrospectTick({ events, observations, agent, chatId, log: deps.log })
    await saveCompanionConfig(deps.stateDir, { ...loadCompanionConfig(deps.stateDir), last_introspect_at: new Date().toISOString() })
  }

  return { pushTick, introspectTick }
}
