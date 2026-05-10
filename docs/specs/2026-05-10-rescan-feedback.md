# Spec · Rescan Feedback · Tell the user what just happened

**Status**: Draft · 2026-05-10
**Scope**: Wizard's QR-scan completion screen distinguishes 4 scenarios (first / reconnect / redundant / new_account) so小白 users get clear feedback instead of "绑定成功 + cryptic accountId" regardless of what actually happened.
**Effort**: ~40 lines + 4 tests
**Depends on**: nothing (independent of multi-provider extension)
**Targets**: v0.5.16 patch

---

## Problem

Current wizard ends every scan with the same message (qr.js:115-126 + view.js:41-47):

```
✓ 已绑定 [accountId]
绑定成功
[accountId] 已保存。
```

`accountId` is the bot_id — different for every scan. So when the same WeChat user re-scans (most common case for 小白 who don't realize they're already connected), the wizard shows a *new* accountId every time, which **looks like they're binding fresh accounts**. They have no way to tell:

- Was this their first scan? ("OK, ready to use")
- Did this fix a broken connection? ("Phew, my chat history is back")
- Did they just scan redundantly? ("Wait, was I already connected?")
- Did they switch to a different WeChat account? ("Why did the AI forget me?")

Without that signal, 小白 keep re-scanning to "make sure it worked", piling up superseded bot dirs and triggering avoidable session-expiry chains. Confirmed by recent user-reported behavior — the user kept re-scanning because they weren't sure the previous scan stuck.

## The four scenarios

Detectable from existing daemon state (no new fields needed):

