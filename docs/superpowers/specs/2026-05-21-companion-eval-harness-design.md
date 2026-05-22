# Companion Eval Harness — Design

**Date**: 2026-05-21
**Supersedes**: `docs/spike/2026-05-09-companion-eval-harness.md` (kept as historical context)
**Status**: Design approved; implementation pending (writing-plans next)
**Why this design rev**: the 2026-05-09 spike predates v2 companion scheduler (no per-trigger registration, no isolated eval sessions) and the observations-to-SQLite migration (PR7). This doc reconciles the spike with current code and resolves the spike's 5 open questions.

## Goal

Durable regression-test infrastructure for the companion (specs 2026-04-22 + 2026-04-24 + 2026-04-29). When the companion prompt is tweaked, the runtime model is upgraded, or a new provider is registered, this harness re-runs scripted multi-day user trajectories against a real daemon + real SDK subprocesses, then emits a markdown report showing what changed.

**Non-goal**: comparing alternative architectures (SQLite/Honcho/typed schemas — already withdrawn as transient harness in `project_companion_design_direction.md`).

## Why durable

Eval scaffolding is verification, not runtime constraint. It doesn't bind Claude's behavior, so it survives stronger models. What ages: trajectory contents (failure modes shift). What doesn't age: schema, replay engine, judge interface, reporter.

## Five decisions (settled in brainstorming)

| Decision | Choice |
|---|---|
| SDK mode | **Do not mock SDK.** Real `claude-code` / `codex` subprocesses, real model calls, real tool use. Mocked SDK would be testing the mock. |
| Virtual time | **Skip scheduler; manually drive tick body with injected envelope `ts`.** `observations`/`memory` internal timestamps stay wall-clock — judge doesn't see them. |
| MVP scope | **Engine + 2 trajectories + judge, manual run.** Remaining 6 trajectories ship as follow-up. |
| Judge model | **Pluggable interface, MVP ships one Claude SDK backend.** Future: Codex / Gemini / raw API. |
| Repo layout | **Top-level `eval/companion/`.** Not under `src/**` (vitest default scan), not under `docs/**` (those are textual artefacts). |

## Architecture

```
eval/companion/
├── engine/
│   ├── trajectory.ts         # zod schema + YAML loader
│   ├── replay.ts             # main driver: walks events, fires probes
│   ├── clock.ts              # virtual-clock helpers (parse `at`, format envelope ts)
│   ├── daemon-shim.ts        # wraps bootDaemon — fake-ilink + fake-media, NO fake-sdk
│   ├── snapshot.ts           # serialize observations + memory fs + outbox after each event
│   ├── judge.ts              # Judge interface + claude-sdk backend (MVP), stubs for others
│   ├── judge-prompts.ts      # per-dimension rubric prompts
│   └── reporter.ts           # markdown report + jsonl raw dumps
├── trajectories/
│   ├── tech_stress_followup_v1.yaml
│   └── emotional_care_v1.yaml
├── runs/                     # gitignored; each run writes <timestamp>/
├── judge-config.json         # { kind: "claude-sdk", model: "opus-4-7" }
├── run.ts                    # CLI: `bun run eval:companion [--trajectory id]`
└── README.md
```

### Reuse map (what we lift from existing infra)

| Existing piece | Reuse as |
|---|---|
| `src/daemon/__e2e__/fake-ilink-server.ts` | Outbox capture for `reply` family; no real WeChat hit |
| `src/daemon/__e2e__/fake-media.ts` | Image attachments materialize to local stub files |
| `src/daemon/__e2e__/harness.ts` `startTestDaemon` plumbing | Pattern for stateDir + access.json + companion-config seeding |
| `bootDaemon` (src/daemon/main.ts) | Direct call, same path as e2e |
| `src/daemon/observations/store.ts` `appendRaw` | Seed `initial_observations` directly into SQLite |
| Internal-api bridge | NOT needed — real SDK + real MCP child handles `reply` POST organically once SDK isn't mocked |

### Daemon-side seams required

Three minimal additions to production code:

