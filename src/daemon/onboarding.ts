/**
 * First-time onboarding — daemon-level deterministic nickname capture.
 *
 * Why this exists alongside Claude's `set_user_name` MCP tool: Claude's
 * version is *advisory* (it asks for the name only when it feels like it,
 * and may skip if the user's first message is task-relevant). For a fresh
 * binding we want a deterministic two-step exchange BEFORE any message
 * reaches Claude:
 *
 *   1. inbound from unknown user → bot replies with greeting + ask for name
 *   2. user's reply → validated, persisted to user_names.json, confirmation sent
 *   3. subsequent messages route normally to Claude
 *
 * State is in-memory only — daemon restart resets the awaiting set, but the
 * user simply re-sends their nickname. No persistent corruption surface.
 */

export interface OnboardingDeps {
  isKnownUser(userId: string): boolean
  setUserName(chatId: string, name: string): Promise<void>
  sendMessage(chatId: string, text: string): Promise<void>
  log(tag: string, line: string): void
  now?: () => number
}

export interface OnboardingHandler {
  /**
   * Returns true if the message was consumed by the onboarding flow
   * (caller MUST NOT route to Claude). Returns false to continue normal
   * routing (already-known user, or user out of awaiting window).
   */
  handle(msg: { userId: string; chatId: string; text: string }): Promise<boolean>
}

const NICKNAME_MAX_LEN = 24
const NICKNAME_MIN_LEN = 1
const NICKNAME_RE = /^[一-鿿_a-zA-Z0-9 -]+$/
const AWAIT_TIMEOUT_MS = 30 * 60_000  // 30 min

export function makeOnboardingHandler(deps: OnboardingDeps): OnboardingHandler {
  const awaiting = new Map<string, number>()  // chatId -> millis when greeting was sent
  const now = deps.now ?? (() => Date.now())

  return {
    async handle(msg) {
      // Already-known users skip onboarding entirely.
      if (deps.isKnownUser(msg.userId)) return false

      const ts = awaiting.get(msg.chatId)
      const stillWaiting = ts !== undefined && (now() - ts) < AWAIT_TIMEOUT_MS

      if (stillWaiting) {
        const proposed = msg.text.trim()
        if (proposed.length < NICKNAME_MIN_LEN) {
          await deps.sendMessage(msg.chatId, '请发一个昵称（不能为空）。')
          return true
        }
        if (proposed.length > NICKNAME_MAX_LEN) {
          await deps.sendMessage(msg.chatId, `昵称太长（最多 ${NICKNAME_MAX_LEN} 字符）。再发一次？`)
          return true
        }
        if (!NICKNAME_RE.test(proposed)) {
          await deps.sendMessage(msg.chatId, '昵称只支持中文 / 字母 / 数字 / 空格 / _ / -。再发一次？')
          return true
        }
        await deps.setUserName(msg.chatId, proposed)
        awaiting.delete(msg.chatId)
        deps.log('ONBOARDING', `name set chat=${msg.chatId} → "${proposed}"`)
        await deps.sendMessage(msg.chatId, `好的，${proposed}。我会记住的。有什么需要？`)
        return true
      }

      // First contact (or stale awaiting state past timeout): greet + start the clock.
      awaiting.set(msg.chatId, now())
      deps.log('ONBOARDING', `start chat=${msg.chatId} userId=${msg.userId}`)
      await deps.sendMessage(
        msg.chatId,
        '你好！我是 wechat-cc bridge。第一次见面，请告诉我你的昵称（中文 / 英文都行，比如「丸子」「Alice」）。'
      )
      return true
    },
  }
}
