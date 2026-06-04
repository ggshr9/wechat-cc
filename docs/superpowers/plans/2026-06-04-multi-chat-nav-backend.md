# Multi-chat Navigation — Backend (CLI) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add chat-aware reads to the `sessions` CLI so the desktop pane can browse sessions per WeChat contact: a new `sessions list-chats` and an optional `--chat <chat_id>` filter on `list-projects`, `read-jsonl`, and `delete`.

**Architecture:** The session store is already triple-keyed `(alias, provider, chat_id)` (`src/core/session-store.ts`, DB v10). The current CLI collapses `chat_id` away (dedupe-per-alias). We add `list-chats` (groups the store by `chat_id`, joins names from the conversations store) and thread an optional `--chat` through the three existing commands. **The no-`--chat` behavior of every existing command is left byte-for-byte unchanged** so current dashboard consumers keep working; `--chat` is purely additive. `delete --chat` also fixes a latent bug where `delete <alias>` wipes *every* chat's session under that alias.

**Tech Stack:** TypeScript, Bun, citty (CLI), zod (schemas), vitest. This plan is backend-only and fully unit-testable; the desktop UI that consumes these shapes is a separate follow-on plan.

**Spec:** `docs/superpowers/specs/2026-06-03-multi-chat-nav-design.md`

---

## Background — exact current state (read before starting)

- The `sessions` namespace registers subcommands at `cli.ts:631-636`:
  ```ts
  subCommands: {
    'list-projects': sessionsListProjectsCmd,
    'read-jsonl': sessionsReadJsonlCmd,
    delete: sessionsDeleteCmd,
    search: sessionsSearchCmd,
  },
  ```
- `sessionsListProjectsCmd` (`cli.ts:449-519`): builds `store.all()` (keyed `${alias}|${provider}|${chatId}`), dedupes to one row per alias (`:466-472`), emits `SessionsListProjectsOutput`.
- `sessionsReadJsonlCmd` (`cli.ts:521-583`): picks the most-recent row across all provider/chat for the alias (`:537-541`), then reads claude/codex jsonl.
- `sessionsDeleteCmd` (`cli.ts:585-606`): collects **every** `chat_id` under the alias (`:598-601`) and deletes them all.
- Store API (`src/core/session-store.ts`): `all(): Record<string, SessionRecord>`, `delete(key: { alias: string; chatId: string }): void`, `get(key: SessionStoreKey): SessionRecord | null`. `SessionRecord` has `alias, provider, chat_id, session_id, last_used_at, summary?, summary_updated_at?`.
- Conversations store (`src/core/conversation-store.ts`): `getIdentity(chatId): { user_id, account_id, last_user_name } | null`. Constructed via `makeConversationStore(db)` (confirm the exact factory name in Task 1, Step 0).
- Schemas live in `src/cli/schema.ts`; `SessionsListProjectsOutput`, `SessionsReadJsonlOutput`, `SessionsDeleteOutput` already exist (`:443-492`). CLI schema tests live in `src/cli/schema.test.ts`.
- Test runner: **`bun run test`** (NOT `bun test` — different runner, false failures). `bun run typecheck` is `tsc --noEmit`.

