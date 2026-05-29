# Companion Proactivity v1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the companion push tick fire self-authored, time-anchored intentions from `agenda.md` instead of cold-polling "should I say something?".

**Architecture:** A pure `agenda.ts` module (parse / select-due / mark-resolved) drives a rewritten `pushTick`: read `memory/<chat>/agenda.md`, fire the oldest due item (mechanical), let the agent only compose/skip, then mark it resolved so it fires at most once. The companion authors intentions in-conversation via two prompt nudges. Spec: `docs/superpowers/specs/2026-05-28-companion-proactive-intentions-design.md`.

**Tech Stack:** TypeScript, Bun, vitest. Existing infra: `makeMemoryFS` (sandboxed atomic memory IO), `buildTickBodies`/`pushTick` (`src/daemon/wiring/tick-bodies.ts`), `prompt-builder.ts`, companion eval harness.

**Deviation from spec (flag at review):** spec §3/§4.2 distinguish `[x] fired:` vs `[x] dropped:`. That needs send-vs-skip detection, which couples to the agent-event schema. v1 uses a **single `[x] done:DATE` resolved state** — fires-at-most-once is preserved; the agent's skip-on-stale still works; whether it actually sent is visible in the chat. The parser still recognizes `fired`/`dropped` for forward-compat.

**Test commands:**
- Engine/unit (incl. eval engine + new agenda tests): `bun --bun vitest run -c vitest.eval-engine.config.ts <path>`
- Full unit suite: `bun --bun vitest run`
- Typecheck: `bun x tsc --noEmit`
- Smoke-load a trajectory: `bun -e "import { loadTrajectory } from './eval/companion/engine/trajectory'; loadTrajectory('./eval/companion/trajectories/<f>.yaml')"`
- Full eval run (manual, real SDK): `bun run eval:companion --trajectory <id>`

---

## Task 1: `agenda.ts` — pure parse / select-due / mark-resolved

**Files:**
- Create: `src/daemon/companion/agenda.ts`
- Create: `src/daemon/companion/agenda.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/daemon/companion/agenda.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { parseAgenda, selectDue, markResolved } from './agenda'

const SAMPLE = `# agenda（我给自己记的待跟进）
- [ ] due:2026-05-14 面试后轻轻问结果/感受
- [ ] due:2026-06-01 重构排产模块后问推进
- [x] done:2026-05-02 上次的部署问过了
随便一行 prose，应该被忽略
- [ ] 没有 due 的行也忽略`

describe('parseAgenda', () => {
  it('parses pending and resolved items, ignores prose and due-less lines', () => {
    const items = parseAgenda(SAMPLE)
    expect(items).toHaveLength(3)
    expect(items[0]).toMatchObject({ status: 'pending', due: '2026-05-14', body: '面试后轻轻问结果/感受' })
    expect(items[1]).toMatchObject({ status: 'pending', due: '2026-06-01' })
    expect(items[2]).toMatchObject({ status: 'resolved', due: null })
  })

  it('recognizes fired/dropped as resolved (forward-compat)', () => {
    const items = parseAgenda('- [x] fired:2026-05-10 a\n- [x] dropped:2026-05-11 b')
    expect(items.map(i => i.status)).toEqual(['resolved', 'resolved'])
  })

  it('returns [] for empty input', () => {
    expect(parseAgenda('')).toEqual([])
  })
})

describe('selectDue', () => {
  it('returns pending items whose due is on or before today', () => {
    const due = selectDue(parseAgenda(SAMPLE), '2026-05-20')
    expect(due).toHaveLength(1)
    expect(due[0]!.due).toBe('2026-05-14')
  })

  it('excludes future-due and already-resolved items', () => {
    const due = selectDue(parseAgenda(SAMPLE), '2026-05-14') // exactly the due date → included
    expect(due.map(i => i.due)).toEqual(['2026-05-14'])
    const none = selectDue(parseAgenda(SAMPLE), '2026-05-13') // day before → excluded
    expect(none).toEqual([])
  })
})

describe('markResolved', () => {
  it('rewrites the matching pending line to done, leaving others intact', () => {
    const items = parseAgenda(SAMPLE)
    const out = markResolved(SAMPLE, items[0]!, '2026-05-20')
    expect(out).toContain('- [x] done:2026-05-20 面试后轻轻问结果/感受')
    expect(out).not.toContain('- [ ] due:2026-05-14')
    expect(out).toContain('- [ ] due:2026-06-01 重构排产模块后问推进') // untouched
  })

  it('is a no-op when the item line is no longer present', () => {
    const items = parseAgenda(SAMPLE)
    const stale = { ...items[0]!, raw: '- [ ] due:1999-01-01 not in file' }
    expect(markResolved(SAMPLE, stale, '2026-05-20')).toBe(SAMPLE)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun --bun vitest run -c vitest.eval-engine.config.ts src/daemon/companion/agenda.test.ts`
