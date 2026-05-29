# Companion Proactivity v1 — Self-Authored, Time-Anchored Intentions

**Status**: Design · 2026-05-28
**Author**: 顾时瑞 + Claude
**Motivated by**: the `long_silence_initiative` finding from the 2026-05-29 companion-eval acceptance run (see `eval/companion/README.md` and [`2026-05-28-companion-eval-trajectory-coverage-design.md`](./2026-05-28-companion-eval-trajectory-coverage-design.md)).
**Scope**: A companion-behavior change (changes the daemon). Separate from the eval-harness work that surfaced the gap.

---

## 1. Motivation

The companion eval caught a real behavior gap: the push tick does **not** resurface a persisted open thread. Even with an interview follow-up sitting in a memory file the push-tick prompt explicitly reads, the tick stayed silent; an independent opus judge scored `initiative: 1 / recall: 1`.

Root cause is architectural, not a timid prompt alone. Today the push tick is a **cron poll that asks an open question**: every ~15–30 min it wakes a one-shot agent cold and asks "should I say something?" (`buildPushTickText` + `companionSection()` both end on *"不确定就选不打扰"*). An agent with no continuity, woken cold, *correctly* defaults to silence — or it would nag. The cron model and the timid default are a matched pair.

A friend isn't continuously thinking about you. They **registered** something ("his interview is Wednesday") and **followed through** when the moment came. The continuity that matters is **continuity of intention**, not continuous computation. So: concentrate the expensive "what's worth saying" decision at a **warm moment** (in-conversation, with full context), write the intention down with a trigger, and let a **cheap loop** execute it when the trigger fires. This is the existing companion-memory lineage — "give Claude a filesystem + a timer, the rest is autonomy" (RFC 02) — applied to proactivity.

**Explicitly rejected:** an always-on / continuously-thinking agent. It's expensive, and it isn't how friendship works anyway.

---

## 2. The model: author warm → store cheap → fire mechanically

Three phases, each owned by a different actor:

| phase | when | who | what |
|---|---|---|---|
| **Author** | conversation time | the companion (in its normal reply) | when the user mentions something with a future follow-up moment, record it in `agenda.md` with a due date |
| **Store** | — | `memory/<chat>/agenda.md` | parseable, human-readable, editable in the dashboard |
| **Fire** | push tick | daemon (mechanical) + agent (compose) | daemon finds due items; *only then* runs the agent, with the due intention as a concrete reason |

The key inversion: the **"should I reach out?" decision is made once, warm, at authoring time.** The push tick no longer decides *whether* to talk — it checks *whether anything is due* (mechanical) and, if so, the agent only decides *how to phrase it* (with a narrow skip valve). The default flips from "stay silent unless sure" to "follow through unless there's a reason not to."

---

## 3. `agenda.md` format

Location: `memory/<chat>/agenda.md` (same sandbox as all companion memory — `.md`, ≤100 KB, atomic writes; see `src/daemon/memory/fs-api.ts`).

A pending intention is a markdown task line:

```
# agenda（我给自己记的待跟进）
- [ ] due:2026-05-14 面试后轻轻问结果/感受；别催、别灌鸡汤
- [ ] due:2026-05-22 上次说要重构排产模块，过一阵问问推进得怎样
```

Grammar (the daemon parses only lines matching this; all other prose is ignored, so the companion may keep freeform notes in the same file):

```
- [ ] due:YYYY-MM-DD <body>      # pending
- [x] fired:YYYY-MM-DD <body>    # resolved — sent a check-in
- [x] dropped:YYYY-MM-DD <body>  # resolved — agent judged it stale, didn't send
```

Rules:
- Date-only (`YYYY-MM-DD`); exactly one `due:` token per pending line; `<body>` is freeform.
- An item is **due** when `today ≥ due` AND it is still `- [ ]` (unresolved).
- Each intention fires **at most once** — after a tick handles it, the daemon rewrites the line to `[x] fired:` or `[x] dropped:`. No nag loop.
- Malformed/partial lines are skipped (lenient parser), never crash the tick.

---

## 4. Components

### 4.1 `src/daemon/companion/agenda.ts` (new — pure, unit-tested)

Pure parse/serialize so the logic is testable without a daemon:

```ts
interface AgendaItem {
  raw: string                 // the exact source line (for in-place rewrite)
  status: 'pending' | 'fired' | 'dropped'
  due?: string                // YYYY-MM-DD (pending items)
  body: string
}

function parseAgenda(md: string): AgendaItem[]
function selectDue(items: AgendaItem[], today: string): AgendaItem[]   // today YYYY-MM-DD; due && pending
function markResolved(md: string, item: AgendaItem, outcome: 'fired' | 'dropped', date: string): string
```

`markResolved` does an in-place line rewrite (match `item.raw`) and returns the new file content — the daemon writes it atomically. `today`/`date` are injected (no `new Date()` inside the pure functions) so tests are deterministic.

### 4.2 `pushTick` rewrite (`src/daemon/wiring/tick-bodies.ts`)

```
1. Read memory/<chatId>/agenda.md (absent → "").
2. due = selectDue(parseAgenda(md), today)
3. if due.length === 0:  log "no due intentions"; return   ← SILENT, no LLM call
4. pick the single oldest-due item (others wait for the next tick — keeps pushes paced)
5. dispatch buildPushTickText({ intention: item.body, ... }); detect send vs silent via outbox growth (existing mechanism)
6. markResolved(md, item, sent ? 'fired' : 'dropped', today); atomic write back
```

