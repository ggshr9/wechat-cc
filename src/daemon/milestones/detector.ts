/**
 * Pure milestone detection — given a snapshot of chat-level facts, returns
 * the set of milestones to fire NOW. Idempotent: relies on store.fire's
 * dedup so re-running with the same context is a no-op for already-fired
 * milestones.
 *
 * Caller is responsible for assembling DetectorContext (e.g. counting jsonl
 * lines, checking _handoff.md existence, scanning events.jsonl for
 * pushRepliedHistory). Decoupled here for unit testability.
 */
import type { MilestonesStore } from './store'

export interface DetectorContext {
  chatId: string
  turnCount: number               // total turns across all sessions for this chat
  handoffMarkerExists: boolean    // _handoff.md present in any project memory
  pushRepliedHistory: string[]    // event_ids of pushes that user replied to
  daysWithMessage: string[]       // YYYY-MM-DD strings, last N days where chat had a message
}

interface MilestoneSpec {
  id: string
  body: string
  fires: (ctx: DetectorContext) => boolean
}

const SPECS: MilestoneSpec[] = [
  {
    id: 'ms_100msg',
    body: '我们聊了第 100 条 — 不知不觉。',
    fires: ctx => ctx.turnCount >= 100,
  },
  {
    id: 'ms_1000msg',
    body: '我们聊了第 1000 条。',
    fires: ctx => ctx.turnCount >= 1000,
  },
  {
    id: 'ms_first_handoff',
    body: '第一次跨项目交接 — 我把上下文带过去了。',
    fires: ctx => ctx.handoffMarkerExists,
  },
  {
    id: 'ms_first_push_reply',
    body: '你第一次回复我主动找你。',
    fires: ctx => ctx.pushRepliedHistory.length > 0,
  },
  {
    id: 'ms_7day_streak',
    body: '我们已经连续 7 天每天都聊。',
    fires: ctx => has7DayStreak(ctx.daysWithMessage),
  },
]

function has7DayStreak(days: string[]): boolean {
  if (days.length < 7) return false
  const set = new Set(days)
  const today = new Date()
  for (let i = 0; i < 7; i++) {
    const d = new Date(today.getTime() - i * 86400_000)
    const key = d.toISOString().slice(0, 10)
    if (!set.has(key)) return false
  }
  return true
}

export async function detectMilestones(store: MilestonesStore, ctx: DetectorContext): Promise<string[]> {
  const fired: string[] = []
  for (const spec of SPECS) {
    if (!spec.fires(ctx)) continue
    if (await store.fire({ id: spec.id, body: spec.body })) {
      fired.push(spec.id)
    }
  }
  return fired
}