Expected: FAIL — module `./agenda` not found.

- [ ] **Step 3: Implement `agenda.ts`**

Create `src/daemon/companion/agenda.ts`:

```typescript
/**
 * agenda.ts — pure parse/select/serialize for the companion's self-authored
 * intention list (memory/<chat>/agenda.md). Kept side-effect-free so the
 * push-tick logic is unit-testable without a daemon; `today`/`date` are
 * injected (no `new Date()` here).
 *
 * Pending line:   - [ ] due:YYYY-MM-DD <body>
 * Resolved line:  - [x] done:YYYY-MM-DD <body>   (also reads fired:/dropped:)
 * All non-matching lines (headings, prose, due-less items) are ignored.
 */

export interface AgendaItem {
  /** Exact source line — used to locate the line for in-place rewrite. */
  raw: string
  status: 'pending' | 'resolved'
  /** 'YYYY-MM-DD' for pending items; null once resolved. */
  due: string | null
  body: string
}

const PENDING_RE = /^- \[ \] due:(\d{4}-\d{2}-\d{2})\s+(.*)$/
const RESOLVED_RE = /^- \[x\] (?:done|fired|dropped):(\d{4}-\d{2}-\d{2})\s+(.*)$/

export function parseAgenda(md: string): AgendaItem[] {
  const items: AgendaItem[] = []
  for (const line of md.split('\n')) {
    const p = PENDING_RE.exec(line)
    if (p) {
      items.push({ raw: line, status: 'pending', due: p[1]!, body: p[2]!.trim() })
      continue
    }
    const r = RESOLVED_RE.exec(line)
    if (r) {
      items.push({ raw: line, status: 'resolved', due: null, body: r[2]!.trim() })
    }
    // everything else: ignored
  }
  return items
}

/** Pending items due on or before `today` (YYYY-MM-DD). ISO dates sort lexicographically. */
export function selectDue(items: AgendaItem[], today: string): AgendaItem[] {
  return items.filter(i => i.status === 'pending' && i.due !== null && i.due <= today)
}

/**
 * Rewrite `item`'s line in `md` to a resolved `done:` line. Returns the new
 * file content. No-op (returns `md` unchanged) if the exact source line is no
 * longer present — so a concurrent agent edit can't be clobbered into a wrong
 * state.
 */
export function markResolved(md: string, item: AgendaItem, date: string): string {
  const lines = md.split('\n')
  const idx = lines.indexOf(item.raw)
  if (idx === -1) return md
  lines[idx] = `- [x] done:${date} ${item.body}`
  return lines.join('\n')
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun --bun vitest run -c vitest.eval-engine.config.ts src/daemon/companion/agenda.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Typecheck + commit**

```bash
bun x tsc --noEmit
git add src/daemon/companion/agenda.ts src/daemon/companion/agenda.test.ts
git commit -m "feat(companion): agenda.ts — pure parse/select-due/mark-resolved for intentions"
```

---

## Task 2: `buildPushTickText` — intention directive

**Files:**
- Modify: `src/daemon/wiring/tick-bodies.ts` (`BuildPushTickTextOpts` interface ~line 51, `buildPushTickText` ~line 61)

- [ ] **Step 1: Add `intention` to the opts interface**

In `src/daemon/wiring/tick-bodies.ts`, replace:

```typescript
export interface BuildPushTickTextOpts {
  nowIso: string
  defaultChatId: string
}
```

with:

```typescript
export interface BuildPushTickTextOpts {
  nowIso: string
  defaultChatId: string
  /** The due intention body the tick is firing — the concrete reason to reach out. */
  intention: string
}
```

- [ ] **Step 2: Rewrite `buildPushTickText` body**

Replace the entire `buildPushTickText` function with:

```typescript
export function buildPushTickText(opts: BuildPushTickTextOpts): string {
  return (
    `<companion_tick ts="${opts.nowIso}" default_chat_id="${opts.defaultChatId}" />\n` +
    `有一条到点的跟进：「${opts.intention}」\n` +
    `先 memory_read 相关 .md，确认它没过期、用户也没自己说过结果。\n` +
    `默认就是发：调 reply 写一句简短、自然的问候（别催、别灌鸡汤）。\n` +
    `只有明显已过期、或用户已经自己说过结果时才不发——那就直接结束这一轮，不调用 reply，也不要产生任何 assistant text。`
  )
}
```

- [ ] **Step 3: Verify no other caller breaks**

Run: `grep -rn "buildPushTickText" src/ eval/ | grep -v "tick-bodies.ts"`
Expected: no matches (only `tick-bodies.ts` references it). If any appears, it must pass `intention`. Then:

Run: `bun x tsc --noEmit`
Expected: ONE error in `tick-bodies.ts` `pushTick` (the existing call at ~line 116 lacks `intention`). That call is replaced in Task 3 — leave it for now and confirm the error is only that line.

- [ ] **Step 4: Commit**

```bash
git add src/daemon/wiring/tick-bodies.ts
git commit -m "feat(companion): buildPushTickText fires a concrete intention (default=act)"
```

---

## Task 3: `pushTick` — gate on due intentions, fire oldest, mark resolved

**Files:**
- Modify: `src/daemon/wiring/tick-bodies.ts` (imports near top; `pushTick` ~lines 75-131)

This boots a real daemon, so it is not unit-tested here — verification is `tsc` clean + reasoning + the eval acceptance run in Task 6. The pure logic it relies on is already tested in Task 1.

- [ ] **Step 1: Add imports**

In `src/daemon/wiring/tick-bodies.ts`, add to the import block at the top (after the existing imports):

```typescript
import { makeMemoryFS } from '../memory/fs-api'
import { parseAgenda, selectDue, markResolved } from '../companion/agenda'
```

(`join` from `node:path` is already imported.)

- [ ] **Step 2: Replace the `pushTick` function body**

Replace the entire `async function pushTick(...) { ... }` (the current body, ~lines 75-131) with:

```typescript
  async function pushTick(opts?: { nowIso?: string }): Promise<void> {
    const cfg = loadCompanionConfig(deps.stateDir)
    if (!cfg.default_chat_id) { deps.log('SCHED', 'skip tick — no default_chat_id'); return }
    const chatId = cfg.default_chat_id

    // Gate on the agenda: only wake the agent if a self-authored intention is
    // due. No due item → silent, WITHOUT an LLM call (the common case).
    const nowIso = opts?.nowIso ?? new Date().toISOString()
    const today = nowIso.slice(0, 10)
    const agendaFs = makeMemoryFS({ rootDir: join(deps.stateDir, 'memory', chatId) })
    const agendaMd = agendaFs.read('agenda.md') ?? ''
    const due = selectDue(parseAgenda(agendaMd), today)
    if (due.length === 0) { deps.log('SCHED', 'push tick — no due intentions'); return }
    // Fire the single oldest-due item this tick; the rest wait for later ticks.
    const item = [...due].sort((a, b) => (a.due! < b.due! ? -1 : a.due! > b.due! ? 1 : 0))[0]!

    const snapshot = deps.ilink.loadProjects()
    const currentAlias = snapshot.current && snapshot.projects[snapshot.current] ? snapshot.current : null
    const proj = currentAlias
      ? { alias: currentAlias, path: snapshot.projects[currentAlias]!.path }
      : { alias: '_default', path: launchCwd }
    const tier = resolveEffectiveTier(chatId, deps.loadAccess(), deps.permissionMode)
    if (tier !== 'admin') {
      deps.log('COMPANION', `default_chat_id=${chatId} is non-admin tier (${tier}); push tick will run with reduced capabilities`)
    }
    const tierProfile = TIER_PROFILES[tier]
    if (deps.boot.sessionManager.isInFlight({ alias: proj.alias, providerId: deps.boot.defaultProviderId, chatId })) {
      deps.log('SCHED', `[companion] skipping push tick: user session in-flight (alias=${proj.alias} provider=${deps.boot.defaultProviderId} chat=${chatId})`)
      return // leave the item pending — retry next tick
    }
    const handle = await deps.boot.sessionManager.acquire({
      alias: proj.alias,
      path: proj.path,
      providerId: deps.boot.defaultProviderId,
      chatId,
      tierProfile,
      permissionMode: deps.permissionMode,
    })
    const tickText = buildPushTickText({ nowIso, defaultChatId: chatId, intention: item.body })
    try {
      for await (const _ev of handle.dispatch(tickText)) { /* drain */ }
    } catch (err) {
      deps.log('SCHED', `companion tick dispatch failed: ${errMsg(err)}`)
      return // dispatch failed — leave pending, retry next tick
    }
    // Resolve so the item fires at most once. Re-read first: the agent may have
    // edited agenda.md during dispatch (added new intentions) — markResolved
    // matches the original line and preserves any additions.
    const freshMd = agendaFs.read('agenda.md') ?? agendaMd
    const updated = markResolved(freshMd, item, today)
    if (updated !== freshMd) agendaFs.write('agenda.md', updated)
  }
