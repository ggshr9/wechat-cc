/**
 * account-chat-index — in-memory `Map<accountId, Set<chatId>>`.
 *
 * Populated by transport.markChatActive on every inbound; queried by
 * onAccountExpired to fan out user-facing notifications when an account's
 * session is rejected by ilink (errcode=-14, "rebound elsewhere").
 *
 * NOT persisted: a daemon restart loses the index, but it's repopulated
 * on the first inbound per chat. The corner case where an expired account
 * never sees another inbound (because it's expired!) means the in-chat
 * notification may be missed for chats that haven't messaged since boot —
 * desktop badge + dashboard signal cover this gap (PR4 Task 16).
 *
 * To be replaced by `WHERE account_id = ?` SQL query once PR5 lands the
 * `account_id` column on the conversations table.
 */
export interface AccountChatIndex {
  record(accountId: string, chatId: string): void
  chatsFor(accountId: string): readonly string[]
}

export function makeAccountChatIndex(): AccountChatIndex {
  const map = new Map<string, Set<string>>()
  return {
    record(accountId, chatId) {
      if (!accountId) return
      let set = map.get(accountId)
      if (!set) { set = new Set(); map.set(accountId, set) }
      set.add(chatId)
    },
    chatsFor(accountId) {
      const s = map.get(accountId)
      return s ? Array.from(s) : []
    },
  }
}
