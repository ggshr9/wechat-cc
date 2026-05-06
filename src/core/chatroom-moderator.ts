/**
 * chatroom-moderator.ts — RFC 03 §4.4 (v0.5.8 rewrite). One-shot
 * claude-haiku-4-5 evaluation that decides each chatroom round:
 *   - who speaks next (forced alternation between participants)
 *   - what specific question to ask them (referencing prior turns)
 *   - when to stop
 *
 * Why this exists: through v0.5.7 the chatroom protocol was in-band
 * (@-tags in the speakers' own outputs decided routing). That fights
 * the model's training prior toward "give the user a complete answer"
 * — even with explicit instructions, both speakers usually @user'd
 * directly and the result was indistinguishable from /both. Mature
 * multi-agent frameworks (AutoGen GroupChatManager, CrewAI hierarchical
 * mode, Anthropic's orchestrator-worker pattern) all pass routing
 * decisions to a separate coordinator LLM rather than relying on
 * participants to self-route. This module is that coordinator.
 *
 * Cost: ~3-5 haiku calls per /chat dispatch. ~$0.01-0.05 per /chat at
 * 0.128.0 SDK rates. Latency overhead ~5-10s spread across rounds.
 *
 * Failure modes:
 *   - Malformed JSON → fallback to forced alternation with a generic
 *     "review the previous turn" prompt. Loop still progresses.
 *   - query() throws → fallback to /cc (single solo turn with default
 *     provider). Caller should catch and short-circuit.
 *   - Moderator picks same speaker as previous round → coerced to peer.
 *     (Defense against haiku occasionally getting confused.)
 */

import type { ProviderId } from './conversation'

export interface ModeratorTurn {
  speaker: ProviderId
  text: string
}

export interface ModeratorRoundInput {
  userMessage: string
  history: ModeratorTurn[]
  round: number
  maxRounds: number
  participants: [ProviderId, ProviderId]
  /** If non-null, the moderator MUST NOT pick this speaker this round. */
  blockedSpeaker?: ProviderId
}

export type ModeratorDecision =
  | { action: 'continue'; speaker: ProviderId; prompt: string; reasoning?: string }
  | { action: 'end'; reasoning?: string }

export interface ModeratorEvalDeps {
  /**
   * Run a single haiku query and return the assistant's text. Caller
   * is responsible for picking model / passing options. Implementation
   * lives in coordinator wiring (uses @anthropic-ai/claude-agent-sdk's
   * query()) so this module stays SDK-agnostic for tests.
   */
  haikuEval: (prompt: string) => Promise<string>
  log?: (tag: string, line: string) => void
}

const MODERATOR_INSTRUCTIONS = `你是一个多 agent 讨论的主持人。两个 AI agent（claude 和 codex）需要协作回答用户问题。每一轮你决定：谁发言、问他什么、或讨论是否结束。

**核心目标：制造真正的交锋，不是表演协作。** 默认假设两人观点不同，主动找对立点，让 round 2 / 3 真的有反驳。如果他们看起来轻易一致，那是没挖深——再问一轮，**强制对方挑前一发言人最弱的论点反驳**。

输出格式（**只输出一个 JSON object，不要任何其他文字**）：
{"action":"continue|end","speaker":"claude|codex","prompt":"<给该 agent 的具体指令>","reasoning":"<一句话原因，≤20字>"}

规则：
- **Round 1**: action 必须是 "continue"。挑一个 speaker，让他给初步看法（≤120 字）+ **主动给出 1-2 个有争议、对方很可能反驳的具体论点**（不要含糊的"我们应该谨慎"）。
- **Round 2 — 反驳轮（强制）**: action 必须是 "continue"。Prompt 必须：
  1. 引用上一发言人的**具体某句话或某个具体论点**（不要"你说的话"这种笼统的）
  2. 命令对方**找出至少 1 个弱点 / 反例 / 边角情况来反驳**（明令不许"基本同意"）
  3. ≤150 字回复
- **Round 3+**: 看双方是否真的有分歧。
  - 还有未深入的对立点 → "continue" 让前一个 speaker 反驳新出现的弱点
  - 共识真的成立（不是表演的"好的我同意"）→ "end"
- **当前 round 等于 MAX**: action 必须是 "continue"。让其中一人写**【终局综合】**（prompt 明确要求开头写"【终局综合】"，≤200 字概括双方分歧 + 给出综合判断）。下一轮就到不了。
- speaker 必须**不同于上一轮的 speaker**（强制轮换）
- 所有给 speaker 的 prompt **末尾必须加一句**："请用纯文本回复（≤N 字），不要调 reply 工具。"
- 所有 prompt 用中文、简短、没废话、没角色扮演
- reasoning ≤ 20 字

如果 action="end"，speaker 和 prompt 字段会被忽略。`

/**
 * Evaluate one chatroom round. Returns a decision the coordinator
 * should act on. Always returns a valid decision (falls back to a
 * sensible default if the LLM output is malformed).
 */