```

- [ ] **Step 3: Typecheck**

Run: `bun x tsc --noEmit`
Expected: clean (the Task 2 leftover error is now resolved by the new `buildPushTickText` call passing `intention`).

- [ ] **Step 4: Run the daemon/companion unit + eval-engine suites for regressions**

Run: `bun --bun vitest run -c vitest.eval-engine.config.ts src/daemon/ eval/companion/engine/`
Expected: PASS. (If any existing test asserted the old "every tick dispatches" behavior, update it to the gated behavior — a tick with no `agenda.md` now returns before acquiring a session. Note any such change in the commit.)

- [ ] **Step 5: Commit**

```bash
git add src/daemon/wiring/tick-bodies.ts
git commit -m "feat(companion): push tick fires due agenda intentions (gated, no-LLM when nothing due)"
```

---

## Task 4: Authoring nudges in `prompt-builder.ts`

**Files:**
- Modify: `src/core/prompt-builder.ts` (conversation "行为节奏" block ~line 158; `companionSection()` ~line 195)

- [ ] **Step 1: Add the conversation-time authoring nudge**

In `src/core/prompt-builder.ts`, find the `**回复后**：...` bullet in the "行为节奏" block and add a new bullet immediately after it:

Find:
```
**回复后**：值得记的就写。一句话也行。**优先 edit-in-place** 现有文件，不要堆新文件。
```

Add directly after it (new line):
```
**未来跟进**：用户提到有未来时间点的事（面试、截止、复诊、约定），在 \`agenda.md\` 记一条 \`- [ ] due:YYYY-MM-DD <要跟进什么>\`。到点时系统会专门唤醒你来兑现——这是你之后主动关心的依据，不是 todo 系统的催促。
```

