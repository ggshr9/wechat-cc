# Fire-Prompt Skip-Valve Calibration

**Status**: Design · 2026-05-29
**Motivated by**: the agent-current-time-authority empirical result (`docs/superpowers/specs/2026-05-28-agent-current-time-authority-design.md` §2.C) — with virtual dates now correct and the gate dispatching due items, the push tick was still 5/6 silent. The run that fired had `due` == the tick date; the silent runs had `due` several days earlier, implicating the fire prompt's "已过期" skip valve treating a slightly-overdue follow-up as expired.
**Scope**: One prompt edit + the same empirical verify/flip gate. Small.

---

## 1. Problem

`buildPushTickText` (`src/daemon/wiring/tick-bodies.ts`) ends with:

> 默认就是发：调 reply 写一句简短、自然的问候（别催、别灌鸡汤）。
> 只有明显已过期、或用户已经自己说过结果时才不发——那就直接结束这一轮，不调用 reply，也不要产生任何 assistant text。

The agent interprets a follow-up whose `due` date is a few days in the past as **已过期** and skips. But "a few days late" is the *normal* case — the gate only fires items that are *already due*, and a follow-up may legitimately sit a few days before a tick picks it up. Treating that as expired defeats the whole point (a late "how'd the interview go?" is still wanted).

Evidence (6-run real-SDK, 3× each of long_silence + tech_stress): only the run whose `due` equalled the tick date fired; the days-overdue runs stayed silent.

## 2. Change

One edit, the closing lines of `buildPushTickText`. Redefine "已过期" narrowly and make a late check-in explicitly still fire:

> 默认就是发：调 reply 写一句简短、自然的问候（别催、别灌鸡汤）。晚了几天也照常发，自然带一句就行（"前两天那个面试…"），不用为迟到道歉。
> "已过期" 指这件事**本身**已经没意义了——约定的具体时刻早过去很久、或明显已经无关；单纯晚几天**不算**过期。只有真的没意义、或用户已经自己说过结果，才不发——那就直接结束这一轮，不调用 reply，也不要产生任何 assistant text。

No change to the gate, agenda format, or `selectDue` — those already correctly surface due items. This only adjusts how the agent decides to *act* on a surfaced item.

## 3. Verify (same gate as the prior change)

Re-run `long_silence_initiative_v1` + `tech_stress_followup_v1`, **3× each** (real SDK).

- **Reliably green** (proactive `send` + recalls 面试 / 504 on **all** runs) → flip both `proactive_decision` probes from `decision: n/a` back to `decision: send` + `must_recall` (restore the regression tests). Update README/memory: skip-valve hypothesis confirmed, trajectories green.
- **Still flaky** (any silent run) → **stop**. This is the pre-committed exit: the decline is deeper than the skip valve (companion persona restraint), and we do **not** keep iterating on the prompt. Keep `n/a`; document that the reword improved the wording but didn't reliably flip e2e, so the residual cause is persona-level restraint — out of scope to chase further here.

"Reliably" = `send` on every one of the 6 runs.

## 4. Components / files

- `src/daemon/wiring/tick-bodies.ts` — `buildPushTickText` closing lines (the only code change).
- `src/daemon/wiring/tick-bodies.test.ts` — update the `buildPushTickText` text assertion if it pins the old "已过期" wording (check; adjust to a stable substring of the new text).
- `eval/companion/trajectories/{long_silence_initiative_v1,tech_stress_followup_v1}.yaml` — conditionally flip proactive probes (green branch only).
- `eval/companion/README.md` + memory — record the outcome.

## 5. Testing

- `bun --bun vitest run src/daemon/wiring/tick-bodies.test.ts` green; `bun x tsc --noEmit` clean; full suite green.
- The §3 real-SDK re-runs are the acceptance gate for the conditional flip.

## 6. Scope

**In:** the `buildPushTickText` skip-valve reword; conditional probe flip; doc/memory update.
**Out:** gate/agenda/`selectDue` mechanics; redesigning the companion persona's restraint; libfaketime; any further prompt iteration beyond this single reword (the stop rule in §3).

## 7. Open question

The diagnosis (skip valve) is inferred from the fire/silent pattern, not the agent's captured reasoning. §3 is therefore also the experiment: a reliably-green result confirms it; a flaky result disconfirms it and triggers the stop rule rather than more tweaking.
