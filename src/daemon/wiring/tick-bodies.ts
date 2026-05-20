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
import { makeIsolatedSdkEval } from './side-effects'

function errMsg(err: unknown): string { return err instanceof Error ? err.message : String(err) }

export interface TickDeps {
  stateDir: string
  db: Db
  ilink: IlinkAdapter
  boot: Bootstrap
  log: (tag: string, line: string, fields?: Record<string, unknown>) => void
}

export interface TickBodies {
  pushTick: () => Promise<void>
  introspectTick: () => Promise<void>
}

export function buildTickBodies(deps: TickDeps): TickBodies {
  const launchCwd = process.cwd()
  const isolatedSdkEval = makeIsolatedSdkEval()

  async function pushTick(): Promise<void> {
    const cfg = loadCompanionConfig(deps.stateDir)
    if (!cfg.default_chat_id) { deps.log('SCHED', 'skip tick — no default_chat_id'); return }
    const snapshot = deps.ilink.loadProjects()
    const currentAlias = snapshot.current && snapshot.projects[snapshot.current] ? snapshot.current : null
    const proj = currentAlias
      ? { alias: currentAlias, path: snapshot.projects[currentAlias]!.path }
      : { alias: '_default', path: launchCwd }
    // PR D — don't contend with an in-flight user-initiated dispatch on
    // the same (alias, providerId) session. Companion pushes are
    // best-effort background work — skipping a tick when the user is
    // mid-conversation is strictly better than queueing behind their
    // turn (push would land delayed and disrupt the user's flow) or
    // forking a parallel turn against the same session (the providers
    // serialise inside the SDK; result would be either rejection or
    // unpredictable interleaving). Plan recommends skip + warn over
    // abort because aborting the user's turn for a push tick is
    // user-hostile.
    if (deps.boot.sessionManager.isInFlight(proj.alias, deps.boot.defaultProviderId)) {
      deps.log('SCHED', `[companion] skipping push tick: user session in-flight (alias=${proj.alias} provider=${deps.boot.defaultProviderId})`)
      return
    }
    const handle = await deps.boot.sessionManager.acquire(proj.alias, proj.path, deps.boot.defaultProviderId)
    const tickText =
      `<companion_tick ts="${new Date().toISOString()}" default_chat_id="${cfg.default_chat_id}" />\n` +
      `定时唤醒。先 memory_list + memory_read 你觉得相关的文件。` +
      `再看当前时间和用户最近状态。决定是否向 ${cfg.default_chat_id} push。` +
      `\n\n要 push：调 reply 工具，内容就是要发给用户的话。` +
      `\n不 push：直接结束这一轮，**不调用 reply**，**也不产生任何 assistant text**——不要解释你为什么不打扰、不要总结你看到的状态。沉默就是沉默。` +
      `\n不确定就选不 push（结束）。push 后写一条 memory 记下决策和意图（便于下次 tick 读到效果）。`
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

  async function introspectTick(): Promise<void> {
    const chatId = resolveIntrospectChatId(deps.stateDir)
    if (!chatId) { deps.log('INTROSPECT', 'skip tick — no default_chat_id'); return }
    const memoryRoot = join(deps.stateDir, 'memory')
    const events = makeEventsStore(deps.db, chatId, { migrateFromFile: join(memoryRoot, chatId, 'events.jsonl') })
    const observations = makeObservationsStore(deps.db, chatId, { migrateFromFile: join(memoryRoot, chatId, 'observations.jsonl') })
    const agent = makeIntrospectAgent({
      chatId, events, observations,
      memorySnapshot: () => buildMemorySnapshot(deps.stateDir, chatId),
      // Matches legacy main.ts v0.4.1 — recentInboundForChat() also returned [].
      recentInboundMessages: () => Promise.resolve([] as string[]),
      sdkEval: isolatedSdkEval,
    })
    await runIntrospectTick({ events, observations, agent, chatId, log: deps.log })
    await saveCompanionConfig(deps.stateDir, { ...loadCompanionConfig(deps.stateDir), last_introspect_at: new Date().toISOString() })
  }

  return { pushTick, introspectTick }
}
