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
import { makeMemoryFS } from '../memory/fs-api'
import { parseAgenda, selectDue, markResolved } from '../companion/agenda'

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
  /** The due intention body the tick is firing — the concrete reason to reach out. */
  intention: string
}

/**
 * Pure helper — assembles the push-tick envelope text. Extracted from
 * pushTick so the eval harness can drive the body with a virtual `ts`
 * without going through the scheduler. Production code path is unchanged.
 */
export function buildPushTickText(opts: BuildPushTickTextOpts): string {
  return (
    `<companion_tick ts="${opts.nowIso}" default_chat_id="${opts.defaultChatId}" />\n` +
    `有一条到点的跟进：「${opts.intention}」\n` +
    `先 memory_read 相关 .md，确认它没过期、用户也没自己说过结果。\n` +
    `默认就是发：调 reply 写一句简短、自然的问候（别催、别灌鸡汤）。\n` +
    `只有明显已过期、或用户已经自己说过结果时才不发——那就直接结束这一轮，不调用 reply，也不要产生任何 assistant text。`
  )
}

export function buildTickBodies(deps: TickDeps): TickBodies {
  const launchCwd = process.cwd()

  async function pushTick(opts?: { nowIso?: string }): Promise<void> {
    const cfg = loadCompanionConfig(deps.stateDir)
    if (!cfg.default_chat_id) { deps.log('SCHED', 'skip tick — no default_chat_id'); return }
    const chatId = cfg.default_chat_id

    // Gate on the agenda: only wake the agent if a self-authored intention is
    // due. No due item → silent, WITHOUT an LLM call (the common case).
    const nowIso = opts?.nowIso ?? new Date().toISOString()
    const today = nowIso.slice(0, 10)
    const agendaFs = makeMemoryFS({ rootDir: join(deps.stateDir, 'memory', chatId) })
    const agendaMd = agendaFs.read('agenda.md') ?? ''
    const due = selectDue(parseAgenda(agendaMd), today)
    if (due.length === 0) { deps.log('SCHED', 'push tick — no due intentions'); return }
    // Fire the single oldest-due item this tick; the rest wait for later ticks.
    const item = [...due].sort((a, b) => (a.due! < b.due! ? -1 : a.due! > b.due! ? 1 : 0))[0]!

    const snapshot = deps.ilink.loadProjects()
    const currentAlias = snapshot.current && snapshot.projects[snapshot.current] ? snapshot.current : null
    const proj = currentAlias
      ? { alias: currentAlias, path: snapshot.projects[currentAlias]!.path }
      : { alias: '_default', path: launchCwd }
    const tier = resolveEffectiveTier(chatId, deps.loadAccess(), deps.permissionMode)
    if (tier !== 'admin') {
      deps.log('COMPANION', `default_chat_id=${chatId} is non-admin tier (${tier}); push tick will run with reduced capabilities`)
    }
    const tierProfile = TIER_PROFILES[tier]
    if (deps.boot.sessionManager.isInFlight({ alias: proj.alias, providerId: deps.boot.defaultProviderId, chatId })) {
      deps.log('SCHED', `[companion] skipping push tick: user session in-flight (alias=${proj.alias} provider=${deps.boot.defaultProviderId} chat=${chatId})`)
      return // leave the item pending — retry next tick
    }
    const handle = await deps.boot.sessionManager.acquire({
      alias: proj.alias,
      path: proj.path,
      providerId: deps.boot.defaultProviderId,
      chatId,
      tierProfile,
      permissionMode: deps.permissionMode,
    })
    const tickText = buildPushTickText({ nowIso, defaultChatId: chatId, intention: item.body })
    try {
      for await (const _ev of handle.dispatch(tickText)) { /* drain */ }
    } catch (err) {
      deps.log('SCHED', `companion tick dispatch failed: ${errMsg(err)}`)
      return // dispatch failed — leave pending, retry next tick
    }
    // Resolve so the item fires at most once. Re-read first: the agent may have
    // edited agenda.md during dispatch (added new intentions) — markResolved
    // matches the original line and preserves any additions.
    const freshMd = agendaFs.read('agenda.md') ?? agendaMd
    const updated = markResolved(freshMd, item, today)
    if (updated !== freshMd) agendaFs.write('agenda.md', updated)
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
