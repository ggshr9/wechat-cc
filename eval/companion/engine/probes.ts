import type { Trajectory } from './trajectory'
import type { ProbeActual, ReplayContext } from './replay'
import { parseIso } from './clock'

export async function captureProbe(
  event: Extract<Trajectory['events'][number], { kind: 'probe' }>,
  ctx: ReplayContext,
): Promise<ProbeActual> {
  switch (event.probe_kind) {
    case 'reactive_response': {
      const r = ctx.lastUserMessageReply
      if (!r) return { kind: 'reply', error: 'no prior user_message in this trajectory' }
      if (r.error !== undefined) return { kind: 'reply', error: r.error }
      return { kind: 'reply', text: r.text ?? '' }
    }
    case 'proactive_decision': {
      const t = ctx.lastTickOutcome
      if (!t) return { kind: 'tick_outcome', error: 'no prior tick in this trajectory' }
      return {
        kind: 'tick_outcome',
        decision: t.decision,
        ...(t.text !== undefined ? { text: t.text } : {}),
      }
    }
    case 'memory_recall': {
      if (!event.ask) return { kind: 'reply', error: 'memory_recall probe requires ask:' }
      const chatId = event.chat ?? ctx.trajectory.primaryChatId
      const outboxBefore = ctx.daemon.outboundFor(chatId).length
      ctx.daemon.sendText(chatId, event.ask, { createTimeMs: parseIso(event.at).getTime() })
      try {
        await ctx.daemon.waitForReplyTo(chatId, 120_000)
        const newOnes = ctx.daemon.outboundFor(chatId).slice(outboxBefore)
        const last = newOnes[newOnes.length - 1]
        return { kind: 'reply', text: last?.text ?? '' }
      } catch (err) {
        return { kind: 'reply', error: err instanceof Error ? err.message : String(err) }
      }
    }
    case 'state_inspect':
      // The snapshot itself IS the actual — engine doesn't drive anything.
      return { kind: 'state' }
  }
}
