# Agent Current-Time Authority — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the message/tick `ts` the agent's authoritative "now" (legible ISO + a prompt instruction that overrides the SDK preset's real "Today's date"), then empirically decide whether the two time-anchored eval trajectories can flip back to green.

**Architecture:** Two tiny source edits (`formatInbound` emits ISO-8601 UTC `ts`; `baseChannelSection` declares `ts` authoritative for date reasoning) + an empirical eval step that flips `long_silence`/`tech_stress` proactive probes from `decision:n/a` back to `send`+`must_recall` only if real-SDK re-runs are reliably green. Spec: `docs/superpowers/specs/2026-05-28-agent-current-time-authority-design.md`.

**Tech Stack:** TypeScript, Bun, vitest. Pure function `formatInbound` (`src/core/prompt-format.ts`); system-prompt builder (`src/core/prompt-builder.ts`); companion eval harness.

**Test commands:**
- Unit: `bun --bun vitest run src/core/prompt-format.test.ts src/core/prompt-builder.test.ts`
- Typecheck: `bun x tsc --noEmit`
- Full unit suite: `bun --bun vitest run`
- Eval (real SDK, manual): `bun run eval:companion --trajectory <id>`

---

## Task 1: `formatInbound` emits ISO-8601 UTC `ts`

**Files:**
- Modify: `src/core/prompt-format.ts:31`
- Modify: `src/core/prompt-format.test.ts` (add an ISO assertion)

- [ ] **Step 1: Write the failing test**

Add to `src/core/prompt-format.test.ts` inside `describe('formatInbound', ...)`:

```typescript
  it('emits ts as ISO-8601 UTC (legible to the agent), not raw epoch ms', () => {
    const out = formatInbound({
      chatId: 'c', userId: 'u', userName: 'x',
      text: 'hi', msgType: 'text', createTimeMs: 1_000_000, accountId: 'a',
    })
    expect(out).toContain('ts="1970-01-01T00:16:40.000Z"') // new Date(1_000_000).toISOString()
    expect(out).not.toContain('ts="1000000"')
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun --bun vitest run src/core/prompt-format.test.ts`
Expected: FAIL — current output has `ts="1000000"` (raw epoch).

- [ ] **Step 3: Implement**

In `src/core/prompt-format.ts`, change the `ts` attribute line in `formatInbound`:

```typescript
// from:
    `ts="${m.createTimeMs}"`,
// to:
    `ts="${new Date(m.createTimeMs).toISOString()}"`,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun --bun vitest run src/core/prompt-format.test.ts`
Expected: PASS (all, including the 4 pre-existing ones — none asserted the raw-epoch value).

- [ ] **Step 5: Typecheck + commit**

```bash
bun x tsc --noEmit
git add src/core/prompt-format.ts src/core/prompt-format.test.ts
git commit -m "feat(prompt): formatInbound emits ISO-8601 ts (legible current time)"
```

---

## Task 2: Declare envelope `ts` authoritative over the preset date

**Files:**
- Modify: `src/core/prompt-builder.ts` (`baseChannelSection`, ~line 67-71)
- Modify: `src/core/prompt-builder.test.ts` (assert the instruction is present)

- [ ] **Step 1: Write the failing test**

In `src/core/prompt-builder.test.ts`, add a test (adapt to how the file builds the prompt — it calls `buildSystemPrompt({...})`; copy the arg shape from an existing test in that file):

```typescript
  it('declares the envelope ts authoritative for date reasoning', () => {
    const out = buildSystemPrompt({
      providerId: 'claude', companionEnabled: false, delegateAvailable: false,
    })
    expect(out).toContain('以 `ts` 为准')
    expect(out).toContain('Today\'s date')
  })
```

