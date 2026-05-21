/**
 * Side-effect closure factories — store-construction helpers + isolated SDK eval.
 *
 * Each factory closes over `stateDir` + `db` and returns a per-chat closure.
 * Used by both pipeline mw deps (mwActivity, mwMilestone, mwWelcome) and
 * startup-sweeps (boot milestone sweep, introspect catch-up).
 */
import { join } from 'node:path'
import type { Db } from '../../lib/db'
import { buildDetectorContext } from '../milestones/build-context'
import { detectMilestones } from '../milestones/detector'
import { makeMilestonesStore } from '../milestones/store'
import { makeEventsStore } from '../events/store'
import { makeActivityStore } from '../activity/store'
import { makeObservationsStore } from '../observations/store'

export interface SideEffectDeps {
  stateDir: string
  db: Db
}

export function makeFireMilestonesFor(deps: SideEffectDeps): (chatId: string) => Promise<void> {
  return async (chatId: string) => {
    const ctx = await buildDetectorContext({ stateDir: deps.stateDir, chatId, db: deps.db })
    const memRoot = join(deps.stateDir, 'memory')
    const milestones = makeMilestonesStore(deps.db, chatId, { migrateFromFile: join(memRoot, chatId, 'milestones.jsonl') })
    const events = makeEventsStore(deps.db, chatId, { migrateFromFile: join(memRoot, chatId, 'events.jsonl') })
    const fired = await detectMilestones(milestones, ctx)
    for (const id of fired) {
      await events.append({ kind: 'milestone', trigger: 'detector', reasoning: `milestone ${id} fired`, milestone_id: id })
    }
  }
}

export function makeRecordInbound(deps: SideEffectDeps): (chatId: string, when: Date) => Promise<void> {
  return async (chatId: string, when: Date) => {
    const memRoot = join(deps.stateDir, 'memory')
    const store = makeActivityStore(deps.db, chatId, { migrateFromFile: join(memRoot, chatId, 'activity.jsonl') })
    await store.recordInbound(when)
  }
}

export function makeMaybeWriteWelcomeObservation(deps: SideEffectDeps): (chatId: string) => Promise<void> {
  return async (chatId: string) => {
    const memRoot = join(deps.stateDir, 'memory')
    const obs = makeObservationsStore(deps.db, chatId, { migrateFromFile: join(memRoot, chatId, 'observations.jsonl') })
    const existing = await obs.listActive()
    const archived = await obs.listArchived()
    if (existing.length === 0 && archived.length === 0) {
      await obs.append({
        body: '嗨，我是 Claude。我会慢慢理解你，把观察写在这里——你可以随时来翻、纠正、忽略。',
        tone: 'playful',
      })
    }
  }
}

// PR F: makeIsolatedSdkEval deleted. Introspect tick now resolves a
// cheap eval via ProviderRegistry.getCheapEval() so it works with
// whichever providers the user has registered (claude / codex / future).