A new CLI-handler unit test file does not exist for `cli.ts` directly (handlers run via citty). We test the **pure grouping/filtering helpers** we extract, plus the **zod schema** for `list-chats`. Extracting the helpers (rather than testing through citty's arg parsing) keeps tests fast and direct, and matches the "pure function" testing pattern already used across the repo.

---

## File Structure

- **Create** `src/cli/sessions-helpers.ts` — pure functions: `groupChats(records)`, `filterProjectsByChat(records, chatId)`, `pickReadRecord(records, alias, chatId?)`, `chatsToDelete(records, alias, chatId?)`. One responsibility: turn `SessionRecord[]` + an optional chat filter into the shapes the commands emit. Pure, no I/O — directly unit-testable.
- **Create** `src/cli/sessions-helpers.test.ts` — unit tests for the four helpers.
- **Modify** `src/cli/schema.ts` — add `SessionsListChatsOutput`.
- **Modify** `src/cli/schema.test.ts` — a parse test for `SessionsListChatsOutput`.
- **Modify** `cli.ts` — new `sessionsListChatsCmd`; thread `--chat` into the three existing commands by delegating to the helpers; register `list-chats`.

The helpers carry the logic; the citty commands become thin I/O wrappers (open db → call helper → emit). This is the decomposition that makes the behavior testable without spawning the CLI.

---

## Task 1: `groupChats` helper + `SessionsListChatsOutput` schema

**Files:**
- Create: `src/cli/sessions-helpers.ts`
- Create: `src/cli/sessions-helpers.test.ts`
- Modify: `src/cli/schema.ts`
- Modify: `src/cli/schema.test.ts`

- [ ] **Step 0: Confirm the conversation-store factory + identity shape**

Run: `grep -n 'export function make\|getIdentity' src/core/conversation-store.ts`
Expected: a factory like `makeConversationStore(db)` and `getIdentity(chatId): { user_id, account_id, last_user_name } | null`. Use the exact names you find in the command wiring in Task 5. (The helper itself does NOT touch the store — names are passed in.)

- [ ] **Step 1: Write the failing test for `groupChats`**

Create `src/cli/sessions-helpers.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { groupChats } from './sessions-helpers'
import type { SessionRecord } from '../core/session-store'

function rec(p: Partial<SessionRecord>): SessionRecord {
  return {
    alias: 'a', provider: 'claude', chat_id: 'c', session_id: 's',
    last_used_at: '2026-06-01T00:00:00.000Z', summary: null, summary_updated_at: null,
    ...p,
  } as SessionRecord
}

describe('groupChats', () => {
  it('groups records by chat_id, counts distinct aliases, takes max last_used_at, sorts desc', () => {
    const records = [
      rec({ chat_id: 'c1', alias: 'wechat-cc', last_used_at: '2026-06-01T10:00:00.000Z' }),
      rec({ chat_id: 'c1', alias: 'blog',      last_used_at: '2026-06-03T10:00:00.000Z' }),
      rec({ chat_id: 'c1', alias: 'blog', provider: 'codex', last_used_at: '2026-06-02T10:00:00.000Z' }),
      rec({ chat_id: 'c2', alias: 'wechat-cc', last_used_at: '2026-06-04T10:00:00.000Z' }),
    ]
    const nameOf = (id: string) => (id === 'c1' ? '小白' : null)
    const accountOf = (id: string) => (id === 'c1' ? 'bot1' : null)
    const out = groupChats(records, nameOf, accountOf)
    expect(out).toEqual([
      { chat_id: 'c2', user_name: null, account_id: null, session_count: 1, last_used_at: '2026-06-04T10:00:00.000Z' },
      { chat_id: 'c1', user_name: '小白', account_id: 'bot1', session_count: 2, last_used_at: '2026-06-03T10:00:00.000Z' },
    ])
  })

  it('returns [] for no records', () => {
    expect(groupChats([], () => null, () => null)).toEqual([])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test src/cli/sessions-helpers.test.ts`
Expected: FAIL — `groupChats` is not defined (module not found / not exported).

- [ ] **Step 3: Implement `groupChats`**

Create `src/cli/sessions-helpers.ts`:

```ts
import type { SessionRecord } from '../core/session-store'

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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test src/cli/sessions-helpers.test.ts`
Expected: PASS (both cases).

- [ ] **Step 5: Add the `SessionsListChatsOutput` schema**

In `src/cli/schema.ts`, immediately after the `SessionsListProjectsOutput` block (after `export type SessionsListProjectsOutputT = ...`, ~`:461`), add:

```ts
// ── wechat-cc sessions list-chats --json ──────────────────────────────────────
// Emits { ok: true, chats: ChatEntry[] } for the desktop contact sidebar.
const ChatEntry = z.object({
  chat_id: z.string(),
  user_name: z.string().nullable(),
  account_id: z.string().nullable(),
  session_count: z.number(),
  last_used_at: z.string(),
})

export const SessionsListChatsOutput = z.object({
  ok: z.literal(true),
  chats: z.array(ChatEntry),
})
export type SessionsListChatsOutputT = z.infer<typeof SessionsListChatsOutput>
```

- [ ] **Step 6: Add a schema parse test**

In `src/cli/schema.test.ts`, after the `list-projects` schema test block (~`:553-589`), add:

```ts
// ── wechat-cc sessions list-chats --json ──────────────────────────────────────
import { SessionsListChatsOutput } from './schema'

describe('SessionsListChatsOutput', () => {
  it('parses a valid chats envelope', () => {
    const ok = SessionsListChatsOutput.parse({
      ok: true,
      chats: [{ chat_id: 'c1', user_name: '小白', account_id: 'bot1', session_count: 2, last_used_at: '2026-06-03T10:00:00.000Z' }],
    })
    expect(ok.chats[0]!.chat_id).toBe('c1')
  })
  it('allows null name/account', () => {
    const ok = SessionsListChatsOutput.parse({
      ok: true,
      chats: [{ chat_id: 'c2', user_name: null, account_id: null, session_count: 1, last_used_at: '2026-06-04T10:00:00.000Z' }],
    })
    expect(ok.chats[0]!.user_name).toBeNull()
  })
})
```

Note: if `schema.test.ts` already imports from `./schema` at the top with a combined import, add `SessionsListChatsOutput` to that existing import instead of a second `import` line. Check first: `grep -n "from './schema'" src/cli/schema.test.ts`.

- [ ] **Step 7: Run schema + helper tests**

Run: `bun run test src/cli/sessions-helpers.test.ts src/cli/schema.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/cli/sessions-helpers.ts src/cli/sessions-helpers.test.ts src/cli/schema.ts src/cli/schema.test.ts
git commit -m "feat(cli): groupChats helper + SessionsListChatsOutput schema"
```

---

## Task 2: `sessions list-chats` command

**Files:**
- Modify: `cli.ts` (new `sessionsListChatsCmd`; register in the sessions namespace)

- [ ] **Step 1: Add the `sessionsListChatsCmd` command**

In `cli.ts`, immediately before `const sessionsCmd = defineCommand({` (the namespace block at ~`:629`), add:

```ts
const sessionsListChatsCmd = defineCommand({
  meta: { name: 'list-chats', description: 'Contacts (chats) that have sessions, for the pane sidebar' },
  args: {
    json: { type: 'boolean', description: 'JSON envelope' },
    'out-file': { type: 'string', description: 'Write JSON to a sibling file (avoids pipe truncation in compiled binaries)' },
  },
  async run({ args }) {
    const outFile = args['out-file']
    const { makeSessionStore } = await import('./src/core/session-store')
    const { makeConversationStore } = await import('./src/core/conversation-store')
    const { openWechatDb } = await import('./src/lib/db')
    const { groupChats } = await import('./src/cli/sessions-helpers')
    const db = openWechatDb(STATE_DIR)
    const store = makeSessionStore(db, { migrateFromFile: join(STATE_DIR, 'sessions.json') })
    const convs = makeConversationStore(db)
    const records = Object.values(store.all())
    const chats = groupChats(
      records,
      id => convs.getIdentity(id)?.last_user_name ?? null,
      id => convs.getIdentity(id)?.account_id ?? null,
    )
    if (args.json) emitJson(SessionsListChatsOutput.parse({ ok: true, chats }), outFile)
    else console.log(chats.map(c => `${c.user_name ?? c.chat_id} (${c.session_count})`).join('\n'))
  },
})
```

(If Step 0 of Task 1 found the factory is named differently than `makeConversationStore`, use that name here.)

- [ ] **Step 2: Import the schema**

At the top of `cli.ts`, find the existing import of the sessions schemas (grep `SessionsListProjectsOutput` in the import block) and add `SessionsListChatsOutput` to it. If schemas are imported lazily/inline, add `SessionsListChatsOutput` alongside `SessionsListProjectsOutput` wherever it's referenced. Verify with: `grep -n 'SessionsListProjectsOutput' cli.ts`.

- [ ] **Step 3: Register the subcommand**

In `cli.ts` at the sessions namespace `subCommands` (~`:631`), add the `list-chats` entry:

```ts
  subCommands: {
    'list-chats': sessionsListChatsCmd,
    'list-projects': sessionsListProjectsCmd,
    'read-jsonl': sessionsReadJsonlCmd,
    delete: sessionsDeleteCmd,
    search: sessionsSearchCmd,
  },
```

- [ ] **Step 4: Typecheck + smoke-run**

Run: `bun run typecheck`
Expected: exit 0.

Run: `bun cli.ts sessions list-chats --json`
Expected: a JSON envelope `{ "ok": true, "chats": [...] }` (possibly empty `chats: []` on a clean machine — that's fine; we're verifying it runs and emits valid JSON, not the contents).

- [ ] **Step 5: Commit**

```bash
git add cli.ts
git commit -m "feat(cli): sessions list-chats — contacts with sessions for the sidebar"
```

---

## Task 3: `--chat` filter on `list-projects`

**Files:**
- Modify: `src/cli/sessions-helpers.ts`, `src/cli/sessions-helpers.test.ts`
- Modify: `cli.ts` (`sessionsListProjectsCmd`)

- [ ] **Step 1: Write the failing test for `filterProjectsByChat`**

Append to `src/cli/sessions-helpers.test.ts`:

```ts
import { filterProjectsByChat } from './sessions-helpers'

describe('filterProjectsByChat', () => {
  const records = [
    rec({ chat_id: 'c1', alias: 'wechat-cc', last_used_at: '2026-06-01T10:00:00.000Z', session_id: 's1' }),
    rec({ chat_id: 'c1', alias: 'wechat-cc', provider: 'codex', last_used_at: '2026-06-03T10:00:00.000Z', session_id: 's2' }),
    rec({ chat_id: 'c1', alias: 'blog', last_used_at: '2026-06-02T10:00:00.000Z', session_id: 's3' }),
    rec({ chat_id: 'c2', alias: 'wechat-cc', last_used_at: '2026-06-04T10:00:00.000Z', session_id: 's4' }),
  ]

  it('returns only the given chat, one row per alias (most-recent provider wins)', () => {
    const out = filterProjectsByChat(records, 'c1')
    // wechat-cc: codex row (s2, 06-03) beats claude (s1, 06-01); blog: s3
    expect(out.map(p => [p.alias, p.session_id]).sort()).toEqual([['blog', 's3'], ['wechat-cc', 's2']])
  })

  it('excludes other chats entirely', () => {
    const out = filterProjectsByChat(records, 'c2')
    expect(out).toEqual([{ alias: 'wechat-cc', session_id: 's4', last_used_at: '2026-06-04T10:00:00.000Z', summary: null, summary_updated_at: null }])
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun run test src/cli/sessions-helpers.test.ts`
Expected: FAIL — `filterProjectsByChat` not exported.

- [ ] **Step 3: Implement `filterProjectsByChat`**

Append to `src/cli/sessions-helpers.ts`:

```ts
export interface ProjectEntryShape {
  alias: string
  session_id: string
  last_used_at: string
  summary: string | null
  summary_updated_at: string | null
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
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun run test src/cli/sessions-helpers.test.ts`
Expected: PASS.

- [ ] **Step 5: Thread `--chat` into `sessionsListProjectsCmd`**

In `cli.ts`, in `sessionsListProjectsCmd`:

Add to `args` (after the `json` arg, ~`:452`):
```ts
    chat: { type: 'string', description: 'Filter to one contact (chat_id)' },
```

Replace the dedupe block + `projects` mapping (`cli.ts:461-479`) with:
```ts
    const records = Object.values(store.all())
    let projects
    if (args.chat) {
      const { filterProjectsByChat } = await import('./src/cli/sessions-helpers')
      projects = filterProjectsByChat(records, args.chat)
    } else {
      // Unchanged legacy behavior: one row per alias across all chats so
      // existing dashboards keep rendering.
      const byAlias: Record<string, typeof records[number]> = {}
      for (const rec of records) {
        const prev = byAlias[rec.alias]
        if (!prev || Date.parse(rec.last_used_at) > Date.parse(prev.last_used_at)) byAlias[rec.alias] = rec
      }
      projects = Object.values(byAlias).map(rec => ({
        alias: rec.alias,
        session_id: rec.session_id,
        last_used_at: rec.last_used_at,
        summary: rec.summary ?? null,
        summary_updated_at: rec.summary_updated_at ?? null,
      }))
    }
```
(Leave everything below — the `emitJson(...)`, the background summarizer refresh — exactly as-is. `projects` keeps the same shape.)

- [ ] **Step 6: Typecheck + smoke**

Run: `bun run typecheck`
Expected: exit 0.

Run: `bun cli.ts sessions list-projects --json` (no `--chat`)
Expected: same envelope as before this change (regression-by-eyeball — `{ ok: true, projects: [...] }`).

- [ ] **Step 7: Commit**

```bash
git add src/cli/sessions-helpers.ts src/cli/sessions-helpers.test.ts cli.ts
git commit -m "feat(cli): sessions list-projects --chat filter (legacy path unchanged)"
```

---

## Task 4: `--chat` on `read-jsonl`

**Files:**
- Modify: `src/cli/sessions-helpers.ts`, `src/cli/sessions-helpers.test.ts`
- Modify: `cli.ts` (`sessionsReadJsonlCmd`)

- [ ] **Step 1: Write the failing test for `pickReadRecord`**

Append to `src/cli/sessions-helpers.test.ts`:

```ts
import { pickReadRecord } from './sessions-helpers'

describe('pickReadRecord', () => {
  const records = [
    rec({ chat_id: 'c1', alias: 'wechat-cc', last_used_at: '2026-06-01T10:00:00.000Z', session_id: 'c1-old' }),
    rec({ chat_id: 'c2', alias: 'wechat-cc', last_used_at: '2026-06-04T10:00:00.000Z', session_id: 'c2-new' }),
  ]
  it('with chatId, picks that chat\'s row (not the globally-most-recent)', () => {
    expect(pickReadRecord(records, 'wechat-cc', 'c1')?.session_id).toBe('c1-old')
  })
  it('without chatId, picks most-recent across chats (legacy)', () => {
    expect(pickReadRecord(records, 'wechat-cc', undefined)?.session_id).toBe('c2-new')
  })
  it('returns null when no row matches', () => {
    expect(pickReadRecord(records, 'nope', undefined)).toBeNull()
    expect(pickReadRecord(records, 'wechat-cc', 'cX')).toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun run test src/cli/sessions-helpers.test.ts`
Expected: FAIL — `pickReadRecord` not exported.

- [ ] **Step 3: Implement `pickReadRecord`**

Append to `src/cli/sessions-helpers.ts`:

```ts
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
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun run test src/cli/sessions-helpers.test.ts`
Expected: PASS.

- [ ] **Step 5: Thread `--chat` into `sessionsReadJsonlCmd`**

In `cli.ts`, in `sessionsReadJsonlCmd`:

Add to `args` (after `alias`, ~`:524`):
```ts
    chat: { type: 'string', description: 'Scope to one contact (chat_id)' },
```

Replace the record-pick loop (`cli.ts:537-541`):
```ts
    let rec: ReturnType<typeof store.get> = null
    for (const r of Object.values(store.all())) {
      if (r.alias !== args.alias) continue
      if (!rec || Date.parse(r.last_used_at) > Date.parse(rec.last_used_at)) rec = r
    }
```
with:
```ts
    const { pickReadRecord } = await import('./src/cli/sessions-helpers')
    const rec = pickReadRecord(Object.values(store.all()), args.alias, args.chat)
```
(Everything below — the codex branch, path resolution, jsonl read, all `emitJson` calls — stays exactly as-is.)

- [ ] **Step 6: Typecheck + smoke**

Run: `bun run typecheck`
Expected: exit 0.

Run: `bun cli.ts sessions read-jsonl somealias --json` (no `--chat`, likely "no such alias" on a clean machine — confirms the legacy path still runs and emits an envelope).

- [ ] **Step 7: Commit**

```bash
git add src/cli/sessions-helpers.ts src/cli/sessions-helpers.test.ts cli.ts
git commit -m "feat(cli): sessions read-jsonl --chat scoping (legacy path unchanged)"
```

---

## Task 5: `--chat` on `delete` (fixes delete-all-chats bug)

**Files:**
- Modify: `src/cli/sessions-helpers.ts`, `src/cli/sessions-helpers.test.ts`
- Modify: `cli.ts` (`sessionsDeleteCmd`)

- [ ] **Step 1: Write the failing test for `chatsToDelete`**

Append to `src/cli/sessions-helpers.test.ts`:

```ts
import { chatsToDelete } from './sessions-helpers'

describe('chatsToDelete', () => {
  const records = [
    rec({ chat_id: 'c1', alias: 'wechat-cc' }),
    rec({ chat_id: 'c2', alias: 'wechat-cc' }),
    rec({ chat_id: 'c1', alias: 'blog' }),
  ]
  it('with chatId, deletes only that chat under the alias (bug fix — others survive)', () => {
    expect(chatsToDelete(records, 'wechat-cc', 'c1')).toEqual(['c1'])
  })
  it('without chatId, deletes every chat under the alias (legacy)', () => {
    expect(chatsToDelete(records, 'wechat-cc', undefined).sort()).toEqual(['c1', 'c2'])
  })
  it('ignores other aliases', () => {
    expect(chatsToDelete(records, 'blog', undefined)).toEqual(['c1'])
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun run test src/cli/sessions-helpers.test.ts`
Expected: FAIL — `chatsToDelete` not exported.

- [ ] **Step 3: Implement `chatsToDelete`**

Append to `src/cli/sessions-helpers.ts`:

```ts
/**
 * The chat_ids whose (alias, chat) rows should be deleted. With chatId, just
 * that one (so deleting one contact's session leaves other contacts' rows
 * under the same alias intact). Without it, every chat under the alias (legacy).
 */
export function chatsToDelete(records: SessionRecord[], alias: string, chatId: string | undefined): string[] {
  if (chatId) {
    return records.some(r => r.alias === alias && r.chat_id === chatId) ? [chatId] : []
  }
  const chats = new Set<string>()
  for (const r of records) if (r.alias === alias) chats.add(r.chat_id)
  return [...chats]
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun run test src/cli/sessions-helpers.test.ts`
Expected: PASS.

- [ ] **Step 5: Thread `--chat` into `sessionsDeleteCmd`**

In `cli.ts`, in `sessionsDeleteCmd`:

Add to `args` (after `alias`, ~`:588`):
```ts
    chat: { type: 'string', description: 'Delete only this contact\'s session under the alias' },
```

Replace the chat-collection loop (`cli.ts:598-602`):
```ts
    const chats = new Set<string>()
    for (const rec of Object.values(store.all())) {
      if (rec.alias === args.alias) chats.add(rec.chat_id)
    }
    for (const chatId of chats) store.delete({ alias: args.alias, chatId })
```
with:
```ts
    const { chatsToDelete } = await import('./src/cli/sessions-helpers')
    const chats = chatsToDelete(Object.values(store.all()), args.alias, args.chat)
    for (const chatId of chats) store.delete({ alias: args.alias, chatId })
```
(Leave `await store.flush()` and the `emitJson`/`console.log` line as-is.)

- [ ] **Step 6: Typecheck**

Run: `bun run typecheck`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/cli/sessions-helpers.ts src/cli/sessions-helpers.test.ts cli.ts
git commit -m "fix(cli): sessions delete --chat scopes to one contact (was: deleted all chats under alias)"
```

---

## Task 6: Full backend verification

**Files:** none (verification only)

- [ ] **Step 1: Typecheck**

Run: `bun run typecheck`
Expected: exit 0.

- [ ] **Step 2: Full unit suite**

Run: `bun run test`
Expected: all files pass. The new `sessions-helpers.test.ts` (≈11 cases across the 4 helpers) and the `SessionsListChatsOutput` schema cases are green; total count is the prior baseline plus the new cases.

- [ ] **Step 3: Smoke the four CLI surfaces**

Run each and confirm a valid JSON envelope (contents may be empty on a clean machine):
```bash
bun cli.ts sessions list-chats --json
bun cli.ts sessions list-projects --json
bun cli.ts sessions list-projects --chat someid --json
bun cli.ts sessions read-jsonl somealias --chat someid --json
```
Expected: each prints `{ "ok": ... }` JSON, no stack trace.

- [ ] **Step 4: Commit (only if Steps 1–3 surfaced a fix)**

```bash
git add -A
git commit -m "chore(cli): multi-chat backend verification fixes"
```

---

## Self-Review notes (applied)

- **Spec coverage:** Backend section of the spec → `list-chats` (Task 1–2), `list-projects --chat` (Task 3), `read-jsonl --chat` (Task 4), `delete --chat` + bug-fix (Task 5). The "no-`--chat` behavior unchanged" requirement is pinned by the legacy-path tests in Tasks 3/4/5 and the smoke checks. Frontend (sidebar, single-contact-hide, Playwright) is the **separate follow-on plan** — out of scope here by design.
- **Type consistency:** the helpers return `ChatEntry` / `ProjectEntryShape` / `SessionRecord`; `ProjectEntryShape` matches the existing zod `ProjectEntry` field-for-field; `SessionsListChatsOutput.chats` matches `ChatEntry`. The four helper names (`groupChats`, `filterProjectsByChat`, `pickReadRecord`, `chatsToDelete`) are used identically in tests, helper file, and `cli.ts`.
- **No placeholders:** every step shows literal code and exact commands. The two confirm-the-name steps (conversation-store factory, schema-test import) are explicit `grep` verifications, not hand-waves.