1. **Scheduler-interval override** — `src/daemon/companion/lifecycle.ts` currently hard-codes `PUSH_INTERVAL_MS` / `INTROSPECT_INTERVAL_MS`. Thread an optional override through `bootDaemon → wiring → lifecycle` so eval can pass `SAFE_INFINITY` (e.g. `2 ** 31 - 1`) and the v2 scheduler never auto-fires. Default behavior unchanged.
2. **`DaemonHandle.fireTick(kind: 'push' | 'introspect', at: Date): Promise<void>`** — exported test seam. Internally constructs the envelope text with `at` baked into the `ts` attribute, then dispatches into the live session like the normal scheduler would.
3. **Extract `buildTickText({ kind, now, defaultChatId })` as a pure function** — currently inlined in `src/daemon/wiring/tick-bodies.ts:62-67`. Pure helper makes `fireTick` trivial and gives prompt-builder tests a reuse point.

These are not changes for eval's sake — they are minor refactor (already inline-able) + one new method. Production behavior unchanged.

## Trajectory schema (corrected from spike)

```yaml
trajectory:
  id: string                            # stable, regression-diff key
  failure_mode: enum                    # see Failure modes table below
  description: string
  
  contact:
    chat_id: string                     # e.g. "chat_test_1"
    user_name: string
    persona: assistant | companion
    profile_md: string                  # memory/<chat>/profile.md
    preferences_md: string              # memory/<chat>/preferences.md (added vs spike)
    initial_observations: []            # seeded via observations.appendRaw
    initial_memory_files: {}            # optional: { "notes/foo.md": "content" }
  
  companion_config:
    enabled: true
    default_chat_id: string
    quiet_hours_local: string | null
  
  events:
    - at: ISO 8601 with timezone
      kind: user_message | tick | probe
      
      # user_message:
      text: string
      
      # tick (replaces spike's cron_tick):
      tick_kind: push | introspect
      
      # probe:
      probe_kind: reactive_response | proactive_decision | memory_recall | state_inspect
      ask: string                       # only for memory_recall / state_inspect
      expected:
        decision: send | silent | n/a   # objective, engine asserts
        summary: string                 # human-readable expectation
        must_recall: []                 # objective substring assertions (case-insensitive)
        must_not_recall: []             # objective substring assertions
        tone_hints: []                  # subjective, fed to judge
        state_predicates: []            # objective; tagged-union shape; see below
      dimensions: []                    # subset of [recall, inference, calibration, initiative, restraint]
```

**`state_predicates` shape** (tagged union; plan picks parser):
```yaml
- { kind: observation_body_matches, pattern: "504" }       # case-insensitive substring
- { kind: memory_file_exists, path: "notes/migration.md" }
- { kind: memory_file_matches, path: "profile.md", pattern: "顾时瑞" }
- { kind: outbox_count_at_chat, eq: 0 }                    # asserts silence streak
```

**Changes from spike**:
- ❌ Removed `cron_triggers[]` — v2 scheduler has no per-trigger registration; there are only `push` and `introspect` ticks.
- 🔀 Renamed `cron_tick` → `tick` with `tick_kind`.
- ➕ Added `preferences_md` and `initial_memory_files` (prompt-builder.ts:128 documents the three-file convention).
- ➕ Added `state_predicates` to `expected` — replaces spike's `observation_quality` probe kind with declarative assertions inside the existing `expected` block.
- 🔀 `expected` split into objective (engine asserts) and subjective (judge scores) fields.

### Failure modes (8 total, unchanged from spike)

| ID | Tests |
|---|---|
| work_followup | AI follows up on previously-mentioned work item across sessions |
| emotional_care | AI notices emotion, responds with warmth, doesn't prescribe |
| cross_domain_mixing | Work + life in same session — no awkward mode-switching |
| fact_update_supersede | Earlier-stated fact later changes; AI shouldn't insist on stale |
| wrong_inference_correction | AI deduces wrongly; user corrects; later regression check |
| explicit_quiet | User says "leave me alone"; AI must respect |
| long_silence_initiative | User quiet N days; should AI ping or wait? |
| multi_persona_isolation | Same user → two personas; memories must not leak |

MVP ships `work_followup` (tech_stress_followup_v1) and `emotional_care` (emotional_care_v1).

## Replay engine algorithm

