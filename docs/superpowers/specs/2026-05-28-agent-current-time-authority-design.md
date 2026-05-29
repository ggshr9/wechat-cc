# Agent Current-Time Authority (Legible + Authoritative `ts`)

**Status**: Design · 2026-05-28
**Motivated by**: the `long_silence` / `tech_stress` e2e gap from [companion proactivity v1](./2026-05-28-companion-proactive-intentions-design.md) — the companion authored agenda due-dates from the *real* wall-clock, not the trajectory's virtual time, so the gated push tick never fired in the eval.
**Scope**: Small. Make the message timestamp the agent's authoritative "now". Primary payoff is **eval determinism**; production is already correct.

---

## 1. Motivation

The companion eval replays events at **virtual** timestamps, but the agent computed dates ("下周三") from the **real** wall-clock. Investigation found:

1. Virtual time **already reaches the agent**: `formatInbound` (`src/core/prompt-format.ts:31`) emits `ts="${m.createTimeMs}"` on every `<wechat …>` envelope — the message's timestamp, which is virtual in the eval. But it's a **raw epoch-ms integer**, which the model doesn't reliably read as "current time".
2. The claude-agent-sdk's `systemPrompt: { type: 'preset', preset: 'claude_code', append: … }` (`src/daemon/bootstrap/index.ts:434`) bakes in the **real** "Today's date". That real date out-competes our raw-epoch `ts`, so the agent's date arithmetic uses real time.

**Production is already correct**: there, `createTimeMs` (real receive time) and the preset's date (real) agree. So this change is **purely eval-determinism infrastructure** — it lets the eval verify time-anchored companion behavior end-to-end, which is currently only unit-proven.

The fix is not "propagate virtual time" (it's already propagated) — it's making that time **legible** and **authoritative** over the preset's real date.

---

## 2. Design

### A. Legible `ts` (`src/core/prompt-format.ts`)

`formatInbound` emits `ts` as an ISO-8601 UTC string instead of raw epoch-ms:

```ts
// before:  ts="${m.createTimeMs}"
// after:   ts="${new Date(m.createTimeMs).toISOString()}"
```

Pure and deterministic (no clock read — derived from the message's own `createTimeMs`). Same information, model-legible. The push tick's `buildPushTickText` already emits an ISO `ts`, so after this change both agent-facing time surfaces use the same format.

**Timezone:** UTC. We only have an absolute epoch and don't store a per-user tz. For date-granular follow-ups, UTC vs the user's local offset only diverges near local midnight; the eval trajectories' events (20:00 / 23:42 +08 → 12:00 / 15:42 Z) stay on the same UTC date. Per-user tz is deferred.

### B. Authoritative declaration (`src/core/prompt-builder.ts`)

In `baseChannelSection` (the block describing the `<wechat … ts="…">` envelope, ~line 68), add an explicit instruction that the envelope `ts` is the authoritative current time and overrides the base prompt's "Today's date":

> 每条 `<wechat>` / `<companion_tick>` 信封上的 `ts` 是这条消息/这次唤醒的发生时间，也是你的「当前时间」基准。做任何日期/时间推理（"下周三"、"三天后"、判断某事是否已过期）都以 `ts` 为准——**不要用系统提示里的 "Today's date"**，那个可能与真实对话时间不符。

This applies to both reactive replies and the push tick (whose `ts` is already ISO).

### C. Empirical verification + conditional trajectory flip

The lightweight bet is that A+B make the model honor virtual time. We verify empirically rather than assume:

1. Re-run `long_silence_initiative_v1` and `tech_stress_followup_v1` (real SDK) **2–3 times each**.
2. **If reliably green** — the companion authors agenda items dated off the virtual `ts`, the gate fires, proactive probe = `send` + `must_recall` (面试 / 504) — **flip those probes back from `decision: n/a` to `decision: send` + `must_recall`**, restoring them as real regression tests.
3. **If flaky** (the preset date still wins on some runs) — **keep `decision: n/a`**, and document that A+B improve production date-reasoning but don't reliably override the SDK preset in-eval. **Do not escalate to libfaketime** (out of scope; the fire mechanism stays unit-proven).

"Reliably" = green on every run of the 2–3; a single silent run means flaky → keep `n/a`.

---

## 3. Components / files

- `src/core/prompt-format.ts` — `formatInbound` `ts` → ISO-8601 UTC. (One line + any test that pinned the raw-epoch `ts`.)
- `src/core/prompt-builder.ts` — `baseChannelSection` authoritative-time instruction.
- `eval/companion/trajectories/long_silence_initiative_v1.yaml`, `tech_stress_followup_v1.yaml` — conditionally flip proactive probes back to `send`+`must_recall` (step C).
- `eval/companion/README.md` + memory — update the disposition based on the empirical result.

---

## 4. Testing

- **Unit:** update any test asserting the old raw-epoch `ts` (likely `prompt-format` tests + e2e snapshot assertions that match `ts="<digits>"`). Add/adjust a `formatInbound` assertion that `ts` is ISO-8601 (e.g. matches `/ts="\d{4}-\d{2}-\d{2}T/`).
- `bun x tsc --noEmit` clean; `bun --bun vitest run` green (modulo known-unrelated flaky desktop-shim e2e).
- **Empirical (real SDK):** the §2.C re-runs are the acceptance gate for the trajectory flip.

---

## 5. Scope

**In:** legible ISO `ts`; authoritative-time prompt instruction; empirical eval verification; conditional trajectory flip; doc/memory update.

**Out:** libfaketime / faking the subprocess clock; changing or dropping the SDK `claude_code` preset; per-user timezone storage; relative/event-condition intentions.

---

## 6. Open questions

1. **Reliability is model-dependent.** A+B ask the model to prefer our `ts` over the preset's "Today's date". The §2.C empirical step is exactly to find out if that's reliable enough; the design pre-commits to the honest fallback (keep `n/a`) rather than forcing green.
2. **UTC vs local tz** (see §2.A) — accepted for v1; per-user tz deferred.
