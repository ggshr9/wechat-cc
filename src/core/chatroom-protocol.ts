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
 * Includes the protocol explanation because the session's system prompt
 * is mode-agnostic. Inner content is either the original wechat-formatted
 * user message or a peer relay.
 *
 * RFC 03 P5 review #8 — bandwidth optimisation. Round 1 gets the full
 * protocol description (~250 chars); rounds 2+ get a one-liner
 * recap (~80 chars) since the agent already saw the full version on
 * round 1 of THIS loop's session and SDK history retains it. Cumulative
 * cost across a max_rounds=4 loop drops from 4×full to 1×full + 3×brief.
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

  // Round-1 message gets the full protocol; subsequent turns of THE SAME
  // session see it in their conversation history. Round-2+ envelope
  // skips the protocol body (just the round counter + sender header).
  const isFirstRound = args.round === 1
  const protocol = isFirstRound
    ? `你在 chatroom 模式（RFC 03 §4.4）和 ${peerName} 协作回答用户消息。

协议：
- 默认 / @user 前缀的行 → 给用户（用户看见，带 [Display] 前缀）
- @${peerName} 前缀的行 → 给 ${peerName}，下一轮他接到（用户也能看见，视为内部讨论）
- chatroom 模式下不要调 reply 工具，直接纯文本输出
- 当前第 ${args.round}/${args.maxRounds} 轮（max ${args.maxRounds}），耗尽后强制结束

**重要：round 1 不要直接给用户最终答复**——chatroom 的卖点是至少一来一回的协作，光自己 @user 答完就和 /both 没区别了，那是用户没要的。

round 1 标准做法：
- 简短说出你的初步看法 / 给出你的初稿（用户能看见这个思考过程）
- 然后用 \`@${peerName}\` 把球抛给对方，让他点评、补充或反驳
- ${peerName} 在 round 2 综合双方意见后 @user 给最终答复（如果同意你）；不同意就继续辩

例外：消息是问候 / 寒暄 / 明显不需要协作的（"你好" "在吗"），可以直接 @user 简短回应并说明这种问题不需要走 chatroom。`
    : `[chatroom round ${args.round}/${args.maxRounds} — 协议同 round 1（@user 给用户 / @${peerName} 给 peer / 不调 reply）。${args.sender === args.peer ? `已经互相 @ 过一轮，现在轮到你回应——同意就 @user 给最终答复，要继续辩就 @${peerName}` : ''}]`

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