```text
function replay(trajectoryFile):
  trajectory = loadAndValidate(trajectoryFile)
  
  daemon = startTestDaemonForEval({
    companion: trajectory.companion_config,
    knownUsers: { [trajectory.contact.chat_id]: trajectory.contact.user_name },
    schedulerIntervalMs: SAFE_INFINITY,         # scheduler never auto-fires
    # NO claudeScript / codexScript — real SDK
  })
  
  seedMemory(daemon.stateDir, trajectory.contact)
  seedObservations(daemon.db, trajectory.contact.initial_observations)
  
  results = []
  lastUserMessageReply = null
  lastTickOutcome = null
  
  for event in trajectory.events:
    switch event.kind:
      case user_message:
        daemon.sendText(chat_id, text, { createTimeMs: parseISO(event.at) })
        lastUserMessageReply = await daemon.waitForReplyTo(chat_id, timeoutMs=120s)
                                     .catch(err => ({ error: err.message }))
      
      case tick:
        outboxBefore = daemon.ilink.outboxSnapshot()
        await daemon.fireTick(event.tick_kind, parseISO(event.at))
        outboxAfter = daemon.ilink.outboxSnapshot()
        lastTickOutcome = diff(outboxBefore, outboxAfter, chat_id)
                          # { decision: 'send' | 'silent', text?: string }
      
      case probe:
        actual = capture(event.probe_kind, daemon, event.ask,
                         lastUserMessageReply, lastTickOutcome)
        snapshot = serializeState(daemon)
        assertions = runObjectiveAssertions(event.expected, actual, snapshot)
        judgeScores = event.dimensions.length > 0
                    ? await judge.score({ trajectoryHistoryToProbe, expected, actual })
                    : []
        results.push({ event, actual, snapshot, assertions, judgeScores })
  
  await daemon.stop()
  return results
```

### Probe semantics

| probe_kind | What `actual` is | Engine action |
|---|---|---|
| reactive_response | `lastUserMessageReply` (text or error) | None — captures previous event's reply |
| proactive_decision | `lastTickOutcome` (send-with-text / silent) | None — captures previous tick's outcome |
| memory_recall | Reply text from a one-shot user_message dispatch | Engine sends `event.ask` as `daemon.sendText(chat_id, ask, { createTimeMs: parseISO(event.at) })`, waits for reply |
| state_inspect | The snapshot itself | Engine doesn't drive anything; just reads SQLite + memory fs |

### Objective vs subjective split

**Engine asserts (boolean pass/fail)**:
- `expected.decision` matches outbox delta
- Every `must_recall` substring is in `actual.text` (case-insensitive)
- No `must_not_recall` substring is in `actual.text`
- Every `state_predicate` evaluates true against snapshot

**Judge scores (1–5 per dimension)**:
- `tone_hints`, `summary`, and qualitative aspects of `must_recall` correctness
- Only dimensions listed in `event.dimensions`
- Skipped entirely if `dimensions` is empty

**Failures don't halt**: an objective assertion failure or judge error is recorded; replay continues. One full pass per run.

### State snapshot

After each event the engine captures:
- `observations.active[]` and `observations.archived[]` (via `makeObservationsStore` `listActive` / `listArchived`)
- All `*.md` files under `<stateDir>/memory/<chat_id>/`
- All outbound to `chat_id` since trajectory start (`ilink.outboxSnapshot()` filtered)

Snapshots are written to `runs/<ts>/trajectory.<id>.jsonl` (one line per event).

## Judge

```ts
export interface JudgeProbeInput {
  trajectoryHistoryToProbe: string   // pre-rendered text history up to and including the probe
  expected: TrajectoryProbe['expected']
  actual: ProbeActual                // reply text / silence / error / state snapshot
}

export interface JudgeScore {
  dimension: 'recall' | 'inference' | 'calibration' | 'initiative' | 'restraint'
  score: 1 | 2 | 3 | 4 | 5
  rationale: string                  // one line per dimension
}

export interface Judge {
  name: string                       // e.g. "claude-opus-4-7"
  score(input: JudgeProbeInput): Promise<JudgeScore[]>
}

export function makeClaudeSdkJudge(opts: { model?: string }): Judge       // MVP
export function makeCodexSdkJudge(opts: { model?: string }): Judge        // stub + TODO
export function makeAnthropicApiJudge(opts: { apiKey: string; model?: string }): Judge  // stub + TODO
```

**Selection** via `eval/companion/judge-config.json`:
```json
{ "kind": "claude-sdk", "model": "opus-4-7" }
```

**MVP shape**: one Claude SDK backend, 1 seed (no averaging), no pairwise blind. Future revs add seed averaging and pairwise blind when comparing prompt variants.

**Per-dimension rubric** in `judge-prompts.ts`, sourced verbatim from spike's spec §LLM-as-Judge rubric (recall / inference / calibration / initiative / restraint).

## Reporter

Markdown per run, structured for diff:

