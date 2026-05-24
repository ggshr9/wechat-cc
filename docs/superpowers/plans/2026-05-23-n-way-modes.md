# N-way Modes (P3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drop the hard 2-tuple constraint on `parallel` and `chatroom` modes so operators can run `/chat claude codex cursor` (3-way chatroom) and `/parallel claude cursor` (explicit 2-way parallel). With cursor now registered as a third provider, this unlocks the multi-provider feature's user-facing value.

**Architecture:** Add `participants?: ProviderId[]` to the `parallel` and `chatroom` Mode variants. The coordinator resolves the active participants list per dispatch via `resolveParticipants(mode, registry, store, chatId)` — explicit list > legacy-row backfill (first-two-registered, persisted) > all-registered fallback. Hard cap at 3 participants in P1. Single additive DB migration v11 stores the column as nullable JSON-encoded TEXT. The chatroom moderator's participant type relaxes from `[A,B]` to `ProviderId[]`; its prompt enumerates each participant by name.

**Tech Stack:** TypeScript, bun:sqlite, vitest. Builds on `docs/superpowers/specs/2026-05-23-n-way-modes-design.md`.

---

### Task 1: Mode types — add `participants?: ProviderId[]`

**Files:**
- Modify: `src/core/conversation.ts:18-26`

- [ ] **Step 1: Extend the Mode union**

Replace the existing Mode definition with:

```ts
export type Mode =
  /** Single agent answers each inbound. The default. */
  | { kind: 'solo'; provider: ProviderId }
  /** One primary agent; the other is exposed as a `mcp__delegate__*` tool. (P4 — not yet operational.) */
  | { kind: 'primary_tool'; primary: ProviderId }
  /** N agents reply concurrently to each inbound (≥2). Undefined `participants` resolves to the registry's full list at dispatch time. */
  | { kind: 'parallel'; participants?: ProviderId[] }
  /** N agents take turns under moderator control (≥2). Undefined `participants` resolves to the registry's full list at dispatch time. */
  | { kind: 'chatroom'; participants?: ProviderId[] }
```

Update the surrounding JSDoc on `Participant`/`Conversation` (currently says "for parallel/chatroom there are two") to say "for parallel/chatroom there are 2 or more, capped at 3 in P1."

- [ ] **Step 2: Run typecheck — expect new errors**

