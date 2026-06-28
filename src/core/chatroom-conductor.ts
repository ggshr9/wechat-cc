/**
 * chatroom-conductor — pure prompt builders + a tolerant convergence parser
 * for the three-beat /chat debate (opening → cross-talk → verdict). No LLM /
 * SDK here; the coordinator runs the agents and calls deps.haikuEval for the
 * convergence check + verdict. Replaces the old evaluateRound moderator.
 */
import type { ProviderId } from './conversation'

export interface Opening {
  speaker: ProviderId
  text: string
}

const NO_REPLY_TOOL = '用纯文本回复，不要调 reply 工具。'

function othersBlock(openings: Opening[], self: ProviderId): string {
  return openings
    .filter(o => o.speaker !== self)
    .map(o => `【${o.speaker} 的立场】\n${o.text}`)
    .join('\n\n')
}

/**
 * Beat ① — the OPENING. Frame the agent as one voice in a multi-AI roundtable
 * alongside its named peers, so it does NOT answer as if it's a solo chat (the
 * raw question alone made Claude say "现在是 solo 模式" and made Codex fabricate
 * the other side). It states the peers, the user's message, and that a
 * cross-talk round follows — so the agent stakes a position meant to be debated.
 */
export function buildOpeningPrompt(question: string, participants: ProviderId[], self: ProviderId): string {
  const peers = participants.filter(p => p !== self).join('、')
  return [
    `你正在一个多 AI 圆桌讨论（chatroom）里，同台的还有：${peers}。这不是 solo 对话——你和他们一起回应同一个用户。`,
    `用户的消息：${question}`,
    '',
    `先给出你的开场立场/回答。稍后你会看到 ${peers} 的回答，然后你们互相讨论、挑毛病——所以现在把观点说清楚、有立场、能被反驳。直接答，别说"我没有对手"之类的话。简短、中文、没废话。`,
    NO_REPLY_TOOL,
  ].join('\n')
}

/** Beat ② — each agent sees the OTHERS' openings and is told to engage pointedly. */
export function buildRebuttalPrompt(question: string, openings: Opening[], self: ProviderId): string {
  return [
    `用户的问题：${question}`,
    '',
    '另一(几)位 AI 的立场如下：',
    othersBlock(openings, self),
    '',
    '针对性回应，且只说"新东西"——这是高质量讨论的关键：',
    '- 别重复你或对方已经说过的话；别"基本同意+小补充"地附和（没有新内容就不要发言）。',
    '- 要么提出对方没覆盖的新角度 / 反例 / 证据，要么明确指出他哪一句具体错了（引用原话），要么承认你被说服的那一点并说清为什么。',
    '- 不制造虚假对立：真一致就说一致。但如果你确实没有新东西可加，只回一句"我和 X 在这点上一致，没有要补充的"，不要凑字数。',
    '你只是在讨论当中，不要做总结/收口/最终裁决，也不要说"本轮结束"之类的话——那是主持人最后才做的事。就事论事继续。',
    '简短、中文、没废话。',
    NO_REPLY_TOOL,
  ].join('\n')
}

/** Beat ②b — tiny convergence check (the ONLY JSON; kept small so it can't truncate). */
export function buildConvergencePrompt(question: string, openings: Opening[], rebuttals: Opening[]): string {
  const transcript = [...openings, ...rebuttals].map(o => `[${o.speaker}] ${o.text}`).join('\n\n')
  return [
    `判断这场关于「${question}」的讨论是否已经收敛(双方对核心问题已无实质分歧)。`,
    transcript,
    '',
    '只输出一行紧凑 JSON,不要 markdown 围栏,不要解释：',
    '{"converged": true|false, "disagreement": "<若未收敛,一句话说清还在争什么;收敛则空字符串>"}',
  ].join('\n')
}

/** Beat ③ — the deliverable: a JUDGED synthesis. Plain text, no JSON to parse. */
export function buildVerdictPrompt(question: string, openings: Opening[], rebuttals: Opening[]): string {
  const transcript = [...openings, ...rebuttals].map(o => `[${o.speaker}] ${o.text}`).join('\n\n')
  return [
    `下面是几位 AI 关于「${question}」的讨论。给出最终裁决,不是"两种看法供参考"——要站队。`,
    transcript,
    '',
    '用这个结构,简短,中文,以 🎯 开头：',
    '🎯 共识：<他们一致的部分>',
    '分歧：<分歧点;哪边更对、为什么>',
    '结论/建议：<可落地的答案>',
    NO_REPLY_TOOL,
  ].join('\n')
}

/**
 * Tolerant parse of the convergence check. Never throws. Order:
 *  1. JSON.parse the first {...} block (strips ```json fences naturally).
 *  2. On failure (e.g. truncation), regex-extract `converged` + `disagreement`.
 *  3. On total failure, default converged=true (stop — never loop forever).
 */
export function parseConvergence(raw: string): { converged: boolean; disagreement?: string } {
  const block = raw.match(/\{[\s\S]*\}/)
  if (block) {
    try {
      const o = JSON.parse(block[0]) as { converged?: unknown; disagreement?: unknown }
      const converged = o.converged !== false
      return converged
        ? { converged: true }
        : { converged: false, ...(typeof o.disagreement === 'string' && o.disagreement.trim() ? { disagreement: o.disagreement } : {}) }
    } catch { /* fall through to field extraction */ }
  }
  // Truncation / malformed: pull fields out by regex.
  const convM = raw.match(/"converged"\s*:\s*(true|false)/)
  if (convM) {
    if (convM[1] === 'true') return { converged: true }
    const disM = raw.match(/"disagreement"\s*:\s*"([^"]*)/) // tolerate missing closing quote
    return { converged: false, ...(disM && disM[1]?.trim() ? { disagreement: disM[1] } : {}) }
  }
  return { converged: true } // unparseable → stop, don't loop
}
