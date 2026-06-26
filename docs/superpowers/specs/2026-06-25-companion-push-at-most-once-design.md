# Companion proactive push — at-most-once on sleep/wake

**Date:** 2026-06-25
**Status:** approved
**Related:** inbound dedup (`mw-dedup`, commit `fix(dedup): skip redelivered inbound messages on macOS sleep/wake`)

## Problem

After a macOS sleep/wake, the companion proactive-push layer re-sends a
proactive message it already sent. Same root-cause family as the inbound
re-reply bug: the "already done" marker is written *after* the slow action,
leaving a wide window where the push went out but is not yet recorded.

In `src/daemon/wiring/tick-bodies.ts` `pushTick`, dedup is the agenda.md
checkbox flip `- [ ] due:…` → `- [x] done:…`, written by `markResolved`
**after** `handle.dispatch(tickText)` completes (lines 138–143). The dispatch
is a full LLM turn that sends the proactive message partway through. If the
machine sleeps mid-dispatch (turn then errors on wake) or the daemon is
restarted / lock-stolen before the post-dispatch write lands, the intention
stays `- [ ]` pending. The next tick — including the one that fires
immediately on wake — re-selects it and pushes again.

## Decision

Mark the intention resolved **before** dispatch, not after — an optimistic
claim. This is the **opposite** trade-off from the inbound fix, and
deliberately so:

- Inbound chose *at-least-once* (mark after reply) because missing a reply is
  worse than a redelivery that the dedup table catches.
- Proactive push chooses *at-most-once* (mark before push) because the
  reported symptom is duplicates, and a missed proactive nudge is low-stakes
  (the agent can re-author the intention). Better to occasionally skip one
  than to ever spam a duplicate.

## Change

`src/daemon/wiring/tick-bodies.ts` `pushTick` only. After the in-flight guard
and `acquire` succeed, and **before** `handle.dispatch`:

```
const updated = markResolved(agendaMd, item, today)
if (updated !== agendaMd) agendaFs.write('agenda.md', updated)
try { for await (const _ev of handle.dispatch(tickText)) {} } catch { return }
```

The post-dispatch re-read + `markResolved` (lines 138–143) is removed.

### Notes / edge cases

1. The mark is computed from `agendaMd` (already read at line 94). Nothing
   edits the file between the read and the mark: the in-flight guard
   guarantees no concurrent user dispatch on this session, and the agent only
   edits agenda.md *during* dispatch — which now runs *after* our write, so
   its additions layer on top of the `[x]` and are not clobbered. Removing the
   after-dispatch re-read also removes the original read-modify-write race.
2. Semantics otherwise unchanged: an intention that gets its tick is marked
   done whether or not the agent ultimately pushed — same as today, only
   earlier.
3. The only behavior change: a dispatch failure no longer leaves the item
   pending for retry (current line 136 `return`). It is already marked done →
   no retry. This is the at-most-once trade-off.
4. Early-return paths (no `default_chat_id`, no due item, session in-flight,
   acquire failure) all occur before the mark, so they never falsely resolve
   an intention.

## Testing (TDD)

1. Same due intention, two consecutive `pushTick` calls (sleep→wake
   re-trigger): dispatch invoked exactly once; the second tick finds no due
   item.
2. First dispatch throws: the intention is still marked done (at-most-once) —
   no re-push on the next tick.
3. Agent appends a new intention to agenda.md during dispatch: it survives
   (not clobbered), and the fired item is `[x]`.
4. Early-return paths write nothing to agenda.md.

## Out of scope

Other wake-time timer effects (idle/permission sweeps, reconnect latency) —
not user-facing duplicates; tracked separately if needed. The introspect tick
already persists `last_introspect_at` and is not part of this change.