Two consequences worth noting:
- **Cheaper than today.** The common case (nothing due) returns without an LLM call; today every tick LLM-evaluates "should I push?".
- The daemon is the **single writer** of agenda status (at tick time), so it never races the agent's conversation-time `memory_write`s.

If `selectDue` returns multiple, fire only the oldest this tick; the rest fire on subsequent ticks. (No batch dumping.)

### 4.3 `buildPushTickText` rewrite (`src/daemon/wiring/tick-bodies.ts`)

From the open "should I?" question to a concrete directive:

```
<companion_tick ts="..." default_chat_id="..." />
有一条到点的跟进：「{intention.body}」
先 memory_read 相关 .md 确认它没过期/没被解决。
默认就是发：调 reply 写一句简短、自然的问候（别催、别灌鸡汤）。
只有明显已过期或用户已自己说过结果时才不发——那就直接结束、不产生任何 assistant text。
```

Default = act. The skip valve is narrow and concrete ("过期/已解决"), not "when in doubt, stay silent."

### 4.4 Authoring nudge (`src/core/prompt-builder.ts`)

Two edits in the companion guidance:
- **Conversation section** (near line 156, the "回复前 memory_list" guidance): add — *"当用户提到有未来跟进点的事（面试、截止、复诊、约定），在 `agenda.md` 记一条 `- [ ] due:YYYY-MM-DD <要跟进什么>`。这是你之后主动关心的依据。"*
- **`companionSection()`** (line 195+): replace the "每 15–30 分钟…决定是否 push…不确定就不打扰" mental-model text with the agenda model — *"你不靠定时硬想'要不要找他'。你在聊天里把值得跟进的事记进 `agenda.md`（带 due 日期）；到点时系统会专门唤醒你来兑现这条跟进。"*

This is the **author path** — prompt-driven and probabilistic (inherent to the files+autonomy philosophy), distinct from the deterministic fire path.

### 4.5 Eval: `long_silence_initiative_v1.yaml`

Switch the seed from `threads.md` to `agenda.md` with a **due** item whose date precedes the push tick, isolating the deterministic **fire** path:

```yaml
initial_memory_files:
  agenda.md: |
    # agenda
    - [ ] due:2026-05-15 面试后轻轻问结果/感受；别催、别灌鸡汤
```

The day-8 push tick (2026-05-20) finds the due item → fires → `decision: send`, `must_recall: ["面试"]` → **green**. This makes the red regression marker pass once the fire mechanism works. (Testing the **author** path — does a mentioned dated thread get *written* to `agenda.md` — is a separate, fuzzier future trajectory, not in this spec.)

---

## 5. Data flow

```
conversation → companion reply → (maybe) memory_write agenda.md:  "- [ ] due:DATE body"
                                                  │
push tick (~15–30m) → read agenda.md → parseAgenda → selectDue(today)
   │                                                      │
   ├─ none due → silent (no LLM)                          │
   └─ oldest due → buildPushTickText(intention) → dispatch│→ reply (send) | silent (skip)
                                                          │
                              daemon markResolved → atomic write agenda.md ([x] fired/dropped)

dashboard memory pane → renders agenda.md unchanged (it already renders memory .md)
```

---

## 6. Error handling & edges

- **No `agenda.md` / no due items:** silent, no LLM. The overwhelmingly common path.
- **Malformed lines:** skipped by the lenient parser; never crash a tick.
- **Stale intention** (interview cancelled): caught by the fire-time skip valve (agent reads context, judges "already resolved/over" → silent → daemon marks `dropped`). No introspect curation needed for v1.
- **Write race:** daemon owns status mutation at tick time; agent's conversation-time writes are separate moments; atomic tmp+rename (existing fs-api) bounds any overlap.
- **Multiple due:** fire the single oldest per tick; rest wait. Paces pushes.
- **`createTimeMs`/`today`:** injected into the pure agenda functions; the tick passes its `nowIso` (already threaded for eval virtual time).

---

## 7. Scope

**In:**
- `agenda.ts` (parse / selectDue / markResolved) + unit tests
- `pushTick` gated-on-due rewrite + `buildPushTickText` intention directive
- authoring nudge in `prompt-builder.ts` (two edits)
- `long_silence_initiative_v1.yaml` → `agenda.md` seed → green

**Deferred (noted, not built):**
- **Introspect-tick curation** of the agenda (retire stale / reschedule / catch threads the live reply missed). The fire-time skip valve covers the worst case for v1.
- **Event-type conditions** (#3) — ilink exposes almost no event surface today; the `condition` model is shaped time-first but extensible.
- **Snooze / reschedule** of an intention.
- **Quiet-hours respect.** `companion_config.quiet_hours_local` is currently **inert across the whole daemon** (no usage in `src/`); wiring quiet-hours is orthogonal net-new behavior and out of scope here.
- **Author-path eval** (does conversation → `agenda.md` write happen).

**Out (rejected):**
- Always-on / continuously-thinking agent.

---

## 8. Open questions

1. **Date vs datetime.** v1 is date-only (`due:YYYY-MM-DD`), fires on the first tick on/after that date. A same-day "this afternoon" follow-up isn't expressible. Acceptable for v1 (follow-ups are typically day-grained); revisit if needed.
2. **Timezone.** `today` is the daemon's local date. With `quiet_hours_local` deferred and date-only granularity, a tz mismatch can only shift a fire by ~a day at worst. Fine for v1.
3. **Body length in the tick prompt.** The intention `<body>` is freeform; if a companion writes a paragraph, the fire prompt carries it verbatim. No cap in v1 (the 100 KB file cap is the backstop); revisit if bodies bloat.
