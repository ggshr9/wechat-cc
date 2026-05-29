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

**One genuine open finding (left red, not papered over):**

- **`long_silence_initiative` — companion declined to push.** After 8 days of
  silence with an open thread (面试), the push tick chose `silent` (expected
  `send` + recall "面试"). The tick path has **no** capture race (`fireTick`
  fully awaits the dispatch), so this is real: either the open thread wasn't
  persisted to memory for the tick to resurface, or the push logic is
  restraint-biased ("装翅膀不建笼子"). Decide whether the push tick *should*
  resurface open threads before re-tuning this trajectory's expectation.

**Judge dimension scores did not run.** The claude-sdk judge backend errored on
every probe (`Claude Code native binary not found … claude-agent-sdk-linux-x64-musl/claude`)
— it does not pass `pathToClaudeCodeExecutable`. The *companion's* SDK works
(replies were produced); only the judge half failed. Fixing the judge backend is
Sub-project B work.
