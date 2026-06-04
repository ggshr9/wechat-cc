import type { SessionRecord } from '../core/session-store'

export interface ProjectEntryShape {
  alias: string
  session_id: string
  last_used_at: string
  summary: string | null
  summary_updated_at: string | null
}

export interface ChatEntry {
  chat_id: string
  user_name: string | null
  account_id: string | null
  session_count: number
  last_used_at: string
}

/**
 * Group session records by chat_id. `session_count` is the number of
 * distinct aliases for that chat (what the filtered right-panel list shows);
 * `last_used_at` is the max across the chat's rows. Sorted most-recent first.
 * Name/account are resolved via the injected lookups (kept pure — no store I/O).
 */
export function groupChats(
  records: SessionRecord[],
  nameOf: (chatId: string) => string | null,
  accountOf: (chatId: string) => string | null,
): ChatEntry[] {
  const byChat = new Map<string, { aliases: Set<string>; last: string }>()
  for (const r of records) {
    const g = byChat.get(r.chat_id) ?? { aliases: new Set<string>(), last: r.last_used_at }
    g.aliases.add(r.alias)
    if (Date.parse(r.last_used_at) > Date.parse(g.last)) g.last = r.last_used_at
    byChat.set(r.chat_id, g)
  }
  return [...byChat.entries()]
    .map(([chat_id, g]) => ({
      chat_id,
      user_name: nameOf(chat_id),
      account_id: accountOf(chat_id),
      session_count: g.aliases.size,
      last_used_at: g.last,
    }))
    .sort((a, b) => Date.parse(b.last_used_at) - Date.parse(a.last_used_at))
}

/**
 * Rows for one chat, deduped to one entry per alias (most-recent row wins).
 * Mirrors the existing list-projects ProjectEntry shape so the UI render
 * path is unchanged.
 */
export function filterProjectsByChat(records: SessionRecord[], chatId: string): ProjectEntryShape[] {
  const byAlias: Record<string, SessionRecord> = {}
  for (const r of records) {
    if (r.chat_id !== chatId) continue
    const prev = byAlias[r.alias]
    if (!prev || Date.parse(r.last_used_at) > Date.parse(prev.last_used_at)) byAlias[r.alias] = r
  }
  return Object.values(byAlias).map(r => ({
    alias: r.alias,
    session_id: r.session_id,
    last_used_at: r.last_used_at,
    summary: r.summary ?? null,
    summary_updated_at: r.summary_updated_at ?? null,
  }))
}

/**
 * The session row to read for (alias[, chatId]). With chatId, scope to that
 * contact; without it, the legacy "most-recent across all chats" pick.
 */
export function pickReadRecord(
  records: SessionRecord[],
  alias: string,
  chatId: string | undefined,
): SessionRecord | null {
  let best: SessionRecord | null = null
  for (const r of records) {
    if (r.alias !== alias) continue
    if (chatId && r.chat_id !== chatId) continue
    if (!best || Date.parse(r.last_used_at) > Date.parse(best.last_used_at)) best = r
  }
  return best
}
