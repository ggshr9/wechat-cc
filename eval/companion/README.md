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

- Remaining 6 failure modes (cross_domain_mixing, fact_update_supersede, wrong_inference_correction, explicit_quiet, long_silence_initiative, cross_chat_isolation)
- Multi-seed judge averaging, pairwise blind comparison
- CI integration — explicit manual run only
- Codex / Anthropic-API judge backends (interfaces exist; bodies throw)

See the spec for the rationale on each.
