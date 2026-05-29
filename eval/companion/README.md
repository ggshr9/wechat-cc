# Companion Eval Harness

Regression-test infrastructure for the companion (`docs/superpowers/specs/2026-05-21-companion-eval-harness-design.md`). Re-run scripted multi-day user trajectories against a real daemon + real SDK subprocesses; get a markdown report.

## Run

```bash
bun run eval:companion                                          # all trajectories
bun run eval:companion --trajectory tech_stress_followup_v1     # one
```

Output: `eval/companion/runs/<timestamp>/report.md` plus per-trajectory `.jsonl` raw dumps.

## Expected cost

Each trajectory boots a real daemon and dispatches real Claude SDK calls. Rough wall time on a warm laptop: **~30–60s per event** (SDK cold-start dominates). The two MVP trajectories together are ~4–8 minutes plus judge calls (one judge call per probe-with-dimensions). Don't run on every commit.

## Add a trajectory

1. Pick a `failure_mode` from `engine/trajectory.ts` `FAILURE_MODES`.
2. Copy an existing YAML in `trajectories/` and edit.
3. Each probe needs an `expected` block. Split is:
   - **Engine asserts** (boolean): `decision`, `must_recall`, `must_not_recall`, `state_predicates`.
   - **Judge scores** (1–5): `summary`, `tone_hints`, and any `dimensions: [...]` you list.
4. Smoke-load: `bun -e "import { loadTrajectory } from './eval/companion/engine/trajectory'; loadTrajectory('./eval/companion/trajectories/<file>.yaml')"`
5. Run: `bun run eval:companion --trajectory <id>`
6. **Multi-contact trajectories** (e.g. `cross_chat_isolation`): use `contacts:` (a list of contacts) instead of `contact:`. The first contact is the primary. Tag each `user_message` / `tick` / `probe` event with `chat: <chat_id>` to target a specific contact; events without `chat:` target the primary. Exactly one of `contact:` / `contacts:` must be present. Note: `tick` events always fire against `companion_config.default_chat_id` — a `chat:` on a tick is not honored.

## Judge config

`judge-config.json` selects the judge backend:

```json
{ "kind": "claude-sdk", "model": "claude-opus-4-7" }
```

Backends: `claude-sdk` (MVP), `codex-sdk` (stub), `anthropic-api` (stub). Adding a new backend = implement `Judge` in a new file and register the `kind` in `run.ts`'s `loadJudge`.

## Interpreting a report

- ✅ / ❌ next to engine assertions are objective pass/fail. Investigate any ❌.
- Judge dimension scores (1–5) are subjective. Use them for **trend** detection, not absolute correctness. Repeated runs of the same trajectory should land within ±2 on each dimension; wider swings = either model non-determinism (noise) or a real change worth investigating.
- "Errors" in the header = trajectories where a probe captured an exception (timeout, judge JSON parse fail). One error doesn't fail the run — replay continues — but they should be near zero on a healthy day.

## What's NOT in MVP

- (All 8 failure modes now have at least one trajectory.)
- Multi-seed judge averaging, pairwise blind comparison
- CI integration — explicit manual run only
- Codex / Anthropic-API judge backends (interfaces exist; bodies throw)

See the spec for the rationale on each.

## Acceptance run 2026-05-29 — results + one harness bug found

First full real-SDK run of the 6 new trajectories. Engine assertions pass for
cross_domain_mixing, explicit_quiet, wrong_inference_correction,
fact_update_supersede, and cross_chat_isolation (whose isolation guarantee held —
the chat_a deploy reply leaked nothing from chat_b's private fact).

**Harness bug found and fixed (commit ad829ad).** The first run showed empty
replies on the *2nd+ message to a chat* (fact_update recall, wrong_inference
Probe 2). Root cause: `waitForReplyTo` waited on `outbox.some(chat)` over the
cumulative outbox, so a later message resolved instantly off the *prior* reply —
the harness raced ahead, captured nothing, and could tear the daemon down before
the message was dispatched. The two MVP trajectories never caught it (one message
per chat). Fixed via `waitForNewReply` (waits for the chat's reply count to grow);
regression test in `daemon-shim.test.ts`. Re-run confirms the companion answers
correctly — fact_update: "mysql，今天从 postgres 迁过来的。"; wrong_inference:
"那挺好。在搞什么？" (accepts the correction, no pity).

`fact_update`'s `must_not_recall:postgres` was dropped afterward: a substring
check can't distinguish "postgres is current" (the failure) from "migrated from
postgres" (correct context) — `must_recall:mysql` + the `calibration` judge
dimension carry that intent instead.

**One CONFIRMED companion finding (left red — a real behavior gap, not a harness
artifact):**

- **`long_silence_initiative` — push tick does not resurface a persisted open
  thread.** First investigation (2026-05-29) showed the original trajectory
  persisted *nothing* about the interview, so the push tick correctly stayed
  silent — a trajectory-design gap. Fixed by seeding the open thread into a
  memory file (`threads.md`), which the push-tick prompt explicitly reads
  (`memory_list` + `memory_read`). On re-run the push tick **still stayed
  silent**, and the opus judge independently scored `initiative: 1` / `recall: 1`
  ("the right moment for a gentle check-in; staying silent misses the proactive
  touch"). The tick path has no capture race (`fireTick` fully awaits dispatch),
  so this is a real companion behavior: the push tick's prompt biases hard toward
  silence (*"不确定就选不 push"*) and doesn't reliably resurface persisted open
  threads. **This is a companion-behavior / product question** — how proactive
  should the push tick be? — and changing it modifies the daemon, which is out of
  scope for the eval harness (the harness observes; it doesn't change the daemon).
  The trajectory is left red on purpose: it's a regression marker that goes green
  when/if the push tick is made to resurface open threads.

**Judge dimension scores — fixed (commit 78ccc85).** The first run's judge errored
on every probe (`Claude Code native binary not found … claude-agent-sdk-linux-x64-musl/claude`)
because it passed no `pathToClaudeCodeExecutable` and the SDK mis-detects the musl
native binary under bun on glibc. `run.ts` now resolves the binary (env
`CLAUDE_CODE_EXECUTABLE` → PATH, with an optional `pathToClaudeCodeExecutable`
override in `judge-config.json`) and threads it through. Verified: dimension
scores now produce (e.g. cross_domain_mixing → calibration 5.0 / restraint 5.0).
