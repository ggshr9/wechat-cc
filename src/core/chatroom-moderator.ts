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

/**
 * v0.5.9 — chatroom is now a persistent session; history interleaves user
 * messages and speaker turns across the entire chatroom lifetime (until
 * mode changes away from chatroom). The moderator sees the full sequence
 * and decides whether each new user msg triggers 1 reply / multi-round
 * discussion / nothing.
 */
export type ChatroomEntry =
  | { role: 'user'; text: string }
  | { role: 'speaker'; speaker: ProviderId; text: string }

export interface ModeratorRoundInput {
  /**
   * Full chatroom history in chronological order. The latest entry is
   * the current trigger — usually the new user message on round 1, or
   * the previous speaker's turn on round 2+.
   */
  history: ChatroomEntry[]
  /** 1-indexed round counter for THIS user message's discussion (resets per user msg). */
  round: number
  maxRounds: number
  /** ≥2 providers participating in this chatroom. Coordinator caps at 3 in P1. */
  participants: ProviderId[]
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

const MODERATOR_INSTRUCTIONS = `你是 chatroom 持续会话的主持人。N 个 AI agent（具体名单见 prompt 末尾的"候选 speaker"）和用户在同一个对话频道里。每当用户发新消息、或 agent 发完一轮，你被叫来决定：让谁说、说什么、还是结束本轮。

【你看到的 history】
按时间顺序排列的混合序列，每条带 role 标签：
  - role=user → 用户消息
  - role=speaker, speaker=<provider id> → AI 发言
最新的 user 消息（如果存在且是历史里最后一个 role=user）是当前等待响应的触发点。

【你的角色】
- **不出现在用户视线**——你的 prompt 字段会**被原样喂给被选中的 speaker** 当指令。speaker 不知道你存在
- 给 speaker 的 prompt 是它看到的全部内容，所以要包含必要的上下文：用户问了什么、上一发言人说了什么、它现在该做什么

【判断原则（不强制 workflow，只做内容感知的路由）】
- 这条 user 消息需要多深的讨论？
  - 简单事实 Q（"X 是什么"，"几加几"）→ 一个 speaker 答完即 end
  - 有歧义 / 需要决策 / 哲学性 / 情绪向 → 让两个 agent 都参与
  - 接前面讨论的追问 → 让相关 speaker 接着说
- 上一发言人和它前面发言人的关系：
  - 真分歧 → 让对方回应**具体论点**（引用某句话）
  - 互补（覆盖了不同面）→ 让对方综合 + 找盲点
  - 共识（独立得出相同结论）→ 这是强信号；要么 end，要么"这个共识下最容易翻车的边角是什么"深化
  - 校验关系 → 让对方独立验证 + 报告差异
- **不预设要反驳还是同意**——根据实际内容判断。如果两人真的同意，让 speaker 同意；如果真的不同意，让它真的不同意。**不制造虚假对立**

【输出格式】
{"action":"continue|end","speaker":"<provider id from 候选 speaker>","prompt":"<完整指令>","reasoning":"<≤20 字>"}

【硬约束（这些是边界，不是 workflow）】
- speaker 必须**不同于上一轮的 speaker**（除非 round 1 且无前序发言）
- 当前 round = MAX → action 必须是 "continue"，让其中一人写**综合答复**：prompt 必须明确要求 speaker **以 🎯 emoji 开头**（不是文字"终局"或"综合"），≤200 字概括双方观点 + 给出落地判断
- prompt 末尾自动追加"用纯文本回复，不要调 reply 工具"——不需要你写
- 引用上一发言人时**引用具体某句话或论点**，不要"你怎么看"
- 禁止 filler turns（"基本同意 + 略微补充" 但没新内容 → 应该 end）
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
  const participantsList = input.participants

  // Last speaker = most-recent role=speaker entry. Used for forced
  // alternation. Latest user msg / mid-discussion both don't reset this.
  const lastSpeakerEntry = [...input.history].reverse().find(e => e.role === 'speaker')
  const lastSpeaker = lastSpeakerEntry && lastSpeakerEntry.role === 'speaker'
    ? lastSpeakerEntry.speaker
    : undefined

  // Defensive: if the caller's loop forgot to bound itself, force end past
  // the cap. Normal callers stop iterating at round=maxRounds inclusive.
  if (input.round > input.maxRounds) {
    return { action: 'end', reasoning: `round ${input.round} > maxRounds ${input.maxRounds}` }
  }

  // UX rule (post v0.5.9 dogfooding): the user explicitly switched to
  // /chat to hear from both AIs. If round 1 returns "end" we send 0
  // replies, which feels like the bot ignored them. Force at least one
  // speaker turn per user msg — moderator can still end on round 2+ if
  // the conversation is exhausted.
  // Implementation: we let haiku run, but coerce action='end' to a
  // continue-with-fallback-prompt whenever round === 1. This preserves
  // the moderator's speaker choice (if it picked one despite saying
  // 'end') and otherwise alternates from history.

  const historyText = input.history.length === 0
    ? '(empty — fresh chatroom)'
    : input.history
        .map((e, i) => {
          const tag = e.role === 'user' ? '[user]' : `[${e.speaker}]`
          return `${i + 1}. ${tag}\n${e.text}`
        })
        .join('\n\n')

  const userPrompt = `${MODERATOR_INSTRUCTIONS}

---

# Chatroom history
${historyText}

# 当前 round
${input.round}/${input.maxRounds}

# 候选 speaker
${participantsList.join(', ')}${lastSpeaker ? ` （上一发言是 ${lastSpeaker}，本轮挑另一个）` : ''}

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
    if (input.round === 1) {
      // The user wrote a new message and is waiting for SOMETHING. Even
      // if the moderator thinks the message is trivial / casual, falling
      // through with no reply feels like the bot ignored them. Coerce to
      // a single-speaker continue using the generic prompt.
      log('CHATROOM_MOD', `moderator wanted end on round 1 (${typeof obj.reasoning === 'string' ? obj.reasoning : '—'}); coercing to continue so user gets at least one reply`)
      return {
        action: 'continue',
        speaker: peerOf(lastSpeaker, input.participants),
        prompt: genericContinuePrompt(input, lastSpeaker),
        reasoning: 'round1_must_continue',
      }
    }
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

function peerOf(last: ProviderId | undefined, participants: ProviderId[]): ProviderId {
  if (!last) return participants[0]!
  // Pick the first participant other than `last`. Coordinator forces a
  // ≥2 cardinality so participants[0] or [1] always exists.
  const next = participants.find(p => p !== last)
  return next ?? participants[0]!
}

function fallbackDecision(input: ModeratorRoundInput, lastSpeaker: ProviderId | undefined, reason: string): ModeratorDecision {
  // On any moderator failure, keep the loop progressing with forced
  // alternation + a generic-but-functional prompt. Only force end past
  // maxRounds; at round === maxRounds we still want a synthesis turn
  // (genericContinuePrompt's isFinal branch emits the 🎯 ask) so the
  // user sees the wrap-up they were waiting for.
  if (input.round > input.maxRounds) {
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
  // Latest user msg = last entry with role='user'.
  const latestUserEntry = [...input.history].reverse().find(e => e.role === 'user')
  const userMessage = latestUserEntry && latestUserEntry.role === 'user'
    ? latestUserEntry.text
    : '(unknown)'
  // Latest speaker turn (could be the speaker we're alternating against).
  const latestSpeakerEntry = [...input.history].reverse().find(e => e.role === 'speaker')

  if (input.round === 1) {
    return `用户问：「${userMessage}」\n\n给你的看法（≤150 字）。如果你觉得另一个 AI 可能会有不同视角或补充，主动指出 1-2 个值得他展开的点。不需要刻意制造分歧。\n\n请用纯文本回复，不要调 reply 工具。`
  }

  // Speakers run in independent sessions — they don't see each other's
  // outputs unless we include the text verbatim in the prompt.
  const prevBlock = latestSpeakerEntry && latestSpeakerEntry.role === 'speaker'
    ? `\n\n${latestSpeakerEntry.speaker} 上一轮的发言：\n---\n${latestSpeakerEntry.text}\n---`
    : ''

  if (isFinal) {
    return `用户问：「${userMessage}」${prevBlock}\n\n这是讨论的最后一轮。请**以 🎯 emoji 开头**，用 ≤200 字概括双方观点 + 给出你综合后的落地判断。\n\n请用纯文本回复，不要调 reply 工具。`
  }

  return `用户问：「${userMessage}」${prevBlock}\n\n请回应 ${lastSpeaker ?? '上一位 agent'} 的具体论点：同意 → 深化 / 找两人都漏的盲点；不同意 → 指出具体哪句不对 + 给替代视角；觉得没新内容可补 → 简短说明就行（moderator 会决定 end）。≤150 字。\n\n请用纯文本回复，不要调 reply 工具。`
}