(If `buildSystemPrompt`'s required args differ, match an existing passing test's call exactly — only `providerId` is needed for `baseChannelSection`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bun --bun vitest run src/core/prompt-builder.test.ts`
Expected: FAIL — the instruction isn't in the prompt yet.

- [ ] **Step 3: Implement**

In `src/core/prompt-builder.ts`, in `baseChannelSection`, add a new bullet immediately after the `<wechat ... ts="...">` envelope bullet (the one ending `…可能来自同一个 chat_id。`):

```
- 信封上的 \`ts\` 是这条消息（或 \`<companion_tick>\` 唤醒）的发生时间，也是你的「当前时间」基准。做任何日期/时间推理（"下周三"、"三天后"、判断某事是否已过期）都以 \`ts\` 为准——**不要用系统提示里的 "Today's date"**，它可能与真实对话时间不符。
```

Match the surrounding template-literal style (the section is a `` `...` `` template; inline code uses `` \` ``).

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun --bun vitest run src/core/prompt-builder.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Typecheck + commit**

```bash
bun x tsc --noEmit
git add src/core/prompt-builder.ts src/core/prompt-builder.test.ts
git commit -m "feat(prompt): declare envelope ts authoritative over preset Today's date"
```

---

## Task 3: Empirical eval verification + conditional trajectory flip

**Files (conditionally modified — only on the reliably-green branch):**
- Modify: `eval/companion/trajectories/long_silence_initiative_v1.yaml`
- Modify: `eval/companion/trajectories/tech_stress_followup_v1.yaml`
- Modify: `eval/companion/README.md`

This task is empirical: real-SDK runs decide the outcome. No code logic — a measurement + a documented decision.

- [ ] **Step 1: Re-run both time-anchored trajectories, 3× each**

```bash
for i in 1 2 3; do bun run eval:companion --trajectory long_silence_initiative_v1; done
for i in 1 2 3; do bun run eval:companion --trajectory tech_stress_followup_v1; done
```
For each run, open the newest `eval/companion/runs/<ts>/report.md` and the `.jsonl`. Record, for the `proactive_decision` probe: `decision` (send/silent) and whether the reply text contains `面试` (long_silence) / `504` (tech_stress). Also check the `.jsonl` snapshot's `memory.files["agenda.md"]` at the tick — did the companion author an item with a due-date ≤ the virtual tick date (i.e., it used the envelope `ts`, not real time)?

- [ ] **Step 2: Apply the decision rule**

- **Reliably green** = the `proactive_decision` probe is `send` AND the reply recalls the keyword on **all 3** runs of **both** trajectories → go to Step 3 (flip).
- **Flaky** = any run is silent / misses the keyword → go to Step 4 (keep `n/a`).

- [ ] **Step 3 (flip branch): restore `send` + `must_recall` on both proactive probes**

In `eval/companion/trajectories/long_silence_initiative_v1.yaml`, replace the `proactive_decision` probe's `expected`+`dimensions` block (currently `decision: n/a` with the blocked-on-virtual-time comment) with:

```yaml
      expected:
        decision: send
        summary: "面试过去了，轻轻问一句结果/感受；不抱怨他不回消息"
        must_recall: ["面试"]
        must_not_recall: ["你怎么不理我", "为什么不回", "好久没"]
        tone_hints: ["轻", "关心结果而非催促"]
        state_predicates: []
      dimensions: [recall, initiative, calibration, restraint]
```

In `eval/companion/trajectories/tech_stress_followup_v1.yaml`, replace the `proactive_decision` probe's `expected`+`dimensions` block with:

```yaml
      expected:
        decision: send
        summary: "可以问一下 migration 之后稳了没 / 昨晚睡好没"
        must_recall: ["504"]
        must_not_recall: ["抑郁", "建议"]
        tone_hints: ["不要叫人‘加油’", "短"]
        state_predicates: []
      dimensions: [recall, calibration, initiative, restraint]
```

Then smoke-load both: `bun -e "import { loadTrajectory } from './eval/companion/engine/trajectory'; for (const f of ['long_silence_initiative_v1','tech_stress_followup_v1']) { const t=loadTrajectory('./eval/companion/trajectories/'+f+'.yaml'); console.log(f, t.events.find(e=>e.probe_kind==='proactive_decision').expected.decision) }"` → expect both print `send`.

Update `eval/companion/README.md`: change the `long_silence_initiative` section from "blocked on virtual-time propagation" to "resolved — the agent honors the envelope `ts` as authoritative current time (commit <fill in>); proactive probes restored to `send`+`must_recall`."

- [ ] **Step 4 (keep-n/a branch): document the empirical result**

Leave both trajectories at `decision: n/a`. Update `eval/companion/README.md`'s `long_silence_initiative` section to record: the ISO-`ts` + authoritative-time instruction improves production date-reasoning, but in-eval the SDK `claude_code` preset's "Today's date" still wins on some runs (cite which runs were silent), so the time-anchored probes stay `n/a`; escalating to libfaketime is out of scope.

- [ ] **Step 5: Commit (whichever branch)**

```bash
git add eval/companion/trajectories/long_silence_initiative_v1.yaml eval/companion/trajectories/tech_stress_followup_v1.yaml eval/companion/README.md
git commit -m "test(eval): time-anchored trajectories — <flip to send | keep n/a> after ts-authority change"
```

(If Step 4, only `README.md` changed — `git add eval/companion/README.md` and commit with the keep-n/a message.)

---

## Self-review notes

- **Spec coverage:** §2.A legible ISO `ts` → Task 1. §2.B authoritative declaration → Task 2. §2.C empirical verify + conditional flip → Task 3 (decision rule = Step 2; flip = Step 3; fallback = Step 4). §4 testing → Task 1/2 unit asserts + Task 3 real-SDK gate. §5 scope respected (no libfaketime, no preset change, no tz storage).
- **Placeholder check:** Task 3 has two genuine branches (flip vs keep), both with full content — not a placeholder. The README edit text in Step 3 has a `<fill in>` for the commit SHA, which is necessarily unknown until commit time (acceptable — it's a SHA reference, not missing logic).
- **Type consistency:** `formatInbound` signature unchanged (still takes `createTimeMs: number`); only the emitted string format changes. `buildSystemPrompt` call shape in Task 2's test must match the file's existing tests — flagged in Step 1.
- **Determinism:** `new Date(1_000_000).toISOString()` is `'1970-01-01T00:16:40.000Z'` (verified arithmetic: 1_000_000 ms = 1000 s = 16 min 40 s past epoch). The test asserts that exact string.