export async function evaluateRound(input: ModeratorRoundInput, deps: ModeratorEvalDeps): Promise<ModeratorDecision> {
  const log = deps.log ?? (() => {})
  const [a, b] = input.participants
  const lastSpeaker = input.history[input.history.length - 1]?.speaker

  // Defensive: if the caller's loop forgot to bound itself, force end past
  // the cap. Normal callers (coordinator's `for round=1..maxRounds`) never
  // hit this — they stop iterating at round=maxRounds inclusive and we let
  // the moderator decide on that final round.
  if (input.round > input.maxRounds) {
    return { action: 'end', reasoning: `round ${input.round} > maxRounds ${input.maxRounds}` }
  }

  const historyText = input.history.length === 0
    ? '(no turns yet — round 1)'
    : input.history.map((t, i) => `[turn ${i + 1}] [${t.speaker}]\n${t.text}`).join('\n\n')

  const userPrompt = `${MODERATOR_INSTRUCTIONS}

---

# 用户消息
${input.userMessage}

# 当前讨论历史
${historyText}

# 当前 round
${input.round}/${input.maxRounds}

# 候选 speaker
${a}, ${b}${lastSpeaker ? ` (上一轮是 ${lastSpeaker}，本轮必须挑另一个)` : ''}

输出你的 JSON decision：`

  let raw: string
  try {
    raw = (await deps.haikuEval(userPrompt)).trim()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log('CHATROOM_MOD', `haiku eval threw: ${msg}; falling back to alternation`)
    return fallbackDecision(input, lastSpeaker, 'haiku_threw')
  }

  let parsed: unknown
  try {
    // Tolerate models that wrap the JSON in ```json fences or similar.
    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    if (!jsonMatch) throw new Error('no JSON object found in output')
    parsed = JSON.parse(jsonMatch[0])
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log('CHATROOM_MOD', `parse failed: ${msg}; raw=${JSON.stringify(raw).slice(0, 200)}; falling back`)
    return fallbackDecision(input, lastSpeaker, 'parse_failed')
  }

  const obj = parsed as { action?: unknown; speaker?: unknown; prompt?: unknown; reasoning?: unknown }
  if (obj.action === 'end') {
    return {
      action: 'end',
      ...(typeof obj.reasoning === 'string' ? { reasoning: obj.reasoning } : {}),
    }
  }
  if (obj.action !== 'continue') {
    log('CHATROOM_MOD', `unknown action=${JSON.stringify(obj.action)}; falling back`)
    return fallbackDecision(input, lastSpeaker, 'bad_action')
  }
  let speaker = obj.speaker
  if (typeof speaker !== 'string' || !input.participants.includes(speaker as ProviderId)) {
    log('CHATROOM_MOD', `bad speaker=${JSON.stringify(speaker)}; coercing to peer`)
    speaker = peerOf(lastSpeaker, input.participants)
  } else if (lastSpeaker && speaker === lastSpeaker) {
    log('CHATROOM_MOD', `repeated speaker=${speaker}; coercing to peer`)
    speaker = peerOf(lastSpeaker, input.participants)
  }
  const prompt = typeof obj.prompt === 'string' && obj.prompt.trim().length > 0
    ? obj.prompt
    : genericContinuePrompt(input, lastSpeaker)
  return {
    action: 'continue',
    speaker: speaker as ProviderId,
    prompt,
    ...(typeof obj.reasoning === 'string' ? { reasoning: obj.reasoning } : {}),
  }
}

function peerOf(last: ProviderId | undefined, participants: [ProviderId, ProviderId]): ProviderId {
  if (!last) return participants[0]
  return last === participants[0] ? participants[1] : participants[0]
}

function fallbackDecision(input: ModeratorRoundInput, lastSpeaker: ProviderId | undefined, reason: string): ModeratorDecision {
  // On any moderator failure, keep the loop progressing with forced
  // alternation + a generic-but-functional prompt. End on max round.
  if (input.round >= input.maxRounds) {
    return { action: 'end', reasoning: `fallback:${reason}` }
  }
  const speaker = peerOf(lastSpeaker, input.participants)
  return {
    action: 'continue',
    speaker,
    prompt: genericContinuePrompt(input, lastSpeaker),
    reasoning: `fallback:${reason}`,
  }
}

function genericContinuePrompt(input: ModeratorRoundInput, lastSpeaker: ProviderId | undefined): string {
  const isFinal = input.round === input.maxRounds
  if (input.round === 1) {
    return `用户问：「${input.userMessage}」\n\n请给你的初步看法（≤120 字），并**给出 1-2 个有争议、对方很可能反驳的具体论点**——不要含糊的中庸表达。\n\n请用纯文本回复，不要调 reply 工具。`
  }
  // Speakers run in independent sessions — they don't see each other's
  // outputs unless we include the text verbatim in the prompt. Without
  // this the fallback dispatch produces "I haven't seen what they said"
  // turns (bug reported 2026-05-06).
  const prev = input.history[input.history.length - 1]
  const prevBlock = prev
    ? `\n\n${prev.speaker} 上一轮的发言（你需要回应他）：\n---\n${prev.text}\n---`
    : ''
  if (isFinal) {
    return `用户问：「${input.userMessage}」${prevBlock}\n\n这是讨论的最后一轮。请以「【终局综合】」开头，用 ≤200 字概括双方分歧 + 给出你综合后的判断。不要含糊。\n\n请用纯文本回复，不要调 reply 工具。`
  }
  return `用户问：「${input.userMessage}」${prevBlock}\n\n你必须**引用 ${lastSpeaker ?? '上一位 agent'} 的某个具体论点**，并**找出至少 1 个弱点 / 反例 / 边角情况来反驳**——不许"基本同意"这种敷衍。≤150 字。\n\n请用纯文本回复，不要调 reply 工具。`
}
