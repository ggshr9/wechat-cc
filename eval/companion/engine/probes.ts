import type { Trajectory } from './trajectory'
import { resolveEventChat } from './trajectory'
import type { ProbeActual, ReplayContext } from './replay'
import { parseIso } from './clock'

export async function captureProbe(
  event: Extract<Trajectory['events'][number], { kind: 'probe' }>,
  ctx: ReplayContext,
): Promise<ProbeActual> {
  const chatId = resolveEventChat(event, ctx.primaryChatId)
  switch (event.probe_kind) {
    case 'reactive_response': {
      const r = ctx.lastUserMessageReply[chatId]
      if (!r) return { kind: 'reply', error: 'no prior user_message in this chat' }
      if (r.error !== undefined) return { kind: 'reply', error: r.error }
      return { kind: 'reply', text: r.text ?? '' }
    }
    case 'proactive_decision': {
      // Ticks always fire against companion_config.default_chat_id (see replay.ts
      // tick branch), so a proactive_decision probe reads that chat's outcome
      // regardless of the probe's own `chat:`.
      const t = ctx.lastTickOutcome[ctx.defaultChatId]
      if (!t) return { kind: 'tick_outcome', error: 'no prior tick against default_chat_id in this trajectory' }
      return {
        kind: 'tick_outcome',
        decision: t.decision,
        ...(t.text !== undefined ? { text: t.text } : {}),
      }
    }
    case 'memory_recall': {
      if (!event.ask) return { kind: 'reply', error: 'memory_recall probe requires ask:' }
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
