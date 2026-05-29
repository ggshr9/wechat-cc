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

## Known divergences (acceptance run 2026-05-29)

First full real-SDK run of the 6 new trajectories. Engine assertions passed for
cross_domain_mixing and explicit_quiet (clean), and cross_chat_isolation's
isolation guarantee held (chat_a reply leaked nothing from chat_b). Two genuine
behavior findings are left as open questions rather than papered over by tuning:

- **`long_silence_initiative` — companion declined to push.** After 8 days of
  silence with an open thread (面试), the push tick chose `silent` (expected
  `send` + recall "面试"). This is plausibly *correct* restraint-biased behavior
  ("装翅膀不建笼子"), not a bug — but it means a proactive check-in on a stale
  open thread is not reliably emitted. Decide whether the push tick *should*
  resurface open threads before re-tuning this trajectory's expectation.

- **`fact_update_supersede` — empty reply to a factual recall question.** The
  `memory_recall` probe asked "我们现在用什么数据库？" and the companion replied
  with nothing (decision captured as silent). Either companion-persona doesn't
  do direct factual Q&A (a probe-design tension — `memory_recall` assumes it
  will answer) or it's a real gap. Needs investigation before this mode is
  considered covered.

- **Judge dimension scores did not run.** The claude-sdk judge backend errored
  on every probe (`Claude Code native binary not found … claude-agent-sdk-linux-x64-musl/claude`)
  — it does not pass `pathToClaudeCodeExecutable`. The *companion's* SDK works
  (replies were produced); only the judge half failed. Fixing the judge backend
  is Sub-project B work.