- [ ] **Step 2: Rewrite `companionSection()`**

Replace the entire `companionSection` function with:

```typescript
function companionSection(): string {
  return `## Companion 主动推送（已开启）

- 你不靠定时硬想"要不要找他"。你在聊天里把值得跟进的事记进 \`agenda.md\`（\`- [ ] due:YYYY-MM-DD <跟进什么>\`）。到点时系统会专门唤醒你、把那条跟进交给你兑现——**默认就是发**：调 reply 写一句简短自然的问候；只有明显已过期、或用户已自己说过结果才不发（直接结束，不产生 assistant text）。
- 推送后：写 memory 记这次 push 的意图和后续观察 — 用户是否回复、情绪如何。下次会读到。
- 反感信号：用户说"别烦我"/"停" → 调 \`companion_snooze({minutes: 60})\`。明示要关 → 调 \`companion_disable()\`。`
}
```

- [ ] **Step 3: Typecheck + run prompt-builder tests if present**

Run: `bun x tsc --noEmit`
Expected: clean.

Run: `ls src/core/prompt-builder.test.ts 2>/dev/null && bun --bun vitest run src/core/prompt-builder.test.ts || echo "no prompt-builder test"`
Expected: if the test exists, PASS — update any snapshot/substring assertion that pinned the old companionSection text ("不确定就选不打扰" / "每 15-30 分钟") to the new wording. If no test, skip.

- [ ] **Step 4: Commit**

```bash
git add src/core/prompt-builder.ts
git commit -m "feat(companion): prompt nudges to author dated follow-ups into agenda.md"
```

---

## Task 5: Eval — `long_silence_initiative_v1` seeds `agenda.md`

**Files:**
- Modify: `eval/companion/trajectories/long_silence_initiative_v1.yaml`

- [ ] **Step 1: Replace the `initial_memory_files` seed**

In `eval/companion/trajectories/long_silence_initiative_v1.yaml`, replace the current `initial_memory_files:` block (the `threads.md` seed) with an `agenda.md` seed whose due date precedes the day-8 push:

```yaml
    initial_memory_files:
      agenda.md: |
        # agenda
        - [ ] due:2026-05-15 面试后轻轻问结果/感受；别催、别灌鸡汤