```markdown
# Companion eval run · 2026-05-21T10:00:00+08:00
**Judge**: claude-opus-4-7  **Trajectories**: 2  **Wall time**: 4m32s  **Errors**: 0

## tech_stress_followup_v1 (work_followup) — 4 probes

### Probe 2 · proactive_decision @ 2026-05-13T09:30:30+08:00
- **Trigger**: tick `push` at 09:30:00
- **Expected**: decision=send · summary="可以问一下 migration 之后..."
- **Actual**: decision=send · text="昨天 504 那波睡好没？今天 CI 还稳吗"
- **Engine assertions**: ✅ decision=send · ✅ must_recall: 504, migration
- **Judge** (claude-opus-4-7):
  - calibration: 4 — 简短，承认辛苦，没追问技术细节
  - initiative: 5 — 时机和措辞都对
  - recall: 5 — 504 / migration 都点到
  - restraint: 4 — 还可以再含蓄一点

## Summary
- 2 trajectories · 11 probes · 0 errors
- Average dimension scores: calibration 3.8 · initiative 4.2 · recall 4.6 · ...
- Raw outputs: `runs/2026-05-21-1000/`
```

Each run also writes:
- `runs/<ts>/trajectory.<id>.jsonl` — one line per event, full snapshot + actual
- `runs/<ts>/judge-calls.jsonl` — every judge call's input + output (debugging judge bias)
- `runs/<ts>/report.md` — the markdown above

`eval/companion/runs/` is added to `.gitignore`. Permanent record lives in the trajectory YAML + the rerun — runs are reproducible (modulo model non-determinism), not artefacts.

## Acceptance criteria

MVP is done when:
- [ ] `bun run eval:companion --trajectory tech_stress_followup_v1` boots a daemon, drives events, captures outputs, writes `runs/<ts>/report.md` without crashing
- [ ] Same command for `emotional_care_v1`
- [ ] Engine is **deterministic given identical model outputs** — i.e. snapshot/assert/judge logic itself doesn't introduce noise. Model-level non-determinism is acceptable and visible in repeated runs.
- [ ] Repeated runs (no code change) show **judge dimension scores within ±2** for the same probe — establishes the noise floor that future regressions need to clear.
- [ ] Both trajectories have at least one `proactive_decision` probe and one `reactive_response` probe filled in with realistic `expected` blocks
- [ ] README documents: how to add a trajectory, what judge config means, how to interpret a report, expected wall-clock cost per trajectory

Not in MVP (follow-up PRs):
- Remaining 6 trajectories
- Multi-seed averaging, pairwise blind
- CI integration (eval is expensive — explicit manual run)
- Codex / Gemini / API judge backends (interface present; backends are stubs with `throw new Error('not implemented')`)

## Risk register

| Risk | Mitigation |
|---|---|
| Real SDK cold-start is 30-60s × N dispatches × M probes → trajectory takes minutes | Acceptable for manual run; document expected wall time in README |
| Judge bias toward Claude family | Document; ship interface so user can swap; explicit caveat in report header |
| Model non-determinism makes regression detection noisy | MVP says ±2 dimension swing acceptable; if too noisy in practice, add seed averaging |
| Eval pollutes user's `~/.claude` config | `bootDaemon` already honors `WECHAT_CC_STATE_DIR`; daemon-shim sets it. Same isolation pattern as e2e harness. |
| SDK subprocess hangs and trajectory stalls forever | 120s per-dispatch timeout; on timeout record `actual: { error: 'timeout' }`, continue trajectory |

## Implementation order (for writing-plans)

Suggested layering — each step verifiable independently:

1. **Daemon seams** — `bootDaemon` `schedulerIntervalMs` param + `DaemonHandle.fireTick` + pure `buildTickText`. Production code, normal tests.
2. **Trajectory schema + loader** — zod + js-yaml. Pure; testable.
3. **Daemon-shim** — wraps `startTestDaemon` minus fake-sdk. Smoke-test: boot + stop.
4. **Replay engine bones** — drive `user_message` events, capture replies; no probes yet. Smoke-test against a one-event trajectory.
5. **Snapshot** — read SQLite observations + memory fs + outbox.
6. **Probes + objective assertions** — wire `reactive_response` and `proactive_decision`.
7. **Judge interface + Claude SDK backend** — call SDK with rubric prompt, parse JSON scores.
8. **Reporter** — render markdown + jsonl.
9. **Two trajectory YAMLs** — content writing, no code.
10. **CLI entry + README.**

Steps 1, 2, 3, 7 land independently; steps 4–6 build on 1–3; step 8 builds on 6+7; steps 9–10 are last.
