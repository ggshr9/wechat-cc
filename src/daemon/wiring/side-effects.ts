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
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk'

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

/** Isolated single-shot Haiku eval — used by introspect tick. No tools. */
export function makeIsolatedSdkEval(): (prompt: string) => Promise<string> {
  return async (prompt: string) => {
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
}