| Scenario | Detection (BEFORE dedupe runs) | Meaning |
|---|---|---|
| **first** | `accounts/` has zero non-superseded dirs (or only this scan's new dir) | Truly fresh user |
| **reconnect** | Same `userId` exists in another active dir AND `sessionState.isExpired(thatBotId)` is true | Old session was dead (errcode=-14, daemon offline overnight, etc); user fixing a known-broken connection |
| **redundant** | Same `userId` exists in another active dir AND not expired | User scanned despite already being connected; old session was alive |
| **new_account** | A different `userId` exists in active dirs (no same-userId match) | User switched WeChat accounts (work微信 → personal微信, etc) |

`SessionStateStore.isExpired(accountId)` already exists and is set on `errcode=-14` (transport.ts:74-80). No new state to track.

`dedupeAccountsByUserId` already runs *after* scenario detection in `persistConfirmedAccount` (setup-flow.ts:158-163), so we can read the pre-dedupe state cleanly.

## Proposed copy (★ this is the part to review)

Each scenario gets its own **title + message**, replacing the current single "绑定成功 / [accountId] 已保存" pair:

### first

```
✓ 连接成功
可以开始用了。
```

### reconnect

```
✓ 重新连接成功
之前的记忆和对话都还在，可以接着用。
```

### redundant

```
✓ 已是连接状态
你已经连接了这个账号。这次扫码刷新了连接，原对话不受影响。
```

### new_account

```
✓ 切换到新账号
原账号的记忆保留在本地，但当前只接收新账号的消息。
```

**Design notes**:

- All four use ✓ + green color (consistent positive state)
- No bot_id / userId rendered — both are meaningless to 小白. The `<accountId>` line in the right-column "已绑定" badge can stay (debug value); the wizard message itself stays human-readable.
- "redundant" intentionally says "已是连接状态" not "你扫错了" — non-judgmental. The follow-up sentence reassures that nothing broke.
- "new_account" intentionally doesn't say "you switched" — describes what the system did. Offers no advice on how to switch back (the answer is "scan the other QR" but spelling that out adds confusion; let users discover it).
- 字数 all kept short (≤30 chars per message) so they fit the existing wizard layout.

## Schema change

**File**: `src/cli/schema.ts`

```ts
const SetupPollStatusConfirmed = z.object({
  status: z.literal('confirmed'),
  accountId: z.string(),
  userId: z.string(),
  scenario: z.enum(['first', 'reconnect', 'redundant', 'new_account']),  // ← new
})
```

Schema is additive, but existing CLI consumers and shim e2e tests assert exact shape — add `scenario` to test fixtures and any synthetic poll responses.

## Backend (setup-flow.ts)

**File**: `src/cli/setup-flow.ts` `persistConfirmedAccount`

New helper inserted just before the existing `dedupeAccountsByUserId` call:

```ts
function determineScenario(
  accountsDir: string,
  scanUserId: string,
  scanBotId: string,
  sessionState: SessionStateStore,
): 'first' | 'reconnect' | 'redundant' | 'new_account' {
  const otherActiveAccounts = listActiveAccounts(accountsDir)
    .filter(a => a.botId !== scanBotId)  // exclude the dir we just wrote

  if (otherActiveAccounts.length === 0) return 'first'

  const sameUser = otherActiveAccounts.find(a => a.userId === scanUserId)
  if (!sameUser) return 'new_account'

  return sessionState.isExpired(sameUser.botId) ? 'reconnect' : 'redundant'
}
```

`listActiveAccounts` is a thin wrapper over `readdirSync(accountsDir)` filtering `.superseded.` — already implicitly used by `dedupeAccountsByUserId`. Extract once, share between dedupe and this.

Threading `sessionState` into `persistConfirmedAccount`: it's a deps-injected store (already passed to ilink-glue). Add to the function's signature.

## Frontend

### `src/cli/schema.ts` already has the type via SetupPollOutputT inference

### `apps/desktop/src/view.js` `pollAdvance` confirmed branch

Current:
```js
if (result.status === "confirmed") {
  return {
    stopTimer: true,
    qrTitle: "绑定成功",
    qrMessage: `${result.accountId} 已保存。`,
    continueEnabled: true,
  }
}
```

After:
```js
if (result.status === "confirmed") {
  const copy = SCAN_SCENARIO_COPY[result.scenario] ?? SCAN_SCENARIO_COPY.first
  return {
    stopTimer: true,
    qrTitle: copy.title,
    qrMessage: copy.message,
    continueEnabled: true,
  }
}

const SCAN_SCENARIO_COPY = {
  first:       { title: "连接成功",     message: "可以开始用了。" },
  reconnect:   { title: "重新连接成功", message: "之前的记忆和对话都还在，可以接着用。" },
  redundant:   { title: "已是连接状态", message: "你已经连接了这个账号。这次扫码刷新了连接，原对话不受影响。" },
  new_account: { title: "切换到新账号", message: "原账号的记忆保留在本地，但当前只接收新账号的消息。" },
}
```

### `apps/desktop/src/modules/qr.js` confirmed badge

The right-column ✓ badge currently shows `accountId` in mono. Keep that (debug value) but **switch the prose label** to scenario-specific:

Current:
```html
✓<br>已绑定<br><span class="mono">${accountId}</span>
```

After:
```html
✓<br>${badgeLabel(scenario)}<br><span class="mono">${accountId}</span>

function badgeLabel(scenario) {
  return scenario === 'redundant' ? '已连接' :
         scenario === 'reconnect'  ? '已重连' :
         scenario === 'new_account'? '已切换' :
                                     '已绑定'
}
```

Two-character labels match the existing visual rhythm (⌀1×2chars) and still distinguish the four cases at a glance.

## Tests

### `src/cli/setup-flow.test.ts`

Four new cases covering the scenario branches. Mock `accountsDir` filesystem, mock `sessionState.isExpired`, assert returned scenario:

```ts
describe('persistConfirmedAccount scenario detection', () => {
  it('first: empty accounts dir → first', () => { ... })
  it('reconnect: same userId, expired → reconnect', () => { ... })
  it('redundant: same userId, not expired → redundant', () => { ... })
  it('new_account: different userId active → new_account', () => { ... })
})
```

### `src/cli/schema.test.ts`

Add `scenario: 'first'` to existing SetupPollOutput confirmed fixtures (one-line bump).

### `apps/desktop/src/view.test.ts` (or wherever pollAdvance is tested)

Four cases covering scenario → title/message mapping. Default-fallback case ('first' if scenario missing) for backwards compat.

### `apps/desktop/shim.e2e.test.ts`

If the existing scan e2e asserts on confirmed payload, update it to expect `scenario`. Otherwise no change.

## Backwards compatibility

- **Daemon ↔ CLI**: schema is additive (new required field). Pinned via Zod. CI catches any consumer that doesn't update.
- **CLI ↔ desktop**: same — schema additive.
- **Old daemon + new desktop**: doesn't happen in practice (sidecar is bundled), but defensive `scenario ?? 'first'` fallback in `pollAdvance` is included anyway.
- **Test fixtures**: bumping `scenario: 'first'` everywhere is a one-pass mechanical change.

## Out of scope (explicitly)

- ❌ Multi-account UX beyond "we tell the user it switched". No simultaneous bot polling, no UI for multi-account selection.
- ❌ Showing user's WeChat nickname/avatar — would require ilink to surface it (currently doesn't). If nickname becomes available later, swap into copy verbatim.
- ❌ A "你确定要切换账号吗？" confirmation modal before the scan completes — would require a pre-scan check that we don't have today (we only know post-scan). Possible follow-up: surface scenario via `setup-poll` BEFORE confirmed status (when `scaned`), so the wizard can warn during the "在微信里确认" window.
- ❌ Touching the existing `dedupeAccountsByUserId` logic — it's correct, just blind to user-facing intent.

## Acceptance criteria

- [ ] Four scenarios detect correctly given prepared filesystem fixtures
- [ ] Wizard renders the right copy for each scenario
- [ ] Existing scan e2e still passes (schema-additive change)
- [ ] No change to the actual binding behavior — same dedupe, same archive, same userId persistence
- [ ] `accountId` continues to surface in the small mono badge (debug + audit utility unchanged)

## Open questions for review

1. **Copy** — the four messages are the user-facing payoff of this whole spec. Tweak any of them before implementation.
2. **redundant detection precision** — `sessionState.isExpired` is set when daemon hits errcode=-14. If a user re-scans within seconds of session expiry but BEFORE daemon's poll loop notices, `isExpired` is still false → we'd classify as `redundant`. Acceptable false-positive (the message "this scan refreshed your connection" is still true), but worth flagging.
3. **Should `redundant` block the dedupe?** Arguably yes — if user's just being redundant, we don't have to archive the old bot dir. But ilink already invalidated it server-side, so archiving is the right local mirror. Recommend leaving dedupe as-is; the *message* is the only behavior change.
4. **Should we tell the user how many superseded dirs accumulated?** No — that's debug noise, not user signal. The only user-facing accumulation is the chat history per chat_id, which is preserved.
