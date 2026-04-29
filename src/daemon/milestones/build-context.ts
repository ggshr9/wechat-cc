/**
 * Assembles a DetectorContext from real on-disk data. Pure-ish (depends on
 * fs only, not net/SDK). Designed to be cheap enough to call after every
 * inbound message + on daemon startup.
 *
 * v0.4 scope:
 *   - turnCount: line count of chat's _default project session jsonl
 *   - handoffMarkerExists: existsSync any project's memory/_handoff.md
 *   - pushRepliedHistory: events.jsonl scan for cron_eval_pushed events
 *   - daysWithMessage: empty array for v0.4 — 7-day-streak deferred to v0.4.1
 *
 * The 5 milestones currently fire-able with this context: ms_100msg,
 * ms_1000msg, ms_first_handoff, ms_first_push_reply. ms_7day_streak needs
 * per-chat daily activity tracking which is v0.4.1 work.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DetectorContext } from './detector'
import { makeEventsStore } from '../events/store'
import { makeSessionStore } from '../../core/session-store'
import { resolveProjectJsonlPath } from '../sessions/path-resolver'

export interface BuildContextDeps {
  stateDir: string
  chatId: string
}

export async function buildDetectorContext(deps: BuildContextDeps): Promise<DetectorContext> {
  const memoryRoot = join(deps.stateDir, 'memory')

  // turnCount: scan all sessions in sessions.json, sum jsonl line counts.
  // v0.4 simplification: use the _default alias only since a single-chat
  // owner typically maps to one project. Multi-project owners get a
  // smaller turnCount than reality — acceptable; milestones are reach-once
  // anyway, so they fire eventually as work accumulates.
  let turnCount = 0
  try {
    const sessions = makeSessionStore(join(deps.stateDir, 'sessions.json'), { debounceMs: 0 })
    const rec = sessions.get('_default')
    if (rec) {
      const path = resolveProjectJsonlPath('_default', rec.session_id)
      if (existsSync(path)) {
        const content = readFileSync(path, 'utf8')
        turnCount = content.split('\n').filter(l => l.length > 0).length
      }
    }
  } catch { /* turnCount stays 0 */ }

  // handoffMarkerExists: check the chat's memory dir for _handoff.md
  // (the marker is written into memory/<chat_id>/_handoff.md per spec).
  const handoffMarkerExists = existsSync(join(memoryRoot, deps.chatId, '_handoff.md'))

  // pushRepliedHistory: scan events.jsonl for cron_eval_pushed events.
  // Heuristic: presence of any pushed event is enough to fire
  // ms_first_push_reply (the milestone semantics ask "did we ever push?",
  // which is the closest proxy without per-message reply tracking).
  const events = makeEventsStore(memoryRoot, deps.chatId)
  const pushed = (await events.list()).filter(e => e.kind === 'cron_eval_pushed')
  const pushRepliedHistory = pushed.map(e => e.id)

  return {
    chatId: deps.chatId,
    turnCount,
    handoffMarkerExists,
    pushRepliedHistory,
    daysWithMessage: [],  // v0.4.1: per-chat daily activity tracking
  }
}
