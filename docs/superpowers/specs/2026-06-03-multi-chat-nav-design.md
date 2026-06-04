# Multi-chat navigation in the sessions pane — design

**Date**: 2026-06-03
**Status**: approved (brainstorming) → ready for implementation plan
**Backlog**: P2 "多 chat / 多账号导航" (project_backlog_2026_04_29 §2)

## Problem

The desktop sessions pane lists **one row per project alias**, explicitly deduplicating away the `chat_id` dimension (`src/cli/sessions.ts` / `cli.ts:466-472`, commented *"Per-chat browsing is a v0.7+ feature"*). When more than one WeChat contact uses the same alias, only the most-recently-active one is reachable — the others are invisible. Post-v0.6 per-chat session isolation (sessions keyed `(alias, provider, chat_id)`, DB v10) makes this a real gap: a user with multiple contacts cannot browse each contact's sessions.

## Goal

Add a **contact (chat) dimension** to the sessions pane: a left contact sidebar; selecting a contact filters the existing session list to that contact. The transcript detail view is unchanged.

**Non-goals (YAGNI):**
- No **account** dimension. The user runs a single bot login; `account` does not appear in the UI. (Confirmed during brainstorming.)
- No change to the transcript/detail rendering (WeChat-replica + raw modes stay as-is).
- No WebSocket push (separate backlog item §3); keep the existing polling.

## Dimensions

- **chat** (contact) = `chat_id` (opaque `…@im.wechat`); display name = `conversations.last_user_name`.
- **alias** (project) = existing dimension.
- A contact may have used multiple aliases; an alias may serve multiple contacts. The sessions store's `(alias, provider, chat_id)` key already captures this.

## UX / navigation

```
┌────────┬─────────────────────┐
│ 小白  ●│ 今天                 │
│ 小明   │  ▸ wechat-cc  2:14p  │
│ 工作群 │  ▸ blog       昨天    │
│        │ 7 天内               │
│        │  ▸ …                 │
└────────┴─────────────────────┘
 contacts      that contact's sessions
```

- **Contact sidebar (left):** lists contacts that have at least one session, name from `last_user_name` (fallback: `chat_id` prefix), reusing the existing `avatarInfo(deps, chatId)` for avatars. Sorted most-recently-active first; the active contact is highlighted. Mirrors the memory pane's `#memory-sidebar` pattern for visual + code consistency.
- **Session list (right):** the **existing** recency-grouped list (`projectRow` / `groupProjectsByRecency`), filtered to the selected contact. Clicking a session opens the **existing** transcript detail unchanged.
- **Default selection on open:** the most-recently-active contact.
- **Single-contact grace:** when exactly one contact has sessions, the sidebar is **hidden** and the pane renders exactly as it does today — no regression for the common single-contact setup.
- **Search:** scopes to the selected contact (consistent with the filtered view).

## Backend / CLI surface

The blocker is the per-alias dedup. We add chat-aware reads without changing the existing (no-`--chat`) behavior other consumers rely on.

1. **`sessions list-chats --json`** (new) → for the sidebar:
   ```
   { ok: true, chats: [{ chat_id, user_name | null, account_id | null, session_count, last_used_at }] }
   ```
   Derived from the un-deduped session store (`makeSessionStore(db).all()`), grouped by `chat_id`, joined to `ConversationStore.getIdentity(chatId)` for `user_name`. `session_count` = number of distinct aliases for that chat (matches what the filtered right-panel list will show); `last_used_at` = max across the chat's rows. Sorted by `last_used_at` desc.

2. **`sessions list-projects --chat <chat_id> --json`** (extend) → the **existing** `ProjectEntry` shape, filtered to one contact: rows where `chat_id === <chat_id>`, one row per `alias` within that chat (most-recent provider wins). **Without `--chat`, behavior is unchanged** (per-alias dedup across all chats — existing consumers keep rendering).

