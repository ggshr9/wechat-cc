/**
 * Claude SDK judge backend.
 *
 * Calls @anthropic-ai/claude-agent-sdk's `query()` with the rubric prompt
 * and parses the JSON array reply. The SDK is invoked the same way
 * src/daemon/wiring/side-effects.ts's makeIsolatedSdkEval does: one-shot
 * query, drain messages, extract assistant text.
 */
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { Judge, JudgeProbeInput, JudgeDimension } from './judge'
import type { JudgeScore } from './replay'
import { buildJudgePrompt } from './judge-prompts'

export function makeClaudeSdkJudge(opts: { model?: string } = {}): Judge {
  const model = opts.model ?? 'claude-opus-4-7'
  return {
    name: `claude-sdk:${model}`,
    async score(input: JudgeProbeInput): Promise<JudgeScore[]> {
      if (input.dimensions.length === 0) return []
      const prompt = buildJudgePrompt({
        trajectoryHistoryToProbe: input.trajectoryHistoryToProbe,
        expectedSummary: input.expected.summary,
        expectedMustRecall: input.expected.must_recall,
        expectedToneHints: input.expected.tone_hints,
        actualText: input.actual.text,
        actualDecision: input.actual.decision,
        dimensions: input.dimensions,
      })

      let text = ''
      const stream = query({
        prompt,
        options: { model, settingSources: [] },
      })
      for await (const raw of stream as AsyncIterable<SDKMessage>) {
        const msg = raw as unknown as { type: string; message?: { content?: unknown } }
        if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
          for (const part of msg.message.content as Array<{ type?: string; text?: string }>) {
            if (part.type === 'text' && typeof part.text === 'string') text += part.text
          }
        }
      }

      const cleaned = text.trim().replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim()
      let parsed: unknown
      try { parsed = JSON.parse(cleaned) } catch (err) {
        throw new Error(`judge JSON parse failed: ${err instanceof Error ? err.message : String(err)} — text=${cleaned.slice(0, 200)}`)
      }
      if (!Array.isArray(parsed)) throw new Error(`judge returned non-array: ${typeof parsed}`)

      const out: JudgeScore[] = []
      for (const item of parsed) {
        if (typeof item !== 'object' || item === null) continue
        const o = item as Record<string, unknown>
        const dim = o.dimension as JudgeDimension | undefined
        const score = o.score
        const rationale = o.rationale
        if (typeof dim !== 'string' || typeof score !== 'number' || typeof rationale !== 'string') continue
        if (!input.dimensions.includes(dim)) continue
        const clamped = Math.max(1, Math.min(5, Math.round(score))) as JudgeScore['score']
        out.push({ dimension: dim, score: clamped, rationale })
      }
      return out
    },
  }
}
