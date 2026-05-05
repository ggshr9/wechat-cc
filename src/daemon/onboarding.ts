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
 *   2. user's reply → validated, persisted to user_names.json, ack reply +
 *      original first message re-dispatched through the normal pipeline so
 *      the provider answers it
 *   3. subsequent messages route normally to Claude
 *
 * State is in-memory only — daemon restart resets the awaiting set, but the
 * user simply re-sends their nickname. No persistent corruption surface.
 */

import type { InboundMsg } from '../core/prompt-format'

export interface OnboardingDeps {
  isKnownUser(userId: string): boolean
  setUserName(chatId: string, name: string): Promise<void>
  sendMessage(chatId: string, text: string): Promise<void>
  /** Bot's user-facing self-name for the greeting (mode-aware in production). */
  botName(chatId: string): string
  /** Re-dispatch the user's first message through the normal pipeline AFTER
   *  the nickname is captured so the provider answers it. Fire-and-forget
   *  from onboarding's POV — failures are logged here, recovery is the
   *  pipeline's job. */
  dispatchInbound(msg: InboundMsg): Promise<void>
  log(tag: string, line: string): void
  now?: () => number
}

export interface OnboardingHandler {
  /**
   * Returns true if the message was consumed by the onboarding flow
   * (caller MUST NOT route to Claude). Returns false to continue normal
   * routing (already-known user, or user out of awaiting window).
   */
  handle(msg: InboundMsg): Promise<boolean>
}

const NICKNAME_MAX_LEN = 24
const NICKNAME_MIN_LEN = 1
const NICKNAME_RE = /^[一-鿿_a-zA-Z0-9 -]+$/
const AWAIT_TIMEOUT_MS = 30 * 60_000  // 30 min
const DEDUP_WINDOW_MS = 1500  // ilink re-delivery / user double-tap window — see #16

export function makeOnboardingHandler(deps: OnboardingDeps): OnboardingHandler {
  const awaiting = new Map<string, { since: number; triggerText: string; fromMessage: InboundMsg }>()
  const now = deps.now ?? (() => Date.now())

  return {
    async handle(msg) {
      // Already-known users skip onboarding entirely.
      if (deps.isKnownUser(msg.userId)) return false

      const aw = awaiting.get(msg.chatId)
      const stillWaiting = aw !== undefined && (now() - aw.since) < AWAIT_TIMEOUT_MS

      if (stillWaiting) {
        // Dedup: ilink re-delivery / user double-tap arrives ~1ms after the
        // first inbound. Without this guard the duplicate gets consumed as
        // the user's nickname (e.g. user_names.json "你好" / "在吗").
        if (now() - aw.since < DEDUP_WINDOW_MS && msg.text === aw.triggerText) {
          deps.log('ONBOARDING', `dedup chat=${msg.chatId} (same trigger text within ${now() - aw.since}ms)`)
          return true
        }
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
        const stored = awaiting.get(msg.chatId)!
        awaiting.delete(msg.chatId)
        deps.log('ONBOARDING', `name set chat=${msg.chatId} → "${proposed}"`)

        // Ack reply that quotes the original trigger.
        await deps.sendMessage(
          msg.chatId,
          `好的 ${proposed}, 刚才你说「${stored.triggerText}」, 回答下：`,
        )

        // Re-dispatch the original first message through the normal pipeline
        // (fire-and-forget; nickname is already persisted, so onboarding succeeded).
        void deps.dispatchInbound(stored.fromMessage).catch(err => {
          deps.log('ONBOARDING', `echo dispatch failed chat=${msg.chatId}: ${err}`)
        })
        return true
      }

      // First contact (or stale awaiting state past timeout): greet + start the clock.
      awaiting.set(msg.chatId, { since: now(), triggerText: msg.text, fromMessage: msg })
      deps.log('ONBOARDING', `start chat=${msg.chatId} userId=${msg.userId}`)
      await deps.sendMessage(
        msg.chatId,
        `你好呀！我是 ${deps.botName(msg.chatId)}，先问一下我应该怎么称呼你？比如「Nate」「丸子」（中文 / 英文都行）。`,
      )
      return true
    },
  }
}
