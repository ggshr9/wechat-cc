/**
 * Conversation, Mode, Participant — RFC 03 §3.3 head-of-water types.
 *
 * Replaces the implicit "1 chat = 1 alias = 1 session" model that lived
 * inside SessionManager + message-router with an explicit Conversation
 * data class that has 1+ Participants. P2 ships solo mode only; the
 * other Mode variants are typed but the coordinator throws on dispatch
 * until P3-P5 land.
 *
 * Open string ProviderId per RFC 03 §3.3: not a closed union, so adding
 * a new provider doesn't ripple through every Mode/Conversation
 * persistence schema. Validation happens at runtime against
 * ProviderRegistry membership.
 */

export type ProviderId = string

export type Mode =
  /** Single agent answers each inbound. The default. */
  | { kind: 'solo'; provider: ProviderId }
  /** One primary agent; the other is exposed as a `mcp__delegate__*` tool. (P4 — not yet operational.) */
  | { kind: 'primary_tool'; primary: ProviderId }
  /** Two agents reply concurrently to each inbound. (P3 — not yet operational.) */
  | { kind: 'parallel' }
  /** Two agents take turns with @addressing routing. (P5 — not yet operational.) */
  | { kind: 'chatroom' }

/**
 * The runtime view of a conversation. `participants` is the live set of
 * agent sessions; for solo mode there is exactly one. For parallel /
 * chatroom there are two (P3+).
 *
 * Conversation is value-typed for mode + chat_id + project; the live
 * `participants` field is excluded from persistence (it's reconstructed
 * on demand by the coordinator).
 */
export interface Conversation {
  chatId: string
  projectAlias: string
  projectPath: string
  mode: Mode
  participants: Participant[]
}

/**
 * One agent session inside a Conversation. The threadId is what we
 * persist for resume across daemon restart (mirrors the existing
 * session-store record). The handle is whatever the SessionManager
 * returned for this (provider, alias).
 */
export interface Participant {
  provider: ProviderId
  threadId: string | null
  // Intentionally `unknown` here: this module is type-only and must not
  // import the SessionManager runtime types (would create a cycle with
  // session-manager.ts which depends on this file's ProviderId). The
  // ConversationCoordinator narrows on use.
  handle: unknown
}

/**
 * Persistence shape for `conversations.json`. ChatId → mode + optional
 * primary marker for primary_tool mode. The runtime fills in
 * projectAlias/projectPath at acquire time via the project resolver.
 */
export interface PersistedConversation {
  mode: Mode
}