3. **`sessions read-jsonl <alias> --chat <chat_id> --json`** (extend) → resolve the `(alias, provider, chat_id)` row for the given chat instead of "most-recent across all chats." Without `--chat`, unchanged.

4. **`sessions delete <alias> --chat <chat_id>`** (extend) → delete only the `(alias, chat)` rows. **This fixes a latent bug:** today `sessions delete <alias>` iterates and deletes *every* chat's session under the alias (`cli.ts:598-602`); once per-chat browsing exists, a delete from the UI must target exactly the selected contact's session. Without `--chat`, behavior is unchanged (delete-all-under-alias) so non-UI callers are unaffected.

Schemas in `src/cli/schema.ts`: add `SessionsListChatsOutput`; `--chat` is an optional input on the three existing commands; `ProjectEntry` is unchanged.

## Data flow

```
pane open
  → invoke sessions list-chats --json
  → render contact sidebar; if chats.length <= 1, hide sidebar
  → auto-select chats[0]
  → invoke sessions list-projects --chat <id> --json
  → render filtered session list (existing render path)

click session row
  → openProjectDetail(deps, alias, { chatId })
  → invoke sessions read-jsonl <alias> --chat <id> --json
  → render transcript (existing); store detail.dataset.chatId alongside detail.dataset.alias

4s detail auto-refresh
  → re-invoke read-jsonl <alias> --chat <chatId-from-dataset>   (correct session, not "most recent")

click delete
  → invoke sessions delete <alias> --chat <chatId>
```

- Same `deps.invoke("wechat_cli_json", { args: [...] })` abstraction as today, working under both Tauri (`window.__TAURI__.core.invoke`) and the dev shim (`POST /__invoke`). The dev shim gets DRY_RUN intercepts for `list-chats` and the `--chat`-filtered calls.

## Edge cases

- **Zero contacts / zero sessions:** sidebar empty-state copy (narrative, consistent with memory pane); right panel shows the existing empty state.
- **One contact:** sidebar hidden (above).
- **Contact with no `last_user_name`:** fall back to `chat_id` prefix (same as memory pane's `userId.split("@")[0]`).
- **Selected contact deleted (all its sessions removed):** re-run `list-chats`, re-select first; if none remain, show empty state.

## Testing

**CLI unit tests** (`src/cli/sessions.test.ts` or equivalent):
- `list-chats` groups the un-deduped store by chat, joins names, counts sessions, sorts by recency.
- `list-projects --chat X` returns only chat X's rows, one per alias; no-`--chat` path still dedups across chats (regression pin).
- `read-jsonl --chat X` resolves the X row, not the most-recent-across-chats.
- `delete --chat X` removes only X's `(alias, chat)` rows and **leaves other chats' rows intact** (the bug-fix pin); no-`--chat` still deletes all under the alias.

**Playwright specs** (`apps/desktop/playwright/sessions.spec.ts` + shim mocks):
- sidebar renders one entry per seeded contact;
- selecting a contact filters the session list to that contact;
- single-contact seed → sidebar hidden, pane looks like today;
- clicking delete targets only the selected contact (other contact's sessions remain);
- detail auto-refresh re-queries with the stored chat_id.

## Files

- `src/cli/sessions.ts` (command handlers; add `list-chats`, thread `--chat`)
- `src/cli/schema.ts` (`SessionsListChatsOutput`, optional `--chat` inputs)
- `apps/desktop/src/modules/sessions.js` (sidebar render + select + filter + chatId on detail dataset)
- `apps/desktop/src/index.html` (sidebar markup in the sessions pane), `styles.css` (sidebar styles — reuse memory-sidebar styles where possible)
- `apps/desktop/test-shim.ts` (DRY_RUN intercepts for the new/extended calls)
- Tests: CLI unit + Playwright specs above

## Open follow-ups (not in this scope)

- Extracting a shared contact-list component between the memory sidebar and the sessions sidebar (DRY) — deferred; mirror the pattern now, abstract later if a third consumer appears.
- WebSocket push (backlog §3).
