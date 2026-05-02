/**
 * chatroom-protocol — RFC 03 §4.4. Two utilities used by the
 * coordinator's chatroom dispatch loop:
 *
 *   1. parseAddressing(text): split assistant output into segments by
 *      @-tag prefix. The first @-tag claims everything up to the next
 *      @-tag. Lines without an @-tag fold into the previous segment.
 *      The leading text before any @-tag becomes a default segment
 *      (addressee=null → treated as user-facing).
 *
 *   2. wrapChatroomTurn(...): produce the envelope the speaker session
 *      sees on each turn. Includes the protocol explanation inline
 *      because sessions are per-(provider, alias) and can't have a
 *      mode-specific system prompt baked in at spawn time.
 *
 * Both are pure / side-effect-free for easy unit testing. The
 * coordinator wires them into the dispatch loop.
 */

import type { ProviderId } from './conversation'

export type Addressee = 'user' | ProviderId | null

export interface AddressedSegment {
  /** null = preamble before any @-tag (treated as user-facing by default). */
  addressee: Addressee
  /** Body text WITHOUT the leading @-tag and any single space after it. */
  body: string
}

/**
 * Parse assistant text into addressed segments. Each `@<word>` at the
 * START of a line begins a new segment; everything until the next
 * such line is the body. Text before the first @-tag becomes a segment
 * with addressee=null.
 *
 * Recognised @-tags: any contiguous a-z / 0-9 / _ / - sequence after
 * the @. Case preserved for downstream lookup.
 *
 * Empty bodies are skipped.
 */
export function parseAddressing(text: string): AddressedSegment[] {
  const segments: AddressedSegment[] = []
  let current: AddressedSegment = { addressee: null, body: '' }

  const lines = text.split(/\r?\n/)
  for (const line of lines) {
    const m = /^\s*@([a-zA-Z0-9_-]+)\s?(.*)$/.exec(line)
    if (m) {
      // Flush the in-progress segment if non-empty.
      if (current.body.trim().length > 0) segments.push({ addressee: current.addressee, body: current.body.trimEnd() })
      // Start a new segment.
      current = { addressee: m[1]!, body: m[2] ?? '' }
    } else {
      // Continuation line — append to the current segment's body.
      if (current.body.length > 0) current.body += '\n' + line
      else current.body = line
    }
  }
  if (current.body.trim().length > 0) segments.push({ addressee: current.addressee, body: current.body.trimEnd() })

  return segments
}

/**
 * Build the user-message envelope sent to a chatroom speaker session.
 * The envelope always includes the protocol explanation (because the
 * session's system prompt is mode-agnostic) plus the inner content
 * (either the original wechat-formatted user message, or a peer relay).
 */
export function wrapChatroomTurn(args: {
  speaker: ProviderId
  peer: ProviderId
  /** 1-indexed turn number within this loop (counts inter-agent rounds + initial). */
  round: number
  maxRounds: number
  /** Where the inner content came from. 'user' = original wechat msg; otherwise peer providerId. */
  sender: 'user' | ProviderId
  /** The actual content to send (already-formatted wechat envelope or peer's raw text). */
  inner: string
}): string {
  const speakerName = args.speaker
  const peerName = args.peer
  // Per-turn protocol reminder. Verbose but unambiguous; the agent sees
  // it on every chatroom turn so context-window cost is multiplied —
  // hold the description tight.
  const protocol =
`你在 chatroom 模式（RFC 03 §4.4）和 ${peerName} 协作回答用户消息。
- 默认 / @user 前缀 → 给用户的回复（用户看见，带 [Display] 前缀）
- @${peerName} 前缀 → 给 ${peerName} 的话（用户也看见，但视为内部讨论；${peerName} 下一轮会接到）
- 觉得讨论充分了，直接 @user 给最终答复 — 自然终止
- 当前第 ${args.round}/${args.maxRounds} 轮（max ${args.maxRounds}），耗尽后强制结束
- chatroom 模式下不要调 reply 工具，直接文本输出（reply 工具会绕开协议直发用户）`

  const senderHeader = args.sender === 'user'
    ? '[user originated]'
    : `[from ${args.sender}]`

  return `<chatroom_round speaker="${speakerName}" peer="${peerName}" round="${args.round}" max_rounds="${args.maxRounds}" sender="${args.sender}">
${protocol}

${senderHeader}
${args.inner}
</chatroom_round>`
}

/**
 * "max-rounds reached" suffix appended to the final speaker's
 * user-facing output when the loop terminates due to the safety cap.
 * Lets the user know the conversation was truncated rather than
 * naturally concluded.
 */
export function maxRoundsSuffix(): string {
  return '\n\n(chatroom: 已达到 max_rounds，强制结束本轮 — 如要继续讨论请再发一条消息)'
}