```

- [ ] **Step 2: Update the trajectory `description`**

Replace the `description:` block with one that reflects the agenda-fire model (no placeholders — paste verbatim):

```yaml
  description: |
    Tests the push tick firing a due, self-authored intention. The open thread
    (an interview follow-up) is seeded into agenda.md with a due date that
    precedes the day-8 push tick. Per the proactivity v1 design, the push tick
    parses agenda.md, finds the due item, and fires it (default = act). Expected:
    the day-8 push references the interview and asks a light check-in.

    History: pre-agenda this trajectory seeded nothing actionable, so the push
    tick (a cold "should I?" poll) stayed silent — see the eval README. The
    agenda model makes the firing deterministic.
```

- [ ] **Step 3: Smoke-load**

Run: `bun -e "import { loadTrajectory } from './eval/companion/engine/trajectory'; const t = loadTrajectory('./eval/companion/trajectories/long_silence_initiative_v1.yaml'); console.log('ok', Object.keys(t.contacts[0].initial_memory_files))"`
Expected: prints `ok [ "agenda.md" ]`.

- [ ] **Step 4: Commit**

```bash
git add eval/companion/trajectories/long_silence_initiative_v1.yaml
git commit -m "test(eval): long_silence seeds agenda.md to test the intention-fire path"
```

---

## Task 6: Acceptance run + docs reconciliation

**Files:**
- Modify: `eval/companion/README.md` (Known-findings section: long_silence now green via agenda)

- [ ] **Step 1: Manual acceptance run (real SDK, ~3-5 min)**

Run: `bun run eval:companion --trajectory long_silence_initiative_v1`
Open the latest `eval/companion/runs/<ts>/report.md`. Expected — Probe 3 (`proactive_decision`):
- `✅ decision (expected=send actual=send)`
- `✅ must_recall:面试`
- `✅ must_not_recall:*`

If the push tick still stays silent, STOP and diagnose (read the run jsonl for the snapshot's `memory.files` to confirm `agenda.md` was seeded at `memory/chat_silence_1/agenda.md`, and confirm `today` ≥ `2026-05-15`). Do not tune the assertion to hide a real miss.

- [ ] **Step 2: Regression — confirm the other push-tick trajectories still pass**

Run: `bun run eval:companion --trajectory explicit_quiet_v1` then `--trajectory wrong_inference_correction_v1`
Expected: both still pass their proactive probes — they seed **no** `agenda.md`, so the gated push tick returns silent (explicit_quiet expects `silent` + `outbox_count_at_chat eq 1`; wrong_inference's proactive is `decision: n/a` + `must_not_recall`). The gating change must not regress them.

- [ ] **Step 3: Update the eval README finding**

In `eval/companion/README.md`, in the "Acceptance run" section, update the `long_silence_initiative` bullet from a CONFIRMED red finding to: resolved by the proactivity v1 agenda model (push tick fires due intentions); link the spec `docs/superpowers/specs/2026-05-28-companion-proactive-intentions-design.md`.

- [ ] **Step 4: Commit**

```bash
git add eval/companion/README.md
git commit -m "docs(eval): long_silence resolved by companion proactivity v1 (agenda fire)"
```

---

## Self-review notes

- **Spec coverage:** §2 model → Tasks 3 (fire) + 4 (author). §3 agenda format → Task 1 (parser regexes) + Task 5 (seed). §4.1 agenda.ts → Task 1. §4.2 pushTick rewrite → Task 3. §4.3 buildPushTickText → Task 2. §4.4 authoring nudges → Task 4. §4.5 eval → Tasks 5-6. §6 edges (no agenda → silent; malformed skipped; write-race re-read; multiple due → oldest) → Task 3 body + Task 1 parser. §7 deferred items are not implemented (correct).
- **Deviation:** §3/§4.2 `fired`/`dropped` → v1 single `done` state (flagged in header; parser still reads fired/dropped). Functional requirement (fire-once) preserved.
- **Type consistency:** `AgendaItem{raw,status,due,body}`, `parseAgenda`/`selectDue`/`markResolved(md,item,date)` defined in Task 1 and used identically in Task 3. `BuildPushTickTextOpts.intention` added in Task 2, supplied in Task 3.
- **No placeholders:** every code/edit step shows full content; commands have expected output.