Run: `bun run typecheck`
Expected: errors in `conversation-coordinator.ts` (parallelProviders 2-tuple destructure), `chatroom-moderator.ts` (participants type expects 2-tuple), `conversation-store.ts` (modeColumns/rowToMode missing participants), `mode-commands.test.ts` (existing tests still compile but won't cover new shape). These errors get fixed by the next tasks; this step confirms the type change has the expected blast radius.

- [ ] **Step 3: Commit**

```bash
git add src/core/conversation.ts
git commit -m "feat(conversation): add participants?: ProviderId[] to parallel/chatroom Mode"
```

---

### Task 2: DB migration v11 — `participants` column

**Files:**
- Modify: `src/lib/db.ts` (append a new migration at the end of the `migrations` array, around line 226)

- [ ] **Step 1: Write the failing test**

Add to `src/lib/db.test.ts` (or whichever existing db test file holds migration assertions — search with `grep -l "user_version\|PRAGMA" src/**/*.test.ts`; if none, append to `src/core/conversation-store.test.ts` next to the existing schema tests):

```ts
import { describe, test, expect } from 'vitest'
import { Database } from 'bun:sqlite'
import { openDb } from './db'

describe('migration v11 — participants column', () => {
  test('adds nullable TEXT participants column to conversations', () => {
    const db = openDb({ path: ':memory:' })
    const cols = db.query<{ name: string; type: string; notnull: number }, []>(
      "SELECT name, type, [notnull] FROM pragma_table_info('conversations')"
    ).all()
    const col = cols.find(c => c.name === 'participants')
    expect(col).toBeDefined()
    expect(col!.type).toBe('TEXT')
    expect(col!.notnull).toBe(0)
  })

  test('pre-v11 rows hydrate with NULL participants', () => {
    // Simulate a pre-v11 row by inserting via the older shape (no participants).
    const db = openDb({ path: ':memory:' })
    db.exec(
      "INSERT INTO conversations(chat_id, mode_kind, mode_provider, mode_primary, updated_at) " +
      "VALUES ('legacy-chat', 'chatroom', NULL, NULL, '2026-05-22T00:00:00.000Z')"
    )
    const row = db.query<{ participants: string | null }, []>(
      "SELECT participants FROM conversations WHERE chat_id = 'legacy-chat'"
    ).get()
    expect(row).toBeDefined()
    expect(row!.participants).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify failure**

Run: `bun test src/lib/db.test.ts -t 'migration v11'`
Expected: FAIL — `col` is undefined, no participants column.

- [ ] **Step 3: Add the migration**

In `src/lib/db.ts`, append after the v10 migration (the one ending around line 226):

```ts
  // v11 — participants column on conversations (N-way modes, P3).
  // Nullable JSON-encoded TEXT array of provider ids. NULL on pre-v11 rows
  // (legacy 2-way parallel/chatroom); the coordinator's resolveParticipants
  // helper backfills these to the first-two-registered providers on first
  // dispatch under the new code so the user's "this chat was 2-way"
  // expectation is preserved. New explicit /chat <p1> <p2> ... commands
  // write the list directly.
  // See docs/superpowers/specs/2026-05-23-n-way-modes-design.md.
  (db) => {
    db.exec(`ALTER TABLE conversations ADD COLUMN participants TEXT;`)
  },
```

- [ ] **Step 4: Run test to verify pass**

Run: `bun test src/lib/db.test.ts -t 'migration v11'`
Expected: PASS, both cases.

- [ ] **Step 5: Run the full db test file to ensure no regression**

Run: `bun test src/lib/db.test.ts`
Expected: all migrations 1..11 apply cleanly; no schema test broken.

- [ ] **Step 6: Commit**

```bash
git add src/lib/db.ts src/lib/db.test.ts
# (or whichever test file you added to)
git commit -m "feat(db): migration v11 — add nullable participants column"
```

---

### Task 3: ConversationStore — serialize/deserialize participants

**Files:**
- Modify: `src/core/conversation-store.ts:72-108` (Row, rowToMode, modeColumns)
- Modify: `src/core/conversation-store.ts:114-124` (stmtGet, stmtUpsert, stmtAll SQL)
- Modify: `src/core/conversation-store.ts:151-203` (the public ConversationStore impl)
- Test: `src/core/conversation-store.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/core/conversation-store.test.ts`:

```ts
import { describe, test, expect } from 'vitest'
import { openDb } from '../lib/db'
import { makeConversationStore } from './conversation-store'

describe('conversation-store — participants', () => {
  test('round-trips chatroom mode with explicit participants', () => {
    const db = openDb({ path: ':memory:' })
    const store = makeConversationStore(db)
    store.set('chat-3way', { kind: 'chatroom', participants: ['claude', 'codex', 'cursor'] })
    const got = store.get('chat-3way')
    expect(got?.mode).toEqual({ kind: 'chatroom', participants: ['claude', 'codex', 'cursor'] })
  })

  test('round-trips parallel mode with explicit participants', () => {
    const db = openDb({ path: ':memory:' })
    const store = makeConversationStore(db)
    store.set('chat-par', { kind: 'parallel', participants: ['claude', 'cursor'] })
    const got = store.get('chat-par')
    expect(got?.mode).toEqual({ kind: 'parallel', participants: ['claude', 'cursor'] })
  })

  test('omits participants field when undefined (no JSON in DB)', () => {
    const db = openDb({ path: ':memory:' })
    const store = makeConversationStore(db)
    store.set('chat-default', { kind: 'parallel' })
    const got = store.get('chat-default')
    // Mode comes back without the participants key (undefined, not null).
    expect(got?.mode).toEqual({ kind: 'parallel' })
    expect('participants' in (got!.mode as object)).toBe(false)
  })

  test('hydrates legacy row (no participants column populated) as undefined', () => {
    const db = openDb({ path: ':memory:' })
    db.exec(
      "INSERT INTO conversations(chat_id, mode_kind, mode_provider, mode_primary, updated_at) " +
      "VALUES ('legacy', 'chatroom', NULL, NULL, '2026-05-22T00:00:00.000Z')"
    )
    const store = makeConversationStore(db)
    const got = store.get('legacy')
    expect(got?.mode).toEqual({ kind: 'chatroom' })
  })

  test('setParticipants updates only the participants column', () => {
    const db = openDb({ path: ':memory:' })
    const store = makeConversationStore(db)
    store.set('chat-bf', { kind: 'chatroom' })
    store.setParticipants('chat-bf', ['claude', 'codex'])
    const got = store.get('chat-bf')
    expect(got?.mode).toEqual({ kind: 'chatroom', participants: ['claude', 'codex'] })
  })

  test('setParticipants is a no-op on a chat with no row', () => {
    const db = openDb({ path: ':memory:' })
    const store = makeConversationStore(db)
    // Should not throw, should not insert a synthetic row.
    store.setParticipants('nonexistent', ['claude', 'codex'])
    expect(store.get('nonexistent')).toBeNull()
  })

  test('rejects setParticipants on solo/primary_tool modes (only parallel/chatroom support it)', () => {
    const db = openDb({ path: ':memory:' })
    const store = makeConversationStore(db)
    store.set('chat-solo', { kind: 'solo', provider: 'claude' })
    expect(() => store.setParticipants('chat-solo', ['claude', 'codex']))
      .toThrow(/only parallel\/chatroom/)
  })
})
```

- [ ] **Step 2: Run tests to verify failure**

Run: `bun test src/core/conversation-store.test.ts -t 'participants'`
Expected: FAIL — `setParticipants` doesn't exist; round-trip drops the participants field.

- [ ] **Step 3: Update the Row interface**

In `src/core/conversation-store.ts` modify the `Row` interface (around line 72):

```ts
interface Row {
  chat_id: string
  mode_kind: string
  mode_provider: string | null
  mode_primary: string | null
  participants: string | null    // JSON array of ProviderId, or NULL
  user_id: string | null
  account_id: string | null
  last_user_name: string | null
}
```

- [ ] **Step 4: Update rowToMode and modeColumns**

Replace `rowToMode` (lines 82-95):

```ts
function rowToMode(r: Row): Mode | null {
  const participants = r.participants ? parseParticipants(r.participants) : undefined
  switch (r.mode_kind) {
    case 'solo':
      return r.mode_provider ? { kind: 'solo', provider: r.mode_provider } : null
    case 'primary_tool':
      return r.mode_primary ? { kind: 'primary_tool', primary: r.mode_primary } : null
    case 'parallel':
      return participants ? { kind: 'parallel', participants } : { kind: 'parallel' }
    case 'chatroom':
      return participants ? { kind: 'chatroom', participants } : { kind: 'chatroom' }
    default:
      return null
  }
}

function parseParticipants(json: string): ProviderId[] | undefined {
  try {
    const v = JSON.parse(json)
    if (!Array.isArray(v)) return undefined
    if (!v.every((p): p is string => typeof p === 'string')) return undefined
    return v
  } catch {
    return undefined  // corrupt JSON → treat as legacy
  }
}
```

(Add `import type { ProviderId }` to the import list at the top if not already present — it should be alongside `Mode`.)

Replace `modeColumns` (lines 97-108):

```ts
function modeColumns(mode: Mode): { kind: string; provider: string | null; primary: string | null; participants: string | null } {
  switch (mode.kind) {
    case 'solo':
      return { kind: 'solo', provider: mode.provider, primary: null, participants: null }
    case 'primary_tool':
      return { kind: 'primary_tool', provider: null, primary: mode.primary, participants: null }
    case 'parallel':
      return {
        kind: 'parallel', provider: null, primary: null,
        participants: mode.participants ? JSON.stringify(mode.participants) : null,
      }
    case 'chatroom':
      return {
        kind: 'chatroom', provider: null, primary: null,
        participants: mode.participants ? JSON.stringify(mode.participants) : null,
      }
  }
}
```

- [ ] **Step 5: Update SQL statements and store impl**

Replace the prepared statements (around lines 114-124):

```ts
  const stmtGet = db.query<Row, [string]>(
    'SELECT chat_id, mode_kind, mode_provider, mode_primary, participants, user_id, account_id, last_user_name FROM conversations WHERE chat_id = ?',
  )
  const stmtUpsert = db.query<unknown, [string, string, string | null, string | null, string | null, string]>(
    'INSERT INTO conversations(chat_id, mode_kind, mode_provider, mode_primary, participants, updated_at) VALUES (?, ?, ?, ?, ?, ?) ' +
    'ON CONFLICT(chat_id) DO UPDATE SET mode_kind = excluded.mode_kind, mode_provider = excluded.mode_provider, mode_primary = excluded.mode_primary, participants = excluded.participants, updated_at = excluded.updated_at',
  )
  const stmtDelete = db.query<unknown, [string]>('DELETE FROM conversations WHERE chat_id = ?')
  const stmtAll = db.query<Row, []>(
    'SELECT chat_id, mode_kind, mode_provider, mode_primary, participants, user_id, account_id, last_user_name FROM conversations',
  )
  const stmtSetParticipants = db.query<unknown, [string | null, string, string]>(
    'UPDATE conversations SET participants = ?, updated_at = ? WHERE chat_id = ?',
  )
  const stmtReadKind = db.query<{ mode_kind: string }, [string]>(
    'SELECT mode_kind FROM conversations WHERE chat_id = ?',
  )
```

Update the `set` method to pass `cols.participants`:

```ts
    set(chatId, mode) {
      const cols = modeColumns(mode)
      stmtUpsert.run(chatId, cols.kind, cols.provider, cols.primary, cols.participants, new Date().toISOString())
    },
```

Add the `setParticipants` method to the returned object (between `delete` and `all`):

```ts
    setParticipants(chatId, participants) {
      const row = stmtReadKind.get(chatId)
      if (!row) return  // no-op on absent rows (operator can't backfill a chat that doesn't exist)
      if (row.mode_kind !== 'parallel' && row.mode_kind !== 'chatroom') {
        throw new Error(`setParticipants: chat ${chatId} has mode ${row.mode_kind}; only parallel/chatroom support participants`)
      }
      const json = participants ? JSON.stringify(participants) : null
      stmtSetParticipants.run(json, new Date().toISOString(), chatId)
    },
```

- [ ] **Step 6: Add setParticipants to the ConversationStore interface**

In `src/core/conversation-store.ts:27-53` add to the `ConversationStore` interface:

```ts
  /**
   * Backfill or update the participants list for a parallel/chatroom row.
   * No-op if the row doesn't exist. Throws on solo/primary_tool rows.
   * Used by the coordinator's resolveParticipants helper to persist the
   * legacy 2-way backfill on first dispatch under the new code.
   */
  setParticipants(chatId: string, participants: ProviderId[] | null): void
```

- [ ] **Step 7: Run tests to verify pass**

Run: `bun test src/core/conversation-store.test.ts`
Expected: all `participants` tests pass; no prior test regresses.

- [ ] **Step 8: Run typecheck**

Run: `bun run typecheck`
Expected: PASS — the ConversationStore.setParticipants interface is now defined.

- [ ] **Step 9: Commit**

```bash
git add src/core/conversation-store.ts src/core/conversation-store.test.ts
git commit -m "feat(conversation-store): participants column + setParticipants method"
```

---

### Task 4: Chatroom moderator — generalize participants

**Files:**
- Modify: `src/core/chatroom-moderator.ts:43-54` (ModeratorRoundInput.participants)
- Modify: `src/core/chatroom-moderator.ts:71-107` (MODERATOR_INSTRUCTIONS — generic N-participant language)
- Modify: `src/core/chatroom-moderator.ts:114-227` (evaluateRound — destructuring + `peerOf`)
- Modify: `src/core/chatroom-moderator.ts:229-232` (peerOf signature)
- Test: `src/core/chatroom-moderator.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/core/chatroom-moderator.test.ts`:

```ts
import { describe, test, expect } from 'vitest'
import { evaluateRound } from './chatroom-moderator'

describe('chatroom-moderator — N-way participants', () => {
  test('accepts 3 participants and prompt names each one', async () => {
    const captured: string[] = []
    const haikuEval = async (prompt: string) => {
      captured.push(prompt)
      return JSON.stringify({ action: 'continue', speaker: 'cursor', prompt: 'go cursor', reasoning: 'pick3' })
    }
    const decision = await evaluateRound(
      {
        history: [{ role: 'user', text: 'hi everyone' }],
        round: 1,
        maxRounds: 4,
        participants: ['claude', 'codex', 'cursor'],
      },
      { haikuEval },
    )
    expect(decision.action).toBe('continue')
    expect(decision.action === 'continue' && decision.speaker).toBe('cursor')
    // Prompt enumerates all three by name.
    expect(captured[0]).toContain('claude')
    expect(captured[0]).toContain('codex')
    expect(captured[0]).toContain('cursor')
  })

  test('rejects speaker not in participants — coerces to peer (3-way)', async () => {
    const haikuEval = async () => JSON.stringify({
      action: 'continue', speaker: 'gemini',  // hallucinated, not in participants
      prompt: 'p', reasoning: 'bad',
    })
    const decision = await evaluateRound(
      {
        history: [
          { role: 'user', text: 'x' },
          { role: 'speaker', speaker: 'claude', text: 'hi' },
        ],
        round: 2,
        maxRounds: 4,
        participants: ['claude', 'codex', 'cursor'],
      },
      { haikuEval },
    )
    expect(decision.action).toBe('continue')
    // peerOf(lastSpeaker='claude', participants=['claude','codex','cursor']) → first non-claude → 'codex'
    expect(decision.action === 'continue' && decision.speaker).toBe('codex')
  })

  test('peerOf with no lastSpeaker on 3-way returns first participant', async () => {
    const haikuEval = async () => 'not-valid-json'  // forces fallback path
    const decision = await evaluateRound(
      {
        history: [{ role: 'user', text: 'first ever message' }],
        round: 1,
        maxRounds: 4,
        participants: ['claude', 'codex', 'cursor'],
      },
      { haikuEval },
    )
    expect(decision.action).toBe('continue')
    expect(decision.action === 'continue' && decision.speaker).toBe('claude')  // first in list
  })

  test('still works for legacy 2-way input', async () => {
    const haikuEval = async () => JSON.stringify({
      action: 'continue', speaker: 'codex', prompt: 'go', reasoning: '2way',
    })
    const decision = await evaluateRound(
      {
        history: [{ role: 'user', text: 'hello' }],
        round: 1,
        maxRounds: 4,
        participants: ['claude', 'codex'],
      },
      { haikuEval },
    )
    expect(decision.action).toBe('continue')
    expect(decision.action === 'continue' && decision.speaker).toBe('codex')
  })
})
```

- [ ] **Step 2: Run tests to verify failure**

Run: `bun test src/core/chatroom-moderator.test.ts -t 'N-way'`
Expected: FAIL — TypeScript error because `participants: ['claude', 'codex', 'cursor']` is a 3-tuple, not `[A, B]`. (If the tsconfig is lenient, the test may run but fail at the peerOf coercion.)

- [ ] **Step 3: Relax the participants type**

In `src/core/chatroom-moderator.ts:43-54` change:

```ts
export interface ModeratorRoundInput {
  /**
   * Full chatroom history in chronological order. The latest entry is
   * the current trigger — usually the new user message on round 1, or
   * the previous speaker's turn on round 2+.
   */
  history: ChatroomEntry[]
  /** 1-indexed round counter for THIS user message's discussion (resets per user msg). */
  round: number
  maxRounds: number
  /** ≥2 providers participating in this chatroom. Coordinator caps at 3 in P1. */
  participants: ProviderId[]
}
```

- [ ] **Step 4: Generalize peerOf**

Replace `peerOf` (lines 229-232):

```ts
function peerOf(last: ProviderId | undefined, participants: ProviderId[]): ProviderId {
  if (!last) return participants[0]!
  // Pick the first participant other than `last`. Coordinator forces a
  // ≥2 cardinality so participants[0] or [1] always exists.
  const next = participants.find(p => p !== last)
  return next ?? participants[0]!
}
```

- [ ] **Step 5: Update destructuring in evaluateRound**

In `src/core/chatroom-moderator.ts:116`, replace `const [a, b] = input.participants` with:

```ts
  const participantsList = input.participants
```

…and update the prompt builder where `${a}, ${b}` appears (around line 161) to:

```ts
# 候选 speaker
${participantsList.join(', ')}${lastSpeaker ? ` （上一发言是 ${lastSpeaker}，本轮挑另一个）` : ''}
```

The speaker-membership check at line 211 uses `input.participants.includes(...)` which works unchanged with the relaxed type.

- [ ] **Step 6: Update MODERATOR_INSTRUCTIONS**

In `src/core/chatroom-moderator.ts:71` the instructions string hardcodes "两个 AI agent（claude 和 codex）". Replace the opening paragraph (line 71) so it doesn't name specific providers:

```
你是 chatroom 持续会话的主持人。N 个 AI agent（具体名单见 prompt 末尾的"候选 speaker"）和用户在同一个对话频道里。每当用户发新消息、或 agent 发完一轮，你被叫来决定：让谁说、说什么、还是结束本轮。
```

And the inner role line (line 76, `role=speaker, speaker=claude/codex`) becomes:

```
  - role=speaker, speaker=<provider id> → AI 发言
```

And the JSON schema example (line 96, `"speaker":"claude|codex"`) becomes:

```
{"action":"continue|end","speaker":"<provider id from 候选 speaker>","prompt":"<完整指令>","reasoning":"<≤20 字>"}
```

- [ ] **Step 7: Run tests to verify pass**

Run: `bun test src/core/chatroom-moderator.test.ts`
Expected: all N-way tests pass; the existing 2-way tests still pass (the relaxed type accepts them).

- [ ] **Step 8: Commit**

```bash
git add src/core/chatroom-moderator.ts src/core/chatroom-moderator.test.ts
git commit -m "feat(chatroom-moderator): generalize participants type to N (≥2)"
```

---

### Task 5: Coordinator — resolveParticipants + dispatch wiring

**Files:**
- Modify: `src/core/conversation-coordinator.ts:155-159` (parallelProviders default usage)
- Modify: `src/core/conversation-coordinator.ts:212-240` (validateMode)
- Modify: `src/core/conversation-coordinator.ts:313-322` (dispatchChatroom — drop 2-tuple throw, accept participants arg)
- Modify: `src/core/conversation-coordinator.ts:578-623` (dispatchParallel — accept participants arg)
- Modify: `src/core/conversation-coordinator.ts:648-722` (dispatch() — resolve once, fork)
- Modify: `src/core/conversation-coordinator.ts:35-76` (deps — update JSDoc on parallelProviders)
- Test: `src/core/conversation-coordinator.test.ts`

- [ ] **Step 1: Extend the in-file mock store helper**

The existing `makeMockStore()` near the top of `conversation-coordinator.test.ts` returns `{ get, set, _peek }`. It needs `setParticipants` for the legacy-backfill tests. Update its body to:

```ts
function makeMockStore() {
  const data = new Map<string, { mode: Mode }>()
  return {
    get: (chatId: string) => data.get(chatId) ?? null,
    set: vi.fn((chatId: string, mode: Mode) => { data.set(chatId, { mode }) }),
    setParticipants: vi.fn((chatId: string, participants: string[] | null) => {
      const cur = data.get(chatId)
      if (!cur) return
      if (cur.mode.kind !== 'parallel' && cur.mode.kind !== 'chatroom') {
        throw new Error(`setParticipants on ${cur.mode.kind}`)
      }
      const next = participants
        ? { ...cur.mode, participants }
        : (() => { const m = { ...cur.mode } as Mode & { participants?: string[] }; delete m.participants; return m })()
      data.set(chatId, { mode: next as Mode })
    }),
    _peek: () => data,
  }
}
```

- [ ] **Step 2: Write the failing tests**

Append to `src/core/conversation-coordinator.test.ts` after the existing `parallel mode (P3)` describe block. (Tests use the same harness conventions: `makeMockStore`, `createProviderRegistry`, `makeHandle`, `makeFakeSession`, `adminAccess`, `inbound`, `dummyProvider` — all already defined at the top of the file.)

```ts
  describe('N-way participants (P3)', () => {
    /** Reusable per-test setup for N-way parallel dispatch tracking. */
    function setupNway(registered: ProviderId[]) {
      const store = makeMockStore()
      const registry = createProviderRegistry()
      for (const id of registered) {
        registry.register(id, dummyProvider, { displayName: id, canResume: () => true })
      }
      const acquiredProviders: ProviderId[] = []
      const acquire = vi.fn(async (req: AcquireRequest) => {
        acquiredProviders.push(req.providerId)
        const session = makeFakeSession({
          events: [
            { kind: 'tool_call', server: 'wechat', tool: 'reply' },
            { kind: 'result', sessionId: '_', numTurns: 1, durationMs: 0 },
          ],
        })
        return makeHandle(req.providerId, session)
      })
      const log = vi.fn()
      const c = createConversationCoordinator({
        resolveProject: () => ({ alias: 'a', path: '/p' }),
        manager: { acquire },
        conversationStore: store,
        registry,
        defaultProviderId: 'claude',
        format: (m) => m.text,
        sendAssistantText: vi.fn(async () => {}),
        permissionMode: 'strict',
        loadAccess: adminAccess,
        log,
      })
      return { c, store, acquire, acquiredProviders, log }
    }

    it('explicit participants on parallel mode are passed verbatim (skips unlisted providers)', async () => {
      const { c, store, acquiredProviders } = setupNway(['claude', 'codex', 'cursor'])
      store.set('chat-1', { kind: 'parallel', participants: ['claude', 'cursor'] })
      await c.dispatch(inbound('chat-1', 'hi'))
      expect(acquiredProviders.sort()).toEqual(['claude', 'cursor'])
    })

    it('parallel mode with undefined participants on fresh chat fans out to registry.list()', async () => {
      const { c, store, acquiredProviders } = setupNway(['claude', 'codex', 'cursor'])
      store.set('chat-1', { kind: 'parallel' })
      await c.dispatch(inbound('chat-1', 'hi'))
      expect(acquiredProviders.sort()).toEqual(['claude', 'codex', 'cursor'])
    })

    it('legacy parallel row (participants undefined) backfills to first-two-registered and persists', async () => {
      const { c, store, acquiredProviders } = setupNway(['claude', 'codex', 'cursor'])
      // Simulate a pre-v11 row: parallel mode with no participants property.
      store.set('chat-1', { kind: 'parallel' })
      // First dispatch: backfills to first 2 (claude+codex).
      await c.dispatch(inbound('chat-1', 'hi'))
      expect(acquiredProviders.sort()).toEqual(['claude', 'codex'])
      expect(store.setParticipants).toHaveBeenCalledWith('chat-1', ['claude', 'codex'])
      // Second dispatch: now persisted with explicit participants. setParticipants NOT called again.
      const callsAfterFirst = (store.setParticipants as ReturnType<typeof vi.fn>).mock.calls.length
      acquiredProviders.length = 0
      await c.dispatch(inbound('chat-1', 'hi again'))
      expect(acquiredProviders.sort()).toEqual(['claude', 'codex'])
      expect((store.setParticipants as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsAfterFirst)
    })

    it('>3 participants is capped at 3 with a log line', async () => {
      const { c, store, acquiredProviders, log } = setupNway(['claude', 'codex', 'cursor', 'extra'])
      store.set('chat-1', { kind: 'parallel', participants: ['claude', 'codex', 'cursor', 'extra'] })
      await c.dispatch(inbound('chat-1', 'hi'))
      // First 3 only.
      expect(acquiredProviders.sort()).toEqual(['claude', 'codex', 'cursor'])
      const sawCap = log.mock.calls.some(([, line]) => typeof line === 'string' && line.includes('capping'))
      expect(sawCap).toBe(true)
    })

    it('participants filter silently drops unregistered providers with a log line', async () => {
      const { c, store, acquiredProviders, log } = setupNway(['claude', 'codex'])
      store.set('chat-1', { kind: 'parallel', participants: ['claude', 'codex', 'cursor'] })
      await c.dispatch(inbound('chat-1', 'hi'))
      expect(acquiredProviders.sort()).toEqual(['claude', 'codex'])
      const sawFilter = log.mock.calls.some(([, line]) => typeof line === 'string' && line.includes('filtered'))
      expect(sawFilter).toBe(true)
    })

    it('participants resolving to 0 degrades to solo+default', async () => {
      const { c, store, acquiredProviders } = setupNway(['claude'])
      store.set('chat-1', { kind: 'parallel', participants: ['codex', 'cursor'] })
      // validateMode would reject this — bypass by writing directly via store.
      // (Operator scenario: registry shrank after persist.)
      await c.dispatch(inbound('chat-1', 'hi'))
      // Degrades to solo+default (claude).
      expect(acquiredProviders).toEqual(['claude'])
    })

    it('participants resolving to 1 degrades to solo with that 1', async () => {
      const { c, store, acquiredProviders } = setupNway(['claude', 'codex', 'cursor'])
      store.set('chat-1', { kind: 'parallel', participants: ['cursor'] })
      await c.dispatch(inbound('chat-1', 'hi'))
      expect(acquiredProviders).toEqual(['cursor'])
    })

    it('chatroom: 3 explicit participants dispatched without 2-tuple throw', async () => {
      const store = makeMockStore()
      const registry = createProviderRegistry()
      for (const id of ['claude', 'codex', 'cursor']) {
        registry.register(id, dummyProvider, { displayName: id, canResume: () => true })
      }
      store.set('chat-1', { kind: 'chatroom', participants: ['claude', 'codex', 'cursor'] })
      const acquired: ProviderId[] = []
      const acquire = vi.fn(async (req: AcquireRequest) => {
        acquired.push(req.providerId)
        return makeHandle(req.providerId, makeFakeSession({
          events: [
            { kind: 'text', text: `I am ${req.providerId}` },
            { kind: 'result', sessionId: '_', numTurns: 1, durationMs: 0 },
          ],
        }))
      })
      // Scripted moderator: round 1 → cursor, round 2 → end.
      let round = 0
      const haikuEval = vi.fn(async () => {
        round++
        if (round === 1) return JSON.stringify({ action: 'continue', speaker: 'cursor', prompt: 'go', reasoning: 'r1' })
        return JSON.stringify({ action: 'end', reasoning: 'done' })
      })
      const c = createConversationCoordinator({
        resolveProject: () => ({ alias: 'a', path: '/p' }),
        manager: { acquire },
        conversationStore: store,
        registry,
        defaultProviderId: 'claude',
        format: (m) => m.text,
        sendAssistantText: vi.fn(async () => {}),
        permissionMode: 'strict',
        loadAccess: adminAccess,
        chatroomMaxRounds: 4,
        haikuEval,
        log: () => {},
      })
      // Should not throw despite 3 participants (pre-P3 would throw 2-tuple).
      await expect(c.dispatch(inbound('chat-1', 'hi'))).resolves.toBeUndefined()
      // Cursor was the picked speaker.
      expect(acquired).toContain('cursor')
    })

    it('chatroom: legacy row (no participants) backfills to first-two and persists', async () => {
      const store = makeMockStore()
      const registry = createProviderRegistry()
      for (const id of ['claude', 'codex']) {
        registry.register(id, dummyProvider, { displayName: id, canResume: () => true })
      }
      store.set('chat-1', { kind: 'chatroom' })
      const acquire = vi.fn(async (req: AcquireRequest) =>
        makeHandle(req.providerId, makeFakeSession({
          events: [{ kind: 'text', text: 'x' }, { kind: 'result', sessionId: '_', numTurns: 1, durationMs: 0 }],
        })))
      const haikuEval = vi.fn(async () => JSON.stringify({ action: 'end', reasoning: 'short' }))
      const c = createConversationCoordinator({
        resolveProject: () => ({ alias: 'a', path: '/p' }),
        manager: { acquire },
        conversationStore: store,
        registry,
        defaultProviderId: 'claude',
        format: (m) => m.text,
        sendAssistantText: vi.fn(async () => {}),
        permissionMode: 'strict',
        loadAccess: adminAccess,
        chatroomMaxRounds: 4,
        haikuEval,
        log: () => {},
      })
      await c.dispatch(inbound('chat-1', 'hi'))
      expect(store.setParticipants).toHaveBeenCalledWith('chat-1', ['claude', 'codex'])
    })
  })

  describe('validateMode — N-way participants', () => {
    function setupValidate(registered: ProviderId[]) {
      const store = makeMockStore()
      const registry = createProviderRegistry()
      for (const id of registered) {
        registry.register(id, dummyProvider, { displayName: id, canResume: () => true })
      }
      const c = createConversationCoordinator({
        resolveProject: () => null,
        manager: { acquire: vi.fn() },
        conversationStore: store,
        registry,
        defaultProviderId: 'claude',
        format: () => 'x',
        permissionMode: 'strict',
        loadAccess: adminAccess,
        log: () => {},
      })
      return c
    }

    it('setMode(parallel) with explicit unknown provider throws naming the bad provider', () => {
      const c = setupValidate(['claude', 'codex'])
      expect(() => c.setMode('chat-1', { kind: 'parallel', participants: ['claude', 'unknown'] }))
        .toThrow(/unknown.*unknown/i)
    })

    it('setMode(parallel) with all participants registered succeeds', () => {
      const c = setupValidate(['claude', 'codex', 'cursor'])
      expect(() => c.setMode('chat-1', { kind: 'parallel', participants: ['claude', 'cursor'] })).not.toThrow()
    })

    it('setMode(parallel) with undefined participants succeeds (deferred to dispatch)', () => {
      const c = setupValidate(['claude', 'codex', 'cursor'])
      expect(() => c.setMode('chat-1', { kind: 'parallel' })).not.toThrow()
    })

    it('setMode(chatroom) with participants.length < 2 throws', () => {
      const c = setupValidate(['claude', 'codex', 'cursor'])
      expect(() => c.setMode('chat-1', { kind: 'chatroom', participants: ['claude'] }))
        .toThrow(/≥2|at least 2/)
    })
  })
```

Add `ProviderId` to the top-level imports if not already there: `import type { Mode, ProviderId } from './conversation'`.

- [ ] **Step 2: Run tests to verify failure**

Run: `bun test src/core/conversation-coordinator.test.ts -t 'resolveParticipants|validateMode N-way'`
Expected: FAIL on all new tests — the helper doesn't exist; dispatchChatroom still has the 2-tuple throw.

- [ ] **Step 3: Update the deps JSDoc**

In `src/core/conversation-coordinator.ts:46-54`, replace the `parallelProviders` JSDoc to reflect its narrowed P3+ scope:

```ts
  /**
   * Default provider ids for primary_tool peer validation. Defaults to
   * `['claude', 'codex']` — the two providers shipped before cursor.
   * Used ONLY by validateMode for primary_tool (the peer must be one
   * of these). For parallel/chatroom, the active set is resolved
   * per-dispatch from Mode.participants (or the registry as a fallback)
   * via resolveParticipants — this dep is NOT consulted there.
   */
  parallelProviders?: ProviderId[]
```

- [ ] **Step 4: Add the resolveParticipants helper**

In `src/core/conversation-coordinator.ts` after `getMode` and before `validateMode` (around line 156, after `const parallelProviders` line), add:

```ts
  /**
   * Resolve the active participant set for a parallel/chatroom dispatch.
   *
   * Priority:
   *   1. Explicit mode.participants (the user wrote `/chat claude codex cursor`).
   *   2. Legacy backfill — chat row pre-dates the participants column;
   *      use the first 2 registered providers and persist so the user's
   *      "this chat was 2-way" expectation survives a future operator
   *      install of a 3rd provider.
   *   3. Fresh-chat fallback — no row yet; use the full registry.list().
   *
   * Then filter against the current registry (silently drop providers
   * that vanished from the registry post-persist), and hard-cap at 3
   * in P1 with a log warning if exceeded.
   *
   * Returns the resolved list (≥0 elements). Caller is responsible for
   * the ≤1 → solo+default degradation; this helper does not throw.
   */
  function resolveParticipants(
    mode: (Mode & { kind: 'parallel' | 'chatroom' }),
    chatId: string,
  ): ProviderId[] {
    let list: ProviderId[]
    if (mode.participants !== undefined) {
      list = mode.participants
    } else if (deps.conversationStore.get(chatId)?.mode) {
      // Row exists with no participants — legacy. Backfill to first-two.
      list = deps.registry.list().slice(0, 2)
      // Persist so this is a one-shot. setParticipants is a no-op if the
      // row doesn't have parallel/chatroom kind, but we just read it as
      // parallel/chatroom so the call is safe.
      try {
        deps.conversationStore.setParticipants(chatId, list)
        deps.log('COORDINATOR', `chat=${chatId} legacy ${mode.kind} backfilled participants=${list.join(',')}`)
      } catch (err) {
        deps.log('COORDINATOR', `chat=${chatId} setParticipants failed: ${err instanceof Error ? err.message : err}`)
      }
    } else {
      // No row yet — first-ever dispatch in this chat under parallel/chatroom.
      list = deps.registry.list()
    }
    const filtered = list.filter(p => deps.registry.has(p))
    if (filtered.length < list.length) {
      deps.log('COORDINATOR', `chat=${chatId} participants filtered ${list.join(',')} → ${filtered.join(',')} (registry: ${deps.registry.list().join(',')})`)
    }
    if (filtered.length > 3) {
      const capped = filtered.slice(0, 3)
      deps.log('COORDINATOR', `chat=${chatId} participants > 3; capping at ${capped.join(',')}`)
      return capped
    }
    return filtered
  }
```

- [ ] **Step 5: Update validateMode for explicit participants**

In `src/core/conversation-coordinator.ts:233-239` replace the parallel/chatroom branch:

```ts
    if (mode.kind === 'parallel' || mode.kind === 'chatroom') {
      // Explicit participants must all be registered. Undefined defers
      // to dispatch-time resolution (resolveParticipants).
      if (mode.participants !== undefined) {
        const unknown = mode.participants.filter(p => !deps.registry.has(p))
        if (unknown.length > 0) {
          throw new Error(`mode '${mode.kind}' has unknown providers: ${unknown.join(', ')} (registered: ${deps.registry.list().join(', ')})`)
        }
        if (mode.participants.length < 2) {
          throw new Error(`mode '${mode.kind}' requires ≥2 participants; got ${mode.participants.length}`)
        }
      }
      // No else — undefined is fine; resolveParticipants handles fresh
      // and legacy chats.
    }
```

- [ ] **Step 6: Update dispatchChatroom — drop 2-tuple throw, take participants arg**

In `src/core/conversation-coordinator.ts:313-322`:

```ts
  async function dispatchChatroom(
    msg: InboundMsg,
    proj: { alias: string; path: string },
    participants: ProviderId[],
  ): Promise<void> {
    // P3 — N participants. Coordinator's resolveParticipants enforces ≥2
    // and ≤3. Empty/single is degraded to solo upstream.

    // (Existing preempt-loop block stays unchanged.)
```

Then in the body, replace `[providerA, providerB] = parallelProviders` (line 320) with use of `participants` directly. Specifically:

- Line 320: delete `const [providerA, providerB] = parallelProviders as [ProviderId, ProviderId]`
- Line 379 (log line): replace `providers=${providerA},${providerB}` with `providers=${participants.join(',')}`
- Line 403 (moderator call): replace `participants: [providerA, providerB]` with `participants`

Search for any other references to `providerA` / `providerB` within `dispatchChatroom`. They appear in:
- `acquire` calls for both speakers when scheduling — the body acquires per-speaker on the picked decision; verify by reading the existing implementation between lines 419-560. (If lines acquire both up front, refactor to acquire only the picked speaker per round. Conversely, if the existing body already acquires per-round per the decision.speaker, this requires no further change.)

When in doubt, the implementer reads the full body of dispatchChatroom (`src/core/conversation-coordinator.ts:313-565`) and replaces every use of `providerA`/`providerB` with whichever element of `participants` is appropriate — typically `decision.speaker` is used directly to call `deps.manager.acquire({ ..., providerId: decision.speaker })`.

- [ ] **Step 7: Update dispatchParallel — accept participants arg**

In `src/core/conversation-coordinator.ts:578-623` replace the signature and body to accept `participants`:

```ts
  async function dispatchParallel(
    msg: InboundMsg,
    proj: { alias: string; path: string },
    participants: ProviderId[],
  ): Promise<void> {
    const tier = resolveTier(msg.chatId, deps.loadAccess())
    const tierProfile = TIER_PROFILES[tier]
    deps.log('COORDINATOR', `parallel chat=${msg.chatId} → project=${proj.alias} providers=${participants.join(',')} tier=${tier}`)
    const handles = await Promise.all(
      participants.map(p => deps.manager.acquire({
        alias: proj.alias,
        path: proj.path,
        providerId: p,
        chatId: msg.chatId,
        tierProfile,
      })),
    )
    const text = deps.format(msg)
    const settled = await Promise.allSettled(handles.map(h => collectTurn(h.dispatch(text))))

    for (let i = 0; i < settled.length; i++) {
      const r = settled[i]!
      const providerId = participants[i]!
      // (... rest unchanged: auth_failed handling + fallback assistant text)
    }
  }
```

The internal body (auth_failed handling + sendAssistantText with `[${dn}]` prefix per chunk) stays unchanged — it already loops over the settled array using `parallelProviders[i]`; just rename that to `participants[i]`.

- [ ] **Step 8: Update the dispatch() switch — resolve once, fork**

In `src/core/conversation-coordinator.ts:648-722`, restructure the `dispatch` body:

```ts
    async dispatch(msg) {
      const proj = deps.resolveProject(msg.chatId)
      if (!proj) {
        deps.log('COORDINATOR', `drop: no project for chat=${msg.chatId}`)
        return
      }
      const mode = getMode(msg.chatId)

      // For parallel/chatroom, resolve the active participant set once.
      // Then degrade-to-solo if the set is ≤1 (no point fanning out to 0
      // or N=1) and use the resolved set for the capability-matrix check.
      let participants: ProviderId[] | null = null
      if (mode.kind === 'parallel' || mode.kind === 'chatroom') {
        participants = resolveParticipants(mode, msg.chatId)
        if (participants.length === 0) {
          deps.log('COORDINATOR', `chat=${msg.chatId} ${mode.kind} resolved to empty participants; falling back to solo+${deps.defaultProviderId}`)
          return dispatchSolo(msg, proj, deps.defaultProviderId)
        }
        if (participants.length === 1) {
          deps.log('COORDINATOR', `chat=${msg.chatId} ${mode.kind} resolved to single participant ${participants[0]}; degrading to solo`)
          return dispatchSolo(msg, proj, participants[0]!)
        }
      }

      const providersInUse: ProviderId[] =
        mode.kind === 'solo' ? [mode.provider] :
        mode.kind === 'primary_tool' ? [mode.primary] :
        participants!  // parallel/chatroom — never null here due to early-return above

      for (const p of providersInUse) {
        try {
          assertSupported(mode.kind, p, deps.permissionMode)
        } catch (err) {
          if (err instanceof UnsupportedCombinationError) throw err
        }
      }

      switch (mode.kind) {
        case 'solo': {
          if (!deps.registry.has(mode.provider)) {
            deps.log('COORDINATOR', `chat=${msg.chatId} persisted provider '${mode.provider}' not registered; falling back to ${deps.defaultProviderId}`)
            return dispatchSolo(msg, proj, deps.defaultProviderId)
          }
          return dispatchSolo(msg, proj, mode.provider)
        }
        case 'parallel': {
          return dispatchParallel(msg, proj, participants!)
        }
        case 'primary_tool': {
          if (!deps.registry.has(mode.primary)) {
            deps.log('COORDINATOR', `chat=${msg.chatId} primary_tool primary '${mode.primary}' not registered; falling back to solo+${deps.defaultProviderId}`)
            return dispatchSolo(msg, proj, deps.defaultProviderId)
          }
          return dispatchSolo(msg, proj, mode.primary)
        }
        case 'chatroom': {
          return dispatchChatroom(msg, proj, participants!)
        }
      }
    },
```

The prior `missing = parallelProviders.filter(...)` early-degradations in the switch (parallel + chatroom cases) are removed — their job is now done by `resolveParticipants` + the empty/single early-return above.

- [ ] **Step 9: Run tests to verify pass**

Run: `bun test src/core/conversation-coordinator.test.ts`
Expected: all new `resolveParticipants` + `validateMode N-way` tests pass; prior tests still pass.

- [ ] **Step 10: Run the full test suite**

Run: `bun test`
Expected: PASS. The user-tier + cursor + capability-matrix suites should all still pass since we only narrowed the parallelProviders dep semantics.

- [ ] **Step 11: Run typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 12: Commit**

```bash
git add src/core/conversation-coordinator.ts src/core/conversation-coordinator.test.ts
git commit -m "feat(coordinator): resolveParticipants helper — N-way dispatch for parallel/chatroom"
```

---

### Task 6: Slash command grammar — `/chat <p...>` and `/parallel <p...>`

**Files:**
- Modify: `src/daemon/mode-commands.ts:48-242` (parser + new handler branches)
- Test: `src/daemon/mode-commands.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/daemon/mode-commands.test.ts` after the existing tests. The file's top-level `setup({...})` helper accepts `registered: ProviderId[]` already — reuse it.

```ts
  describe('N-way grammar', () => {
    it('/chat claude codex cursor sets chatroom with 3 participants', async () => {
      const { cmds, set, sentMessages } = setup({ registered: ['claude', 'codex', 'cursor'] })
      const consumed = await cmds.handle(inbound('/chat claude codex cursor'))
      expect(consumed).toBe(true)
      expect(set).toHaveBeenCalledWith('chat-1', {
        kind: 'chatroom', participants: ['claude', 'codex', 'cursor'],
      })
      expect(sentMessages[0]?.[1]).toContain('claude')
      expect(sentMessages[0]?.[1]).toContain('cursor')
    })

    it('/chat claude codex sets explicit 2-way chatroom', async () => {
      const { cmds, set } = setup({ registered: ['claude', 'codex', 'cursor'] })
      await cmds.handle(inbound('/chat claude codex'))
      expect(set).toHaveBeenCalledWith('chat-1', {
        kind: 'chatroom', participants: ['claude', 'codex'],
      })
    })

    it('/parallel claude cursor sets parallel with explicit participants', async () => {
      const { cmds, set } = setup({ registered: ['claude', 'codex', 'cursor'] })
      await cmds.handle(inbound('/parallel claude cursor'))
      expect(set).toHaveBeenCalledWith('chat-1', {
        kind: 'parallel', participants: ['claude', 'cursor'],
      })
    })

    it('/both claude cursor also sets parallel with explicit participants (alias)', async () => {
      const { cmds, set } = setup({ registered: ['claude', 'codex', 'cursor'] })
      await cmds.handle(inbound('/both claude cursor'))
      expect(set).toHaveBeenCalledWith('chat-1', {
        kind: 'parallel', participants: ['claude', 'cursor'],
      })
    })

    it('/chat with no args remains bare chatroom (no participants property)', async () => {
      const { cmds, set } = setup({ registered: ['claude', 'codex', 'cursor'] })
      await cmds.handle(inbound('/chat'))
      expect(set).toHaveBeenCalledWith('chat-1', { kind: 'chatroom' })
    })

    it('/both with no args remains bare parallel (no participants property)', async () => {
      const { cmds, set } = setup({ registered: ['claude', 'codex', 'cursor'] })
      await cmds.handle(inbound('/both'))
      expect(set).toHaveBeenCalledWith('chat-1', { kind: 'parallel' })
    })

    it('/chat with single arg is rejected (≥2 required) — does NOT call setMode', async () => {
      const { cmds, set, sentMessages } = setup({ registered: ['claude', 'codex', 'cursor'] })
      await cmds.handle(inbound('/chat claude'))
      expect(set).not.toHaveBeenCalled()
      expect(sentMessages[0]?.[1]).toMatch(/≥2|至少|need.*2/)
    })

    it('/chat with unknown provider is rejected with helpful message', async () => {
      const { cmds, set, sentMessages } = setup({ registered: ['claude', 'codex', 'cursor'] })
      await cmds.handle(inbound('/chat claude gemini'))
      expect(set).not.toHaveBeenCalled()
      expect(sentMessages[0]?.[1]).toContain('gemini')
      // Registered list is surfaced.
      expect(sentMessages[0]?.[1]).toContain('claude')
    })

    it('/parallel with single arg is rejected (≥2 required)', async () => {
      const { cmds, set, sentMessages } = setup({ registered: ['claude', 'codex', 'cursor'] })
      await cmds.handle(inbound('/parallel claude'))
      expect(set).not.toHaveBeenCalled()
      expect(sentMessages[0]?.[1]).toMatch(/≥2|至少|need.*2/)
    })

    it('/chat dedupes repeated tokens silently', async () => {
      const { cmds, set } = setup({ registered: ['claude', 'codex', 'cursor'] })
      await cmds.handle(inbound('/chat claude claude codex'))
      expect(set).toHaveBeenCalledWith('chat-1', {
        kind: 'chatroom', participants: ['claude', 'codex'],
      })
    })
  })
```

- [ ] **Step 2: Run tests to verify failure**

Run: `bun test src/daemon/mode-commands.test.ts -t 'N-way grammar'`
Expected: FAIL — the parser currently rejects any args on /chat / /both.

- [ ] **Step 3: Add the args-parser helper**

In `src/daemon/mode-commands.ts:53`, after `function isProviderCommand(...)`, add:

```ts
  /**
   * Parse a token list (space-separated provider ids) into a validated
   * ProviderId[] or an error message describing why it's invalid. Used
   * by /chat <p...> and /parallel <p...>.
   */
  function parseParticipantsTail(tail: string, modeName: string): { ok: true; participants: ProviderId[] } | { ok: false; error: string } {
    const tokens = tail.split(/\s+/).filter(t => t.length > 0)
    if (tokens.length < 2) {
      return { ok: false, error: `❓ /${modeName} 需要 ≥2 个 participants (你写的: ${tokens.length}). 例：/${modeName} ${deps.registry.list().slice(0, 2).join(' ')}` }
    }
    const unknown = tokens.filter(t => !deps.registry.has(t))
    if (unknown.length > 0) {
      return { ok: false, error: `❌ 未知的 provider: ${unknown.join(', ')}. 已注册: ${deps.registry.list().join(', ')}` }
    }
    // Deduplicate while preserving order (operator typed the same provider twice → silent dedupe).
    const seen = new Set<string>()
    const dedup = tokens.filter(t => seen.has(t) ? false : (seen.add(t), true))
    return { ok: true, participants: dedup }
  }
```

- [ ] **Step 4: Update the /both handler to accept participant tokens**

In `src/daemon/mode-commands.ts:159-169` replace:

```ts
      // /both — parallel mode (RFC 03 P3). Bare form uses all registered
      // providers; explicit form (/both <p1> <p2> ...) takes participants.
      if (slashWord.toLowerCase() === 'both' || slashWord.toLowerCase() === 'parallel') {
        if (tail === '') {
          try {
            deps.coordinator.setMode(msg.chatId, { kind: 'parallel' })
          } catch (err) {
            await reply(msg.chatId, `❌ /${slashWord} 启用失败: ${err instanceof Error ? err.message : String(err)}`)
            return true
          }
          await reply(msg.chatId, '✅ 并行模式开启。下条消息开始所有已注册 provider 同时回复（每条带 prefix）。')
          deps.log('MODE_CMD', `chat=${msg.chatId} → parallel (no explicit participants)`)
          return true
        }
        const parsed = parseParticipantsTail(tail, slashWord.toLowerCase())
        if (!parsed.ok) {
          await reply(msg.chatId, parsed.error)
          return true
        }
        try {
          deps.coordinator.setMode(msg.chatId, { kind: 'parallel', participants: parsed.participants })
        } catch (err) {
          await reply(msg.chatId, `❌ /${slashWord} 启用失败: ${err instanceof Error ? err.message : String(err)}`)
          return true
        }
        await reply(msg.chatId, `✅ 并行模式开启 (${parsed.participants.join(' + ')})。下条消息开始同时回复。`)
        deps.log('MODE_CMD', `chat=${msg.chatId} → parallel participants=${parsed.participants.join(',')}`)
        return true
      }
```

- [ ] **Step 5: Update the /chat handler to accept participant tokens**

In `src/daemon/mode-commands.ts:171-185` replace:

```ts
      // /chat — chatroom mode (v0.5.9: persistent session, moderator-driven).
      // Bare form uses all registered providers; explicit form takes participants.
      if (slashWord.toLowerCase() === 'chat') {
        if (tail === '') {
          try {
            deps.coordinator.setMode(msg.chatId, { kind: 'chatroom' })
          } catch (err) {
            await reply(msg.chatId, `❌ /chat 启用失败: ${err instanceof Error ? err.message : String(err)}`)
            return true
          }
          await reply(
            msg.chatId,
            '✅ 聊天室开启。所有已注册 provider 都"在场"了——后续消息会按上下文挑发言人。每条带 prefix。切走（/cc /codex /solo）会清空聊天室上下文。',
          )
          deps.log('MODE_CMD', `chat=${msg.chatId} → chatroom (no explicit participants)`)
          return true
        }
        const parsed = parseParticipantsTail(tail, 'chat')
        if (!parsed.ok) {
          await reply(msg.chatId, parsed.error)
          return true
        }
        try {
          deps.coordinator.setMode(msg.chatId, { kind: 'chatroom', participants: parsed.participants })
        } catch (err) {
          await reply(msg.chatId, `❌ /chat 启用失败: ${err instanceof Error ? err.message : String(err)}`)
          return true
        }
        await reply(msg.chatId, `✅ 聊天室开启 (${parsed.participants.join(', ')})。每条回复带 prefix；切走会清空上下文。`)
        deps.log('MODE_CMD', `chat=${msg.chatId} → chatroom participants=${parsed.participants.join(',')}`)
        return true
      }
```

- [ ] **Step 6: Update the /mode help line**

In `src/daemon/mode-commands.ts:152` change the help line text:

```ts
          '可用命令: /cc /codex /cursor /both [p...] /chat [p...] /cc + codex /solo /stop /mode',
```

- [ ] **Step 7: Run tests to verify pass**

Run: `bun test src/daemon/mode-commands.test.ts`
Expected: all new N-way grammar tests pass; prior tests still pass.

- [ ] **Step 8: Commit**

```bash
git add src/daemon/mode-commands.ts src/daemon/mode-commands.test.ts
git commit -m "feat(mode-commands): /chat <p...> and /parallel <p...> grammar"
```

---

### Task 7: README + integration smoke test

**Files:**
- Modify: `README.md` (the `/chat` and `/both` section, plus add a brief note in the Known Limitations / Multi-provider section)
- Modify: `src/daemon/__e2e__/<existing-coordinator-e2e>.test.ts` OR create `src/core/conversation-coordinator.integration.test.ts` — pick whichever matches existing patterns by grepping for an existing 2-way integration test
- Test: integration smoke for N=3 chatroom dispatch end-to-end

- [ ] **Step 1: README — update /chat and /both docs**

Find the existing `/chat` / `/both` documentation block in `README.md`. Replace it with:

```markdown
- **`/chat`** — chatroom mode. Multiple agents take turns under a haiku
  moderator that decides who speaks next per round. Bare `/chat` uses
  all registered providers (after cursor was added, that's claude +
  codex + cursor). Explicit form: `/chat claude codex` (2-way) or
  `/chat claude codex cursor` (3-way). P1 caps the participant list
  at 3 — extras are silently dropped with a log warning.

- **`/both`** (alias `/parallel`) — parallel mode. Same shape:
  bare → all registered, explicit → `/parallel claude cursor`. ≥2
  participants required; rejects unknown providers up front.

- **Legacy 2-way chats** — if you used `/chat` or `/both` before
  cursor was registered, your existing chats stay 2-way (claude +
  codex). The first dispatch under the new code persists this
  intent. To opt into 3-way explicitly, re-issue
  `/chat claude codex cursor`.
```

Add to the Known Limitations / Multi-provider section (where the cursor tier caveat already lives):

```markdown
- **3-participant cap** — chatroom and parallel are capped at 3
  participants in P1. The moderator's coherence with 4+ speakers is
  untested; the cap is a safety net. Raise it once we've seen real
  3-way data.
```

- [ ] **Step 2: Write the 3-way chatroom integration test**

Append to `src/core/conversation-coordinator.test.ts` (it already exercises the full coordinator+registry+manager+moderator stack — that's effectively integration-level for this code path).

```ts
  describe('integration — 3-way chatroom over 4 rounds', () => {
    it('moderator picks all 3 participants across the rounds; sendAssistantText prefixes each speaker', async () => {
      const store = makeMockStore()
      const registry = createProviderRegistry()
      for (const id of ['claude', 'codex', 'cursor']) {
        registry.register(id, dummyProvider, { displayName: id[0]!.toUpperCase() + id.slice(1), canResume: () => true })
      }
      store.set('chat-1', { kind: 'chatroom', participants: ['claude', 'codex', 'cursor'] })
      const acquired: ProviderId[] = []
      const acquire = vi.fn(async (req: AcquireRequest) => {
        acquired.push(req.providerId)
        return makeHandle(req.providerId, makeFakeSession({
          events: [
            { kind: 'text', text: `${req.providerId} weighs in` },
            { kind: 'result', sessionId: '_', numTurns: 1, durationMs: 0 },
          ],
        }))
      })
      // Scripted moderator: round 1=claude, 2=codex, 3=cursor, 4=end.
      const pickOrder: ProviderId[] = ['claude', 'codex', 'cursor']
      let i = 0
      const haikuEval = vi.fn(async () => {
        if (i < pickOrder.length) {
          const speaker = pickOrder[i]!
          i++
          return JSON.stringify({ action: 'continue', speaker, prompt: `as ${speaker}`, reasoning: `r${i}` })
        }
        return JSON.stringify({ action: 'end', reasoning: 'done' })
      })
      const sendAssistantText = vi.fn(async (_chatId: string, _text: string) => {})
      const c = createConversationCoordinator({
        resolveProject: () => ({ alias: 'a', path: '/p' }),
        manager: { acquire },
        conversationStore: store,
        registry,
        defaultProviderId: 'claude',
        format: (m) => m.text,
        sendAssistantText,
        permissionMode: 'strict',
        loadAccess: adminAccess,
        chatroomMaxRounds: 4,
        haikuEval,
        log: () => {},
      })
      await c.dispatch(inbound('chat-1', 'what do you all think?'))
      // All 3 speakers were acquired at least once.
      expect(new Set(acquired)).toEqual(new Set(['claude', 'codex', 'cursor']))
      // sendAssistantText carried the prefixed text from each speaker.
      const sentTexts = sendAssistantText.mock.calls.map((c) => c[1])
      expect(sentTexts.some((t) => t.includes('[Claude]'))).toBe(true)
      expect(sentTexts.some((t) => t.includes('[Codex]'))).toBe(true)
      expect(sentTexts.some((t) => t.includes('[Cursor]'))).toBe(true)
    })
  })
```

- [ ] **Step 3: Run the integration test**

Run: `bun test src/core/conversation-coordinator.test.ts -t 'integration — 3-way'`
Expected: PASS — 3-way chatroom dispatches all 3 speakers at least once.

- [ ] **Step 4: Run the full suite + typecheck**

Run: `bun test && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add README.md src/core/conversation-coordinator.test.ts
git commit -m "docs(readme) + test: N-way mode grammar + 3-way chatroom integration smoke"
```

---

## Acceptance Gate

After all tasks complete, verify (matches the spec's acceptance gate):

- [ ] `/chat claude codex cursor` on a fresh chat → moderator picks across all 3 speakers in a 4-round transcript (integration test)
- [ ] `/parallel claude cursor` → both providers dispatched concurrently
- [ ] Bare `/chat` on a fresh chat with cursor registered → 3-way (resolveParticipants returns full registry)
- [ ] Bare `/chat` on a fresh chat without cursor → 2-way (claude + codex)
- [ ] Legacy persisted chatroom row (no participants column) → backfills to first 2 on first dispatch, persists
- [ ] DB migration v11 applies cleanly; pre-v11 rows readable
- [ ] Full unit + integration suite passes; no regression in claude/codex/cursor solo paths
- [ ] README documents the new grammar + 3-cap + legacy-backfill behavior

If all green: invoke `superpowers:finishing-a-development-branch` to merge or PR the branch.
