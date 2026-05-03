import { join } from 'node:path'
import type { Db } from '../lib/db'
import type { IlinkAdapter } from './ilink-glue'
import { cleanupOldInbox } from './media'
import { loadCompanionConfig } from './companion/config'
import { loadAccess } from '../lib/access'
import { notifyStartup } from './notify-startup'
import { buildDetectorContext } from './milestones/build-context'
import { detectMilestones } from './milestones/detector'
import { makeMilestonesStore } from './milestones/store'
import { makeEventsStore } from './events/store'

export interface StartupSweepDeps {
  stateDir: string
  db: Db
  ilink: IlinkAdapter
  log: (tag: string, line: string) => void
  /** Bound account count for the startup notification text (admins see "accounts=N"). */
  accountCount: number
  /** `--dangerously` flag for the startup notification mode string. */
  dangerously: boolean
  /** introspect tick body — invoked if 24h+ since last */
  runIntrospectOnce: () => Promise<void>
}

/**
 * Fire-and-forget all startup sweeps. Returns immediately; failures are
 * logged but never thrown. Does NOT block daemon ready.
 */
export function runStartupSweeps(deps: StartupSweepDeps): void {
  void runMilestoneSweep(deps)
  void runInboxCleanup(deps)
  void runStartupNotify(deps)
  void runIntrospectCatchUp(deps)
}

async function runMilestoneSweep(deps: StartupSweepDeps): Promise<void> {
  try {
    const bootChatId = loadCompanionConfig(deps.stateDir).default_chat_id
    if (!bootChatId) return
    const ctx = await buildDetectorContext({ stateDir: deps.stateDir, chatId: bootChatId, db: deps.db })
    const memRoot = join(deps.stateDir, 'memory')
    const milestones = makeMilestonesStore(deps.db, bootChatId, {
      migrateFromFile: join(memRoot, bootChatId, 'milestones.jsonl'),
    })
    const events = makeEventsStore(deps.db, bootChatId, {
      migrateFromFile: join(memRoot, bootChatId, 'events.jsonl'),
    })
    const fired = await detectMilestones(milestones, ctx)
    for (const id of fired) {
      await events.append({ kind: 'milestone', trigger: 'detector', reasoning: `milestone ${id} fired (boot sweep)`, milestone_id: id })
    }
  } catch (err) {
    deps.log('MILESTONE', `boot sweep failed: ${err instanceof Error ? err.message : err}`)
  }
}

async function runInboxCleanup(deps: StartupSweepDeps): Promise<void> {
  try {
    const inboxDir = join(deps.stateDir, 'inbox')
    const removed = cleanupOldInbox(inboxDir)
    if (removed > 0) deps.log('INBOX', `cleaned ${removed} files older than 30 days`)
  } catch (err) {
    deps.log('INBOX', `cleanup failed: ${err instanceof Error ? err.message : err}`)
  }
}

async function runStartupNotify(deps: StartupSweepDeps): Promise<void> {
  try {
    await notifyStartup(
      {
        stateDir: deps.stateDir,
        loadAccess: () => {
          const a = loadAccess()
          return { allowFrom: a.allowFrom, admins: a.admins }
        },
        send: (cid, txt) => deps.ilink.sendMessage(cid, txt),
        log: deps.log,
      },
      { pid: process.pid, accounts: deps.accountCount, dangerously: deps.dangerously },
    )
  } catch (err) {
    deps.log('NOTIFY', `unhandled: ${err instanceof Error ? err.message : err}`)
  }
}

async function runIntrospectCatchUp(deps: StartupSweepDeps): Promise<void> {
  try {
    const cfg = loadCompanionConfig(deps.stateDir)
    if (!cfg.enabled) return
    const snooze = cfg.snooze_until
    if (snooze && Date.parse(snooze) > Date.now()) return
    const last = cfg.last_introspect_at
    if (last && Date.now() - Date.parse(last) < 24 * 60 * 60 * 1000) return
    await deps.runIntrospectOnce()
    deps.log('INTROSPECT', 'startup tick fired')
  } catch (err) {
    deps.log('INTROSPECT', `startup tick failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}
