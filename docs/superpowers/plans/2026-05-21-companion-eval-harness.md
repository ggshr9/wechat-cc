# Companion Eval Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a manual-run regression-test harness that drives the companion through scripted multi-day user trajectories against a real daemon + real SDK subprocesses, then emits a markdown report.

**Architecture:** A new top-level `eval/companion/` directory hosts a replay engine, two trajectory YAMLs, an objective-assertion layer, and a pluggable LLM judge. The engine boots a test daemon (reusing existing `__e2e__/` fakes for ilink + media, but NOT for the SDK) and drives `user_message` / `tick` / `probe` events with a virtual clock. Production code gets three minor seams: an extracted `buildTickText` helper, a `schedulerIntervalMs` override, and a `DaemonHandle.fireTick(kind, at)` method.

**Tech Stack:** TypeScript / Bun / vitest (for the harness's own unit tests). Adds `yaml` and `zod` (already a dep). Uses `@anthropic-ai/claude-agent-sdk` for the MVP judge backend, lifting the pattern from `src/daemon/wiring/side-effects.ts`.

**Source of truth for design decisions:** `docs/superpowers/specs/2026-05-21-companion-eval-harness-design.md`. If a step here disagrees with the spec, the spec wins — flag the conflict and ask before resolving.

---

## File Structure

**Production-code edits (Task 1–3):**
- Modify `src/daemon/wiring/tick-bodies.ts` — extract `buildTickText` pure helper; accept optional injected `nowIso`.
- Create `src/daemon/wiring/tick-bodies.test.ts` (already exists — extend, don't replace).
- Modify `src/daemon/companion/lifecycle.ts` — accept `intervalMs` override; default keeps current `PUSH_INTERVAL_MS` / `INTROSPECT_INTERVAL_MS`.
- Modify `src/daemon/wiring/lifecycle-deps.ts` — thread `schedulerIntervalMs?: number` through `buildLifecycleDeps`.
- Modify `src/daemon/wiring/index.ts` — thread `schedulerIntervalMs?: number` through `WireMainOpts`.
- Modify `src/daemon/main.ts` — accept `schedulerIntervalMs?: number` in `BootDaemonOpts`; expose `fireTick` on `DaemonHandle`.

**New eval directory (Task 4–18):**
```
eval/companion/
├── engine/
│   ├── trajectory.ts          # zod schema + YAML loader
│   ├── trajectory.test.ts
│   ├── clock.ts               # ISO ↔ Date helpers; SAFE_INFINITY constant
│   ├── clock.test.ts
│   ├── daemon-shim.ts         # wraps startTestDaemon-style boot, NO fake-sdk
│   ├── snapshot.ts            # serialize observations + memory fs + outbox
│   ├── snapshot.test.ts
│   ├── replay.ts              # main driver — walks events, fires probes
│   ├── probes.ts              # capture handlers per probe_kind
│   ├── assertions.ts          # objective pass/fail evaluator
│   ├── assertions.test.ts
│   ├── judge.ts               # Judge interface + factories
│   ├── judge-claude-sdk.ts    # MVP Claude SDK backend
│   ├── judge-prompts.ts       # per-dimension rubric prompts
│   └── reporter.ts            # markdown + jsonl writer
├── trajectories/
│   ├── tech_stress_followup_v1.yaml
│   └── emotional_care_v1.yaml
├── runs/                      # gitignored
├── judge-config.json
├── run.ts                     # CLI: `bun run eval:companion`
└── README.md
```

**Repo wiring (Task 4):**
- Modify `package.json` — add `"eval:companion": "bun eval/companion/run.ts"` script; add `yaml` to `dependencies`.
- Modify `vitest.config.ts` — add `**/eval/**` to `exclude` so default `bun run test` skips expensive eval tests. The harness's own unit tests are runnable via vitest with explicit path.
- Modify `.gitignore` — add `eval/companion/runs/`.

---

## Task 1: Extract `buildTickText` pure helper

**Files:**
- Modify: `src/daemon/wiring/tick-bodies.ts`
- Modify: `src/daemon/wiring/tick-bodies.test.ts`

The current push tick inlines the envelope text at `tick-bodies.ts:62-67`. Extract it as a pure helper that takes `{ kind, nowIso, defaultChatId }` and returns the text. Also let `pushTick` accept an optional `nowIso` override so eval can drive the body with virtual time.

- [ ] **Step 1: Write failing test for `buildTickText`**

Add to `src/daemon/wiring/tick-bodies.test.ts`, near top (above the existing `describe`):

```ts
import { buildTickText } from './tick-bodies'

describe('buildTickText', () => {
  it('formats a push tick envelope with the supplied nowIso + chatId', () => {
    const out = buildTickText({
      kind: 'push',
      nowIso: '2026-05-13T01:30:00.000Z',
      defaultChatId: 'chat_test_1',
    })
    expect(out).toContain('<companion_tick ts="2026-05-13T01:30:00.000Z" default_chat_id="chat_test_1" />')
    expect(out).toContain('定时唤醒')
    expect(out).toContain('不调用 reply')
    expect(out).toContain('沉默就是沉默')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `bun --bun vitest run src/daemon/wiring/tick-bodies.test.ts -t 'buildTickText'`
Expected: FAIL — `buildTickText` is not exported.

- [ ] **Step 3: Implement `buildTickText` + refactor `pushTick`**

In `src/daemon/wiring/tick-bodies.ts`:

```ts
export interface BuildTickTextOpts {
  kind: 'push'
  nowIso: string
  defaultChatId: string
}

/**
 * Pure helper — assembles the push-tick envelope text. Extracted from
 * pushTick so the eval harness can drive the body with a virtual `ts`
 * without going through the scheduler. Production code path is unchanged.
 */
export function buildTickText(opts: BuildTickTextOpts): string {
  return (
    `<companion_tick ts="${opts.nowIso}" default_chat_id="${opts.defaultChatId}" />\n` +
    `定时唤醒。先 memory_list + memory_read 你觉得相关的文件。` +
    `再看当前时间和用户最近状态。决定是否向 ${opts.defaultChatId} push。` +
    `\n\n要 push：调 reply 工具，内容就是要发给用户的话。` +
    `\n不 push：直接结束这一轮，**不调用 reply**，**也不产生任何 assistant text**——不要解释你为什么不打扰、不要总结你看到的状态。沉默就是沉默。` +
    `\n不确定就选不 push（结束）。push 后写一条 memory 记下决策和意图（便于下次 tick 读到效果）。`
  )
}
```

Then refactor `pushTick`'s tick-text construction (lines 61–67 of the original) to:

```ts
const tickText = buildTickText({
  kind: 'push',
  nowIso: opts?.nowIso ?? new Date().toISOString(),
  defaultChatId: cfg.default_chat_id,
})
```

And change the `TickBodies` interface + `pushTick` signature so it accepts an optional override:

```ts
export interface TickBodies {
  pushTick: (opts?: { nowIso?: string }) => Promise<void>
  introspectTick: (opts?: { nowIso?: string }) => Promise<void>  // introspect ignores nowIso for MVP — keeps signatures symmetric
}
```

In `buildTickBodies`, the wrapper functions become `async function pushTick(opts?: { nowIso?: string })` and `async function introspectTick(opts?: { nowIso?: string })`. `introspectTick` ignores `opts.nowIso` for now (the design says "observations/memory internal timestamps stay wall-clock"). Keeping the symmetric signature avoids a future churn when introspect virtual time is added.

- [ ] **Step 4: Run to verify pass + check existing tests still pass**

Run: `bun --bun vitest run src/daemon/wiring/tick-bodies.test.ts`
Expected: ALL pass, including the original PR-D guard tests.

- [ ] **Step 5: Run full typecheck**

Run: `bun run typecheck`
Expected: no errors. (Lifecycles call `pushTick()` with no args; the optional param keeps that valid.)

- [ ] **Step 6: Commit**

```bash
git add src/daemon/wiring/tick-bodies.ts src/daemon/wiring/tick-bodies.test.ts
git commit -m "refactor(tick-bodies): extract buildTickText + accept virtual nowIso

Pure helper makes the push-tick envelope reusable. pushTick / introspectTick
now accept an optional { nowIso } so the upcoming eval harness can drive
ticks with virtual time without going through the scheduler. Production
behavior unchanged — no callers pass nowIso yet."
```

---

## Task 2: Thread `schedulerIntervalMs` override through wiring

**Files:**
- Modify: `src/daemon/companion/lifecycle.ts`
- Modify: `src/daemon/companion/lifecycle.test.ts`
- Modify: `src/daemon/wiring/lifecycle-deps.ts`
- Modify: `src/daemon/wiring/index.ts`
- Modify: `src/daemon/main.ts`

Eval needs the scheduler to never auto-fire so the engine can drive ticks deterministically. The cleanest seam is an `intervalMs` override at the deepest layer (`registerCompanionPush` / `registerCompanionIntrospect`), threaded up through wiring to `bootDaemon`. Default unchanged.

- [ ] **Step 1: Write failing test — override propagates to scheduler**

Add to `src/daemon/companion/lifecycle.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'

it('honors an intervalMs override (push)', () => {
  const onTick = vi.fn(async () => {})
  // SAFE_INFINITY-style large value so the scheduler never fires within the test.
  const lc = registerCompanionPush({
    shouldRun: () => true,
    log: () => {},
    onTick,
    intervalMs: 2 ** 31 - 1,
  })
  // No assertion on tick count — just verify the call doesn't crash and the
  // scheduler accepts the override. setTimeout with INT32_MAX is well-formed.
  expect(lc.name).toBe('companion-push')
  return lc.stop()
})

it('honors an intervalMs override (introspect)', () => {
  const onTick = vi.fn(async () => {})
  const lc = registerCompanionIntrospect({
    shouldRun: () => true,
    log: () => {},
    onTick,
    intervalMs: 2 ** 31 - 1,
  })
  expect(lc.name).toBe('companion-introspect')
  return lc.stop()
})
```

- [ ] **Step 2: Run to verify failure**

Run: `bun --bun vitest run src/daemon/companion/lifecycle.test.ts -t 'intervalMs override'`
Expected: FAIL — `intervalMs` is not a field on the deps interfaces.

- [ ] **Step 3: Add optional `intervalMs` to companion deps**

In `src/daemon/companion/lifecycle.ts`, extend the interfaces and pass through:

```ts
export interface CompanionPushDeps {
  shouldRun(): boolean
  log: (tag: string, line: string) => void
  onTick(): Promise<void>
  /**
   * Override base interval (ms). Defaults to PUSH_INTERVAL_MS (20 min).
   * Eval harness passes a SAFE_INFINITY-style value to prevent auto-fire
   * so the engine can drive ticks deterministically.
   */
  intervalMs?: number
}

// ... inside registerCompanionPush:
const stop = startCompanionScheduler({
  name: 'push',
  intervalMs: deps.intervalMs ?? PUSH_INTERVAL_MS,
  jitterRatio: JITTER,
  // ...
})
```

Same change for `CompanionIntrospectDeps` + `registerCompanionIntrospect` (default `INTROSPECT_INTERVAL_MS`).

- [ ] **Step 4: Run to verify pass**

Run: `bun --bun vitest run src/daemon/companion/lifecycle.test.ts`
Expected: ALL pass.

- [ ] **Step 5: Wire it through `buildLifecycleDeps`**

In `src/daemon/wiring/lifecycle-deps.ts`, add the option:

```ts
export interface LifecycleDepsOpts {
  stateDir: string
  db: Db
  ilink: IlinkAdapter
  accounts: IlinkAccount[]
  boot: Bootstrap
  dangerously: boolean
  log: (tag: string, line: string, fields?: Record<string, unknown>) => void
  /**
   * Optional override for both push + introspect scheduler intervals.
   * When set, both schedulers use this value instead of their defaults.
   * Eval harness passes 2 ** 31 - 1 to suppress auto-fire.
   */
  schedulerIntervalMs?: number
}
```

In the return object:

```ts
companionPushDeps: {
  shouldRun, log, onTick: ticks.pushTick,
  ...(opts.schedulerIntervalMs !== undefined ? { intervalMs: opts.schedulerIntervalMs } : {}),
},
companionIntrospectDeps: {
  shouldRun, log, onTick: ticks.introspectTick,
  ...(opts.schedulerIntervalMs !== undefined ? { intervalMs: opts.schedulerIntervalMs } : {}),
},
```

(Conditional spread keeps the optional field shape clean; tests of these deps that don't pass `intervalMs` still work.)

- [ ] **Step 6: Wire it through `wireMain`**

In `src/daemon/wiring/index.ts`:

```ts
export interface WireMainOpts {
  stateDir: string
  db: Db
  ilink: IlinkAdapter
  accounts: IlinkAccount[]
  boot: Bootstrap
  dangerously: boolean
  log: (tag: string, line: string, fields?: Record<string, unknown>) => void
  /** Forwarded to buildLifecycleDeps — eval harness override. */
  schedulerIntervalMs?: number
}
```

And pass through to `buildLifecycleDeps(opts, ticks)`:

```ts
const lifecycleDeps = buildLifecycleDeps(opts, ticks)  // opts already carries it
```

(No code change inside `wireMain` body if `opts` is passed through verbatim — verify by reading the call site. If `buildLifecycleDeps` was being called with a destructured subset, expand the call to forward `schedulerIntervalMs`.)

- [ ] **Step 7: Wire it through `bootDaemon`**

In `src/daemon/main.ts`:

```ts
export interface BootDaemonOpts {
  stateDir: string
  dangerously: boolean
  /**
   * Eval-harness override — when set, both companion schedulers use this
   * interval (ms) instead of the production defaults. Pass 2 ** 31 - 1 to
   * suppress auto-fire so the engine drives ticks with fireTick().
   * Production callers (cli `run`, signal handlers) never set this.
   */
  schedulerIntervalMs?: number
}
```

And forward to `wireMain`:

```ts
const wired = wireMain({
  stateDir, db, ilink, accounts, boot, dangerously,
  log: (t, l) => log(t, l),
  ...(opts.schedulerIntervalMs !== undefined ? { schedulerIntervalMs: opts.schedulerIntervalMs } : {}),
})
```

- [ ] **Step 8: Run typecheck + full unit suite**

Run: `bun run typecheck && bun --bun vitest run`
Expected: all pass. The threading is purely additive optional fields; no production callers pass the override yet.

- [ ] **Step 9: Commit**

```bash
git add src/daemon/companion/lifecycle.ts src/daemon/companion/lifecycle.test.ts \
        src/daemon/wiring/lifecycle-deps.ts src/daemon/wiring/index.ts src/daemon/main.ts
git commit -m "feat(daemon): thread schedulerIntervalMs override through bootDaemon

Optional override on BootDaemonOpts plumbs down to registerCompanionPush /
registerCompanionIntrospect via wireMain + buildLifecycleDeps. Production
default unchanged. Eval harness will pass SAFE_INFINITY to suppress
auto-fire and drive ticks deterministically via fireTick."
```

---

## Task 3: Add `DaemonHandle.fireTick(kind, at)`

**Files:**
- Modify: `src/daemon/main.ts`
- Modify: `src/daemon/wiring/index.ts` (export the tickBodies on `WiredDeps`)
- Create: `src/daemon/main.fireTick.test.ts`

The eval engine needs a way to fire a single tick with an injected timestamp. `pushTick` already accepts `{ nowIso }` after Task 1; `fireTick` is the public seam that calls it.

- [ ] **Step 1: Write failing test**

Create `src/daemon/main.fireTick.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// This test uses the e2e harness pattern to boot a real daemon, then verifies
// fireTick('push', at) calls pushTick with the injected nowIso. We avoid full
// e2e plumbing — only assert the seam exists and is wired.

describe('DaemonHandle.fireTick', () => {
  let stateDir: string
  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'firetick-test-'))
    mkdirSync(join(stateDir, 'accounts', 'bot1'), { recursive: true })
    writeFileSync(join(stateDir, 'access.json'), '{"allowFrom":["*"],"admins":["a"]}')
    writeFileSync(join(stateDir, 'accounts', 'bot1', 'account.json'), '{"botId":"bot1","userId":"u1","baseUrl":"http://127.0.0.1:1"}')
    writeFileSync(join(stateDir, 'accounts', 'bot1', 'token'), 'fake')
  })
  afterEach(() => { try { rmSync(stateDir, { recursive: true, force: true }) } catch {} })

  it('is exposed on the returned handle (smoke)', async () => {
    // We can't easily call fireTick end-to-end without the full e2e harness
    // (which Task 7 builds). This smoke test just verifies the method exists
    // and has the right shape after bootDaemon returns.
    const { bootDaemon } = await import('./main')
    process.env.WECHAT_CC_STATE_DIR = stateDir
    const handle = await bootDaemon({ stateDir, dangerously: false, schedulerIntervalMs: 2 ** 31 - 1 })
    try {
      expect(typeof handle.fireTick).toBe('function')
    } finally {
      await handle.shutdown()
      delete process.env.WECHAT_CC_STATE_DIR
    }
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `bun --bun vitest run src/daemon/main.fireTick.test.ts`
Expected: FAIL — `handle.fireTick` is undefined (TypeError) OR the test errors at boot because no `loadAllAccounts` returns accounts. If it errors at boot, see Step 3 — we need to make sure the smoke test boots cleanly. If `loadAllAccounts` fails because `baseUrl` is unreachable, that's fine — boot doesn't call the URL synchronously. The polling lifecycle would, but with `schedulerIntervalMs` it still polls ilink — so we may need to swap to a test that uses `startTestDaemon` instead. **Decision: defer the actual end-to-end fireTick test to Task 7's daemon-shim**, and use a *type-only* assertion here:

Replace the smoke test body with:

```ts
it('the DaemonHandle type exposes fireTick', () => {
  // Type-level assertion — proves the field is on the interface and prevents
  // accidental removal. End-to-end behavior is exercised by the daemon-shim
  // tests in Task 7.
  type Handle = import('./main').DaemonHandle
  const witness: Pick<Handle, 'fireTick'> = {
    fireTick: async (_kind, _at) => {},
  }
  expect(typeof witness.fireTick).toBe('function')
})
```

Now run the test:
Expected: FAIL with `'fireTick' is missing in type 'DaemonHandle'`.

- [ ] **Step 3: Expose tickBodies on `WiredDeps` so `bootDaemon` can capture them**

In `src/daemon/wiring/index.ts`:

```ts
import type { TickBodies } from './tick-bodies'

export interface WiredDeps {
  pipelineDeps: InboundPipelineDeps
  // ... existing fields ...
  /**
   * The same TickBodies object used by the lifecycle onTick callbacks.
   * Exposed so bootDaemon can wire DaemonHandle.fireTick directly to it —
   * eval harness calls fireTick to drive ticks deterministically.
   */
  ticks: TickBodies
  refs: { /* ... */ }
}

// Inside wireMain, return:
return {
  pipelineDeps,
  ...lifecycleDeps,
  ticks,
  refs,
}
```

- [ ] **Step 4: Add `fireTick` to `DaemonHandle` + implement in `bootDaemon`**

In `src/daemon/main.ts`:

```ts
export interface DaemonHandle {
  shutdown(): Promise<void>
  pollingReconcile?(): Promise<void>
  /**
   * Eval-harness seam — manually fire one tick of the named kind, with the
   * given virtual timestamp baked into the envelope. Bypasses the scheduler
   * gates (shouldRun + jitter). Returns when the tick body completes.
   *
   * Production callers never use this; production uses the periodic scheduler
   * registered via registerCompanionPush / registerCompanionIntrospect.
   */
  fireTick(kind: 'push' | 'introspect', at: Date): Promise<void>
}
```

Capture `wired.ticks` in scope, and add to the returned object:

```ts
const wired = wireMain({ /* ... */ })
// ... existing wiring ...

return {
  shutdown,
  pollingReconcile: pollingLcRef ? () => pollingLcRef!.reconcile() : undefined,
  fireTick: async (kind, at) => {
    const nowIso = at.toISOString()
    if (kind === 'push') await wired.ticks.pushTick({ nowIso })
    else await wired.ticks.introspectTick({ nowIso })
  },
}
```

- [ ] **Step 5: Run typecheck + test**

Run: `bun run typecheck && bun --bun vitest run src/daemon/main.fireTick.test.ts`
Expected: PASS.

- [ ] **Step 6: Run full unit suite to verify no regression**

Run: `bun --bun vitest run`
Expected: ALL pass.

- [ ] **Step 7: Commit**

```bash
git add src/daemon/wiring/index.ts src/daemon/main.ts src/daemon/main.fireTick.test.ts
git commit -m "feat(daemon): DaemonHandle.fireTick test seam

Adds fireTick(kind, at) to the boot handle so the eval harness can drive
a single push or introspect tick with a virtual envelope ts, bypassing
the scheduler. Internally calls the same TickBodies functions wired into
the scheduler's onTick — single source of truth. Production callers never
invoke fireTick."
```

---

## Task 4: Scaffold `eval/companion/` directory + repo wiring

**Files:**
- Create: `eval/companion/README.md` (stub — Task 16 fills it in)
- Create: `eval/companion/.gitkeep` placeholders for `engine/` and `trajectories/`
- Modify: `package.json` — add `"yaml"` dep + `eval:companion` script
- Modify: `vitest.config.ts` — exclude `eval/**`
- Modify: `.gitignore` — add `eval/companion/runs/`

- [ ] **Step 1: Create the directory skeleton**

```bash
mkdir -p eval/companion/engine eval/companion/trajectories eval/companion/runs
touch eval/companion/engine/.gitkeep eval/companion/trajectories/.gitkeep eval/companion/runs/.gitkeep
```

Create `eval/companion/README.md` with a one-line placeholder:

```markdown
# Companion Eval Harness

See `docs/superpowers/specs/2026-05-21-companion-eval-harness-design.md` for the design.

(README is fleshed out in the final task — usage + cost expectations + how to add a trajectory.)
```

- [ ] **Step 2: Add `yaml` dependency**

Run: `bun add yaml`
Expected: `yaml` added to `dependencies` in `package.json`, version pinned.

- [ ] **Step 3: Add the `eval:companion` script**

In `package.json`, add to `scripts`:

```json
"eval:companion": "bun eval/companion/run.ts"
```

- [ ] **Step 4: Exclude `eval/**` from default vitest scan**

In `vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/__e2e__/**', '**/playwright/**', '**/eval/**'],
  },
})
```

Rationale: eval tests are expensive (real SDK subprocesses). They run via `bun run eval:companion`, not `bun run test`. The harness's own unit tests (Tasks 5, 6, 8, 11) are run with `bun --bun vitest run <explicit-path>` during development, or by passing an override config.

- [ ] **Step 5: Gitignore the runs directory**

In `.gitignore`, append:

```
# Companion eval harness — per-run artifacts (markdown reports + jsonl dumps).
# Trajectory YAMLs + judge config are checked in; outputs are not.
eval/companion/runs/
```

- [ ] **Step 6: Verify scaffolding**

Run: `ls eval/companion/ && bun run typecheck`
Expected: directory tree exists; typecheck passes (no .ts files yet, no errors).

- [ ] **Step 7: Commit**

```bash
git add eval/ package.json vitest.config.ts .gitignore bun.lockb
git commit -m "chore(eval): scaffold eval/companion/ + yaml dep + vitest exclude

Empty directory layout per design doc. Adds yaml parser dep, eval:companion
npm script, vitest exclude so default test runs skip the expensive harness."
```

---

## Task 5: Trajectory schema + YAML loader

**Files:**
- Create: `eval/companion/engine/trajectory.ts`
- Create: `eval/companion/engine/trajectory.test.ts`

Implements the zod schema from the design's "Trajectory schema" section + a YAML→typed-object loader. The schema is the contract between trajectory authors and the engine — get it right early.

- [ ] **Step 1: Write failing test**

Create `eval/companion/engine/trajectory.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadTrajectory } from './trajectory'

const MINIMAL_YAML = `
trajectory:
  id: smoke_v1
  failure_mode: work_followup
  description: Smoke trajectory
  contact:
    chat_id: chat_test_1
    user_name: testuser
    persona: companion
    profile_md: |
      # profile
    preferences_md: |
      # prefs
    initial_observations: []
    initial_memory_files: {}
  companion_config:
    enabled: true
    default_chat_id: chat_test_1
    quiet_hours_local: null
  events:
    - at: 2026-05-13T09:30:00+08:00
      kind: user_message
      text: hi
    - at: 2026-05-13T09:30:30+08:00
      kind: probe
      probe_kind: reactive_response
      expected:
        decision: send
        summary: should greet back
        must_recall: []
        must_not_recall: []
        tone_hints: []
        state_predicates: []
      dimensions: [restraint]
`

describe('loadTrajectory', () => {
  it('parses a minimal valid trajectory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'traj-test-'))
    const path = join(dir, 'smoke.yaml')
    writeFileSync(path, MINIMAL_YAML)
    try {
      const t = loadTrajectory(path)
      expect(t.id).toBe('smoke_v1')
      expect(t.failure_mode).toBe('work_followup')
      expect(t.events).toHaveLength(2)
      expect(t.events[0]!.kind).toBe('user_message')
      expect(t.events[1]!.kind).toBe('probe')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('rejects an unknown failure_mode', () => {
    const bad = MINIMAL_YAML.replace('work_followup', 'not_a_mode')
    const dir = mkdtempSync(join(tmpdir(), 'traj-test-'))
    const path = join(dir, 'bad.yaml')
    writeFileSync(path, bad)
    try {
      expect(() => loadTrajectory(path)).toThrow(/failure_mode/)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('rejects an event missing required fields for its kind', () => {
    const bad = MINIMAL_YAML.replace(/kind: user_message[\s\S]*?text: hi/, 'kind: user_message')
    const dir = mkdtempSync(join(tmpdir(), 'traj-test-'))
    const path = join(dir, 'bad.yaml')
    writeFileSync(path, bad)
    try {
      expect(() => loadTrajectory(path)).toThrow()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('parses state_predicates as a tagged union', () => {
    const withPredicates = MINIMAL_YAML.replace(
      'state_predicates: []',
      `state_predicates:
          - { kind: observation_body_matches, pattern: "504" }
          - { kind: memory_file_exists, path: "notes/migration.md" }`,
    )
    const dir = mkdtempSync(join(tmpdir(), 'traj-test-'))
    const path = join(dir, 'with-preds.yaml')
    writeFileSync(path, withPredicates)
    try {
      const t = loadTrajectory(path)
      const probe = t.events.find(e => e.kind === 'probe')!
      expect(probe.kind).toBe('probe')
      if (probe.kind !== 'probe') throw new Error('narrow')
      expect(probe.expected.state_predicates).toHaveLength(2)
      expect(probe.expected.state_predicates[0]!.kind).toBe('observation_body_matches')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `bun --bun vitest run eval/companion/engine/trajectory.test.ts --config vitest.config.ts`

Note: `eval/**` is in vitest's exclude list (Task 4). To run harness unit tests, override the config inline:

```bash
bun --bun vitest run eval/companion/engine/trajectory.test.ts -c <(echo 'import { defineConfig } from "vitest/config"; export default defineConfig({ test: {} })')
```

Or temporarily inline via the vitest CLI's `--exclude` override. Simplest:

```bash
bun --bun vitest run eval/companion/engine/trajectory.test.ts --exclude ''
```

Expected: FAIL — `trajectory.ts` doesn't exist.

- [ ] **Step 3: Implement schema + loader**

Create `eval/companion/engine/trajectory.ts`:

```ts
import { readFileSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'

const FAILURE_MODES = [
  'work_followup',
  'emotional_care',
  'cross_domain_mixing',
  'fact_update_supersede',
  'wrong_inference_correction',
  'explicit_quiet',
  'long_silence_initiative',
  'multi_persona_isolation',
] as const

const DIMENSIONS = ['recall', 'inference', 'calibration', 'initiative', 'restraint'] as const

const ObservationToneSchema = z.enum(['concern', 'curious', 'proud', 'playful', 'quiet'])

const InitialObservationSchema = z.object({
  id: z.string(),
  ts: z.string(),
  body: z.string(),
  tone: ObservationToneSchema.optional(),
  archived: z.boolean().default(false),
})

const StatePredicateSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('observation_body_matches'), pattern: z.string() }),
  z.object({ kind: z.literal('memory_file_exists'), path: z.string() }),
  z.object({ kind: z.literal('memory_file_matches'), path: z.string(), pattern: z.string() }),
  z.object({ kind: z.literal('outbox_count_at_chat'), eq: z.number().int().nonnegative() }),
])

const ExpectedSchema = z.object({
  decision: z.enum(['send', 'silent', 'n/a']),
  summary: z.string(),
  must_recall: z.array(z.string()).default([]),
  must_not_recall: z.array(z.string()).default([]),
  tone_hints: z.array(z.string()).default([]),
  state_predicates: z.array(StatePredicateSchema).default([]),
})

const UserMessageEventSchema = z.object({
  at: z.string(),
  kind: z.literal('user_message'),
  text: z.string(),
})

const TickEventSchema = z.object({
  at: z.string(),
  kind: z.literal('tick'),
  tick_kind: z.enum(['push', 'introspect']),
})

const ProbeEventSchema = z.object({
  at: z.string(),
  kind: z.literal('probe'),
  probe_kind: z.enum(['reactive_response', 'proactive_decision', 'memory_recall', 'state_inspect']),
  ask: z.string().optional(),
  expected: ExpectedSchema,
  dimensions: z.array(z.enum(DIMENSIONS)).default([]),
})

const EventSchema = z.discriminatedUnion('kind', [
  UserMessageEventSchema,
  TickEventSchema,
  ProbeEventSchema,
])

const ContactSchema = z.object({
  chat_id: z.string(),
  user_name: z.string(),
  persona: z.enum(['assistant', 'companion']),
  profile_md: z.string(),
  preferences_md: z.string(),
  initial_observations: z.array(InitialObservationSchema).default([]),
  initial_memory_files: z.record(z.string(), z.string()).default({}),
})

const CompanionConfigSchema = z.object({
  enabled: z.boolean(),
  default_chat_id: z.string(),
  quiet_hours_local: z.string().nullable(),
})

const TrajectorySchema = z.object({
  id: z.string(),
  failure_mode: z.enum(FAILURE_MODES),
  description: z.string(),
  contact: ContactSchema,
  companion_config: CompanionConfigSchema,
  events: z.array(EventSchema),
})

export type Trajectory = z.infer<typeof TrajectorySchema>
export type TrajectoryEvent = z.infer<typeof EventSchema>
export type TrajectoryProbe = z.infer<typeof ProbeEventSchema>
export type TrajectoryExpected = z.infer<typeof ExpectedSchema>
export type StatePredicate = z.infer<typeof StatePredicateSchema>

export function loadTrajectory(path: string): Trajectory {
  const raw = parseYaml(readFileSync(path, 'utf8')) as unknown
  if (typeof raw !== 'object' || raw === null || !('trajectory' in raw)) {
    throw new Error(`loadTrajectory(${path}): missing top-level 'trajectory' key`)
  }
  const parsed = TrajectorySchema.safeParse((raw as { trajectory: unknown }).trajectory)
  if (!parsed.success) {
    throw new Error(`loadTrajectory(${path}): ${parsed.error.message}`)
  }
  return parsed.data
}
```

- [ ] **Step 4: Run to verify pass**

Run: `bun --bun vitest run eval/companion/engine/trajectory.test.ts --exclude ''`
Expected: ALL pass.

- [ ] **Step 5: Typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add eval/companion/engine/trajectory.ts eval/companion/engine/trajectory.test.ts
git commit -m "feat(eval): trajectory zod schema + YAML loader

Schema mirrors the design doc: contact + companion_config + tagged-union
events (user_message / tick / probe). State predicates are a discriminated
union the assertion layer parses by kind."
```

---

## Task 6: Clock helpers

**Files:**
- Create: `eval/companion/engine/clock.ts`
- Create: `eval/companion/engine/clock.test.ts`

Small module — parsing ISO 8601 with timezone, formatting back, and the `SAFE_INFINITY` constant for `schedulerIntervalMs`.

- [ ] **Step 1: Write failing test**

Create `eval/companion/engine/clock.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { parseIso, toIsoUtc, SAFE_INFINITY_MS } from './clock'

describe('clock helpers', () => {
  it('parses ISO 8601 with timezone offset', () => {
    const d = parseIso('2026-05-13T09:30:00+08:00')
    // 09:30 +0800 == 01:30 UTC
    expect(d.toISOString()).toBe('2026-05-13T01:30:00.000Z')
  })

  it('toIsoUtc returns Z-suffixed UTC iso', () => {
    const d = parseIso('2026-05-13T09:30:00+08:00')
    expect(toIsoUtc(d)).toBe('2026-05-13T01:30:00.000Z')
  })

  it('rejects malformed input', () => {
    expect(() => parseIso('not a date')).toThrow(/parseIso/)
  })

  it('SAFE_INFINITY_MS fits in int32 (largest setTimeout-safe value)', () => {
    expect(SAFE_INFINITY_MS).toBe(2 ** 31 - 1)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `bun --bun vitest run eval/companion/engine/clock.test.ts --exclude ''`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

Create `eval/companion/engine/clock.ts`:

```ts
/**
 * Max value Node/Bun's setTimeout accepts without immediately firing — any
 * larger and the timer fires instantly. Used as the scheduler interval
 * override in eval so the companion scheduler is effectively dormant.
 */
export const SAFE_INFINITY_MS = 2 ** 31 - 1

export function parseIso(s: string): Date {
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) {
    throw new Error(`parseIso: cannot parse "${s}" as ISO 8601`)
  }
  return d
}

export function toIsoUtc(d: Date): string {
  return d.toISOString()
}
```

- [ ] **Step 4: Run + commit**

Run: `bun --bun vitest run eval/companion/engine/clock.test.ts --exclude '' && bun run typecheck`
Expected: PASS.

```bash
git add eval/companion/engine/clock.ts eval/companion/engine/clock.test.ts
git commit -m "feat(eval): clock helpers + SAFE_INFINITY_MS constant"
```

---

## Task 7: Daemon-shim — boot a test daemon without fake-sdk

**Files:**
- Create: `eval/companion/engine/daemon-shim.ts`

The existing `src/daemon/__e2e__/harness.ts` is close to what we need, but it installs fake SDKs (claudeScript/codexScript). For eval we want **real** SDK subprocesses (real model calls). Lifting + adapting the harness gives us fake-ilink, fake-media, stateDir provisioning, and `sendText`/`waitForReplyTo`.

The shim's surface is narrower than the e2e harness — eval doesn't need `sendImage`, conversation mode presets, or moderator scripts.

- [ ] **Step 1: Implement the shim** (no separate test — exercised by Task 9's replay smoke test)

Create `eval/companion/engine/daemon-shim.ts`:

```ts
/**
 * Eval-harness daemon boot. Mirrors src/daemon/__e2e__/harness.ts but:
 *   - never installs a fake SDK (real claude / codex subprocesses)
 *   - exposes daemonHandle.fireTick (Task 3) to the engine
 *   - returns the raw stateDir so the engine can seed memory files +
 *     observations BEFORE the daemon boots (avoids races with introspect)
 *
 * Side-effect import of '../../../src/daemon/__e2e__/fake-media' replaces
 * materializeAttachments with a local-file stub so eval doesn't hit the
 * ilink CDN. Real CDN access from a regression test would be flaky and slow.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { startFakeIlink, type FakeIlinkHandle, type OutboundMsg } from '../../../src/daemon/__e2e__/fake-ilink-server'
import '../../../src/daemon/__e2e__/fake-media'
import type { RawUpdate } from '../../../src/daemon/poll-loop'
import type { DaemonHandle } from '../../../src/daemon/main'
import { SAFE_INFINITY_MS } from './clock'

export interface EvalDaemonOpts {
  /** chatId → user_name. Populates user_names.json so onboarding is skipped. */
  knownUsers: Record<string, string>
  /** Initial companion config (passed straight through; eval always wants enabled=true). */
  companion: { enabled: boolean; default_chat_id: string }
}

export interface EvalDaemon {
  ilink: FakeIlinkHandle
  stateDir: string
  daemonHandle: DaemonHandle
  sendText(chatId: string, text: string, opts?: { createTimeMs?: number }): void
  waitForReplyTo(chatId: string, timeoutMs?: number): Promise<readonly OutboundMsg[]>
  /** Snapshot of all outbound messages routed to chatId so far. */
  outboundFor(chatId: string): readonly OutboundMsg[]
  stop(): Promise<void>
}

let messageIdCounter = 1
function nextMessageId(): number { return messageIdCounter++ }

export async function startEvalDaemon(opts: EvalDaemonOpts): Promise<EvalDaemon> {
  const ilink = await startFakeIlink()
  const stateDir = mkdtempSync(join(tmpdir(), 'wechat-cc-eval-'))
  mkdirSync(join(stateDir, 'inbox'), { recursive: true })
  mkdirSync(join(stateDir, 'memory'), { recursive: true })
  mkdirSync(join(stateDir, 'accounts', 'bot1'), { recursive: true })

  // access.json — allow all, single admin
  writeFileSync(join(stateDir, 'access.json'), JSON.stringify({
    allowFrom: ['*'], admins: ['evaladmin'],
  }, null, 2))

  // Single fake bot pointing at fake ilink
  writeFileSync(join(stateDir, 'accounts', 'bot1', 'account.json'), JSON.stringify({
    botId: 'bot1', userId: 'owner1', baseUrl: ilink.baseUrl,
  }, null, 2))
  writeFileSync(join(stateDir, 'accounts', 'bot1', 'token'), 'fake-token')

  // Pre-populate routing so send-reply doesn't wait on debounced flushes
  writeFileSync(join(stateDir, 'user_names.json'), JSON.stringify(opts.knownUsers))
  const userAccountIds: Record<string, string> = {}
  for (const chatId of Object.keys(opts.knownUsers)) userAccountIds[chatId] = 'bot1'
  writeFileSync(join(stateDir, 'user_account_ids.json'), JSON.stringify(userAccountIds))

  // Companion config — eval always wants it enabled (engine drives ticks)
  mkdirSync(join(stateDir, 'companion'), { recursive: true })
  writeFileSync(join(stateDir, 'companion', 'config.json'), JSON.stringify({
    enabled: opts.companion.enabled,
    default_chat_id: opts.companion.default_chat_id,
    snooze_until: null,
    last_introspect_at: null,
    timezone: 'UTC',
  }, null, 2))

  // Env overrides — same pattern as e2e harness
  const origStateDir = process.env.WECHAT_CC_STATE_DIR
  const origWechatStateDir = process.env.WECHAT_STATE_DIR
  process.env.WECHAT_CC_STATE_DIR = stateDir
  process.env.WECHAT_STATE_DIR = stateDir

  // Dynamic import so fake-media's vi.mock has registered before SDK loads
  const { bootDaemon } = await import('../../../src/daemon/main')
  const daemonHandle = await bootDaemon({
    stateDir,
    dangerously: false,
    schedulerIntervalMs: SAFE_INFINITY_MS,
  })

  // Let the polling loop spin up before we enqueue
  await new Promise(r => setTimeout(r, 50))

  return {
    ilink,
    stateDir,
    daemonHandle,
    sendText(chatId, text, sendOpts) {
      const update: RawUpdate = {
        message_id: nextMessageId(),
        from_user_id: chatId,
        to_user_id: 'bot1',
        create_time_ms: sendOpts?.createTimeMs ?? Date.now(),
        message_type: 1,
        message_state: 2,
        item_list: [{ type: 1, msg_id: `m${nextMessageId()}`, text_item: { text } }],
        context_token: `ctx-${chatId}`,
      }
      ilink.enqueueInbound(update)
    },
    waitForReplyTo(chatId, timeoutMs = 120_000) {
      return ilink.waitForOutbound(
        msgs => msgs.some(m => m.endpoint === 'sendmessage' && m.chatId === chatId),
        timeoutMs,
      )
    },
    outboundFor(chatId) {
      return ilink.outbox().filter(m => m.endpoint === 'sendmessage' && m.chatId === chatId)
    },
    async stop() {
      await daemonHandle.shutdown()
      if (origStateDir === undefined) delete process.env.WECHAT_CC_STATE_DIR
      else process.env.WECHAT_CC_STATE_DIR = origStateDir
      if (origWechatStateDir === undefined) delete process.env.WECHAT_STATE_DIR
      else process.env.WECHAT_STATE_DIR = origWechatStateDir
      try { await ilink.stop() } catch {}
      try { rmSync(stateDir, { recursive: true, force: true }) } catch {}
    },
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add eval/companion/engine/daemon-shim.ts
git commit -m "feat(eval): startEvalDaemon — boot test daemon without fake SDK

Lifts the e2e harness pattern (fake ilink + fake media + state dir provisioning)
but never installs the fake SDK — eval drives real claude/codex subprocesses.
Hard-codes schedulerIntervalMs=SAFE_INFINITY so only fireTick advances the
scheduler. Exercised end-to-end by the replay engine tests."
```

---

## Task 8: State snapshot

**Files:**
- Create: `eval/companion/engine/snapshot.ts`
- Create: `eval/companion/engine/snapshot.test.ts`

The snapshot is what the assertion layer and judge see. Captures: active + archived observations from SQLite, every `.md` under `<stateDir>/memory/<chat_id>/`, and outbound to `chat_id` since trajectory start.

- [ ] **Step 1: Write failing test**

Create `eval/companion/engine/snapshot.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../../../src/lib/db'
import { makeObservationsStore } from '../../../src/daemon/observations/store'
import { captureSnapshot } from './snapshot'
import type { FakeIlinkHandle } from '../../../src/daemon/__e2e__/fake-ilink-server'

describe('captureSnapshot', () => {
  let stateDir: string
  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'snapshot-test-'))
    mkdirSync(join(stateDir, 'memory', 'chat_1'), { recursive: true })
  })
  afterEach(() => { try { rmSync(stateDir, { recursive: true, force: true }) } catch {} })

  it('returns observations + memory files + outbox for the chat', async () => {
    const db = openDb({ path: join(stateDir, 'wechat-cc.db') })
    const obs = makeObservationsStore(db, 'chat_1')
    await obs.append({ body: 'user mentioned migration', tone: 'concern' })
    writeFileSync(join(stateDir, 'memory', 'chat_1', 'profile.md'), '# 顾时瑞\n后端工程师')
    writeFileSync(join(stateDir, 'memory', 'chat_1', 'notes.md'), '- 504 noted')

    const fakeIlink = {
      outbox: () => [
        { endpoint: 'sendmessage' as const, chatId: 'chat_1', text: 'hi', raw: {} },
        { endpoint: 'sendmessage' as const, chatId: 'chat_other', text: 'nope', raw: {} },
      ],
    } as unknown as FakeIlinkHandle

    const snap = await captureSnapshot({
      stateDir, db, chatId: 'chat_1', ilink: fakeIlink,
    })

    expect(snap.observations.active).toHaveLength(1)
    expect(snap.observations.active[0]!.body).toBe('user mentioned migration')
    expect(snap.observations.archived).toHaveLength(0)
    expect(snap.memory.files['profile.md']).toContain('顾时瑞')
    expect(snap.memory.files['notes.md']).toBe('- 504 noted')
    expect(snap.outbox).toHaveLength(1)
    expect(snap.outbox[0]!.text).toBe('hi')
    db.close()
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `bun --bun vitest run eval/companion/engine/snapshot.test.ts --exclude ''`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

Create `eval/companion/engine/snapshot.ts`:

```ts
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Db } from '../../../src/lib/db'
import { makeObservationsStore, type ObservationRecord } from '../../../src/daemon/observations/store'
import type { FakeIlinkHandle, OutboundMsg } from '../../../src/daemon/__e2e__/fake-ilink-server'

export interface StateSnapshot {
  observations: {
    active: ObservationRecord[]
    archived: ObservationRecord[]
  }
  memory: {
    files: Record<string, string>   // filename → content (relative to <stateDir>/memory/<chatId>/)
  }
  outbox: OutboundMsg[]             // sendmessage events to this chat only
}

export interface SnapshotOpts {
  stateDir: string
  db: Db
  chatId: string
  ilink: FakeIlinkHandle
}

export async function captureSnapshot(opts: SnapshotOpts): Promise<StateSnapshot> {
  const store = makeObservationsStore(opts.db, opts.chatId)
  const active = await store.listActive()
  const archived = await store.listArchived()

  const memDir = join(opts.stateDir, 'memory', opts.chatId)
  const files: Record<string, string> = {}
  if (existsSync(memDir)) {
    for (const ent of readdirSync(memDir, { withFileTypes: true })) {
      if (!ent.isFile() || !ent.name.endsWith('.md')) continue
      try { files[ent.name] = readFileSync(join(memDir, ent.name), 'utf8') } catch { /* skip unreadable */ }
    }
  }

  const outbox = opts.ilink.outbox().filter(
    m => m.endpoint === 'sendmessage' && m.chatId === opts.chatId,
  )

  return {
    observations: { active, archived },
    memory: { files },
    outbox,
  }
}
```

- [ ] **Step 4: Run + commit**

Run: `bun --bun vitest run eval/companion/engine/snapshot.test.ts --exclude '' && bun run typecheck`
Expected: PASS.

```bash
git add eval/companion/engine/snapshot.ts eval/companion/engine/snapshot.test.ts
git commit -m "feat(eval): captureSnapshot — observations + memory fs + outbox"
```

---

## Task 9: Replay engine bones (user_message + tick driving)

**Files:**
- Create: `eval/companion/engine/replay.ts`

The engine walks events. user_message + tick are the action types (they mutate daemon state); probe is the inspection type (Task 10 wires those). For now, walk events and skip probes with a TODO so we can smoke-test the driver against a one-event trajectory.

- [ ] **Step 1: Implement minimal replay driver** (no separate unit test — exercised by Task 19's full smoke run)

Create `eval/companion/engine/replay.ts`:

```ts
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { openDb } from '../../../src/lib/db'
import { makeObservationsStore } from '../../../src/daemon/observations/store'
import type { Trajectory } from './trajectory'
import { startEvalDaemon, type EvalDaemon } from './daemon-shim'
import { parseIso } from './clock'
import { captureSnapshot, type StateSnapshot } from './snapshot'
import type { OutboundMsg } from '../../../src/daemon/__e2e__/fake-ilink-server'

export interface EventResult {
  index: number
  event: Trajectory['events'][number]
  /** Captured per-event "what happened" — populated by probe handlers in Task 10. */
  actual?: ProbeActual
  snapshot?: StateSnapshot
  assertions?: AssertionResult[]
  judgeScores?: JudgeScore[]
}

export interface ProbeActual {
  kind: 'reply' | 'tick_outcome' | 'state'
  text?: string
  decision?: 'send' | 'silent'
  error?: string
}

export interface AssertionResult {
  label: string
  passed: boolean
  detail?: string
}

export interface JudgeScore {
  dimension: 'recall' | 'inference' | 'calibration' | 'initiative' | 'restraint'
  score: 1 | 2 | 3 | 4 | 5
  rationale: string
}

export interface ReplayContext {
  trajectory: Trajectory
  daemon: EvalDaemon
  lastUserMessageReply: { text?: string; error?: string } | null
  lastTickOutcome: { decision: 'send' | 'silent'; text?: string } | null
}

export async function replay(trajectory: Trajectory): Promise<EventResult[]> {
  const daemon = await startEvalDaemon({
    knownUsers: { [trajectory.contact.chat_id]: trajectory.contact.user_name },
    companion: {
      enabled: trajectory.companion_config.enabled,
      default_chat_id: trajectory.companion_config.default_chat_id,
    },
  })

  try {
    seedMemoryFiles(daemon.stateDir, trajectory)
    seedObservations(daemon.stateDir, trajectory)

    const ctx: ReplayContext = {
      trajectory, daemon,
      lastUserMessageReply: null,
      lastTickOutcome: null,
    }
    const results: EventResult[] = []

    for (let i = 0; i < trajectory.events.length; i++) {
      const event = trajectory.events[i]!
      const result: EventResult = { index: i, event }

      try {
        if (event.kind === 'user_message') {
          daemon.sendText(trajectory.contact.chat_id, event.text, {
            createTimeMs: parseIso(event.at).getTime(),
          })
          const outboxBefore = daemon.outboundFor(trajectory.contact.chat_id).length
          try {
            await daemon.waitForReplyTo(trajectory.contact.chat_id, 120_000)
            const outbox = daemon.outboundFor(trajectory.contact.chat_id)
            const newOnes = outbox.slice(outboxBefore)
            const lastNew = newOnes[newOnes.length - 1]
            ctx.lastUserMessageReply = { text: lastNew?.text ?? '' }
          } catch (err) {
            ctx.lastUserMessageReply = { error: err instanceof Error ? err.message : String(err) }
          }
        } else if (event.kind === 'tick') {
          const outboxBefore = daemon.outboundFor(trajectory.contact.chat_id).length
          await daemon.daemonHandle.fireTick(event.tick_kind, parseIso(event.at))
          const outbox = daemon.outboundFor(trajectory.contact.chat_id)
          const newOnes = outbox.slice(outboxBefore)
          ctx.lastTickOutcome = newOnes.length > 0
            ? { decision: 'send', text: newOnes[newOnes.length - 1]?.text }
            : { decision: 'silent' }
        } else if (event.kind === 'probe') {
          // Wired in Task 10
          result.actual = await capturedActualForProbe(event, ctx)
          // Wired in Task 11
          // result.assertions = ...
          // Wired in Task 12
          // result.judgeScores = ...
        }
      } catch (err) {
        result.actual = { kind: 'state', error: err instanceof Error ? err.message : String(err) }
      }

      // Always snapshot after the event
      const db = openDb({ path: join(daemon.stateDir, 'wechat-cc.db') })
      try {
        result.snapshot = await captureSnapshot({
          stateDir: daemon.stateDir, db, chatId: trajectory.contact.chat_id, ilink: daemon.ilink,
        })
      } finally { db.close() }

      results.push(result)
    }

    return results
  } finally {
    await daemon.stop()
  }
}

function seedMemoryFiles(stateDir: string, trajectory: Trajectory): void {
  const dir = join(stateDir, 'memory', trajectory.contact.chat_id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'profile.md'), trajectory.contact.profile_md)
  writeFileSync(join(dir, 'preferences.md'), trajectory.contact.preferences_md)
  for (const [rel, content] of Object.entries(trajectory.contact.initial_memory_files)) {
    const target = join(dir, rel)
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, content)
  }
}

function seedObservations(stateDir: string, trajectory: Trajectory): void {
  if (trajectory.contact.initial_observations.length === 0) return
  const db = openDb({ path: join(stateDir, 'wechat-cc.db') })
  try {
    const store = makeObservationsStore(db, trajectory.contact.chat_id)
    for (const obs of trajectory.contact.initial_observations) {
      void store.appendRaw({
        id: obs.id,
        ts: obs.ts,
        body: obs.body,
        archived: obs.archived ?? false,
        ...(obs.tone !== undefined ? { tone: obs.tone } : {}),
      })
    }
  } finally { db.close() }
}

// Placeholder — Task 10 implements the real probe capture per probe_kind.
async function capturedActualForProbe(
  _event: Extract<Trajectory['events'][number], { kind: 'probe' }>,
  _ctx: ReplayContext,
): Promise<ProbeActual> {
  return { kind: 'state' }
}
```

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add eval/companion/engine/replay.ts
git commit -m "feat(eval): replay engine bones — user_message + tick + snapshot

Drives user_message via sendText/waitForReply and tick via fireTick.
After each event, snapshots observations + memory + outbox. Probe handling
is a placeholder for the next task. seedMemoryFiles / seedObservations seed
the daemon's stateDir BEFORE the introspect tick can run."
```

---

## Task 10: Probe handlers

**Files:**
- Modify: `eval/companion/engine/replay.ts`
- Create: `eval/companion/engine/probes.ts`

Each `probe_kind` captures something different:
- `reactive_response` → the most recent `user_message` reply text (already in `ctx.lastUserMessageReply`)
- `proactive_decision` → the most recent `tick` outcome (already in `ctx.lastTickOutcome`)
- `memory_recall` → engine dispatches `event.ask` as a one-shot user message, waits for reply
- `state_inspect` → no action; the snapshot itself IS the actual

- [ ] **Step 1: Implement probe handlers**

Create `eval/companion/engine/probes.ts`:

```ts
import type { Trajectory } from './trajectory'
import type { ProbeActual, ReplayContext } from './replay'
import { parseIso } from './clock'

export async function captureProbe(
  event: Extract<Trajectory['events'][number], { kind: 'probe' }>,
  ctx: ReplayContext,
): Promise<ProbeActual> {
  switch (event.probe_kind) {
    case 'reactive_response': {
      const r = ctx.lastUserMessageReply
      if (!r) return { kind: 'reply', error: 'no prior user_message in this trajectory' }
      if (r.error !== undefined) return { kind: 'reply', error: r.error }
      return { kind: 'reply', text: r.text ?? '' }
    }
    case 'proactive_decision': {
      const t = ctx.lastTickOutcome
      if (!t) return { kind: 'tick_outcome', error: 'no prior tick in this trajectory' }
      return { kind: 'tick_outcome', decision: t.decision, ...(t.text !== undefined ? { text: t.text } : {}) }
    }
    case 'memory_recall': {
      if (!event.ask) return { kind: 'reply', error: 'memory_recall probe requires ask:' }
      const chatId = ctx.trajectory.contact.chat_id
      const outboxBefore = ctx.daemon.outboundFor(chatId).length
      ctx.daemon.sendText(chatId, event.ask, { createTimeMs: parseIso(event.at).getTime() })
      try {
        await ctx.daemon.waitForReplyTo(chatId, 120_000)
        const newOnes = ctx.daemon.outboundFor(chatId).slice(outboxBefore)
        const last = newOnes[newOnes.length - 1]
        return { kind: 'reply', text: last?.text ?? '' }
      } catch (err) {
        return { kind: 'reply', error: err instanceof Error ? err.message : String(err) }
      }
    }
    case 'state_inspect':
      // The snapshot itself IS the actual — engine doesn't drive anything.
      return { kind: 'state' }
  }
}
```

- [ ] **Step 2: Wire it into the replay loop**

In `eval/companion/engine/replay.ts`, replace the placeholder `capturedActualForProbe` call with:

```ts
import { captureProbe } from './probes'

// inside the loop, replace the probe branch's `result.actual = await capturedActualForProbe(...)`:
result.actual = await captureProbe(event, ctx)
```

And delete the now-unused `capturedActualForProbe` stub.

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add eval/companion/engine/probes.ts eval/companion/engine/replay.ts
git commit -m "feat(eval): probe handlers — reactive / proactive / recall / inspect"
```

---

## Task 11: Objective assertions

**Files:**
- Create: `eval/companion/engine/assertions.ts`
- Create: `eval/companion/engine/assertions.test.ts`
- Modify: `eval/companion/engine/replay.ts` (wire into probe branch)

Engine asserts (boolean pass/fail):
- `expected.decision` matches captured outcome
- `must_recall` substrings are present in `actual.text`
- `must_not_recall` substrings are absent
- Every `state_predicate` evaluates true against `snapshot`

- [ ] **Step 1: Write failing test**

Create `eval/companion/engine/assertions.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { runAssertions } from './assertions'

const baseExpected = {
  decision: 'send' as const,
  summary: '',
  must_recall: [] as string[],
  must_not_recall: [] as string[],
  tone_hints: [] as string[],
  state_predicates: [] as never[],
}
const baseSnap = {
  observations: { active: [], archived: [] },
  memory: { files: {} as Record<string, string> },
  outbox: [] as never[],
}

describe('runAssertions', () => {
  it('decision: send matches outbox-non-empty', () => {
    const out = runAssertions({
      expected: { ...baseExpected, decision: 'send' },
      actual: { kind: 'reply', text: '昨天 504 那波睡好没' },
      snapshot: baseSnap,
    })
    expect(out.find(r => r.label === 'decision')!.passed).toBe(true)
  })

  it('must_recall: case-insensitive substring', () => {
    const out = runAssertions({
      expected: { ...baseExpected, must_recall: ['504', 'MIGRATION'] },
      actual: { kind: 'reply', text: '昨天 504 那波 migration 之后稳吗' },
      snapshot: baseSnap,
    })
    expect(out.find(r => r.label === 'must_recall:504')!.passed).toBe(true)
    expect(out.find(r => r.label === 'must_recall:MIGRATION')!.passed).toBe(true)
  })

  it('must_not_recall: presence fails', () => {
    const out = runAssertions({
      expected: { ...baseExpected, must_not_recall: ['抑郁'] },
      actual: { kind: 'reply', text: '看起来你最近有点抑郁' },
      snapshot: baseSnap,
    })
    expect(out.find(r => r.label === 'must_not_recall:抑郁')!.passed).toBe(false)
  })

  it('state_predicate observation_body_matches', () => {
    const snap = {
      ...baseSnap,
      observations: {
        active: [{ id: 'a', ts: '2026-05-13T00:00:00Z', body: 'user hit 504 again', archived: false }],
        archived: [],
      },
    }
    const out = runAssertions({
      expected: { ...baseExpected, state_predicates: [{ kind: 'observation_body_matches', pattern: '504' }] },
      actual: { kind: 'state' },
      snapshot: snap,
    })
    expect(out.find(r => r.label.startsWith('state:observation_body_matches'))!.passed).toBe(true)
  })

  it('state_predicate memory_file_exists', () => {
    const snap = {
      ...baseSnap,
      memory: { files: { 'notes/migration.md': '...' } },
    }
    const out = runAssertions({
      expected: { ...baseExpected, state_predicates: [{ kind: 'memory_file_exists', path: 'notes/migration.md' }] },
      actual: { kind: 'state' },
      snapshot: snap,
    })
    expect(out.find(r => r.label.startsWith('state:memory_file_exists'))!.passed).toBe(true)
  })

  it('state_predicate outbox_count_at_chat eq', () => {
    const out = runAssertions({
      expected: { ...baseExpected, state_predicates: [{ kind: 'outbox_count_at_chat', eq: 0 }] },
      actual: { kind: 'state' },
      snapshot: baseSnap,
    })
    expect(out.find(r => r.label.startsWith('state:outbox_count_at_chat'))!.passed).toBe(true)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `bun --bun vitest run eval/companion/engine/assertions.test.ts --exclude ''`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

Create `eval/companion/engine/assertions.ts`:

```ts
import type { TrajectoryExpected, StatePredicate } from './trajectory'
import type { ProbeActual, AssertionResult } from './replay'
import type { StateSnapshot } from './snapshot'

export interface AssertionInput {
  expected: TrajectoryExpected
  actual: ProbeActual
  snapshot: StateSnapshot
}

export function runAssertions(input: AssertionInput): AssertionResult[] {
  const results: AssertionResult[] = []

  // decision
  if (input.expected.decision !== 'n/a') {
    const got = decisionFromActual(input.actual)
    results.push({
      label: 'decision',
      passed: got === input.expected.decision,
      detail: `expected=${input.expected.decision} actual=${got}`,
    })
  }

  // must_recall (case-insensitive substring)
  const text = (input.actual.text ?? '').toLowerCase()
  for (const needle of input.expected.must_recall) {
    results.push({
      label: `must_recall:${needle}`,
      passed: text.includes(needle.toLowerCase()),
    })
  }
  for (const needle of input.expected.must_not_recall) {
    results.push({
      label: `must_not_recall:${needle}`,
      passed: !text.includes(needle.toLowerCase()),
    })
  }

  // state predicates
  for (const pred of input.expected.state_predicates) {
    results.push(evalPredicate(pred, input.snapshot))
  }

  return results
}

function decisionFromActual(actual: ProbeActual): 'send' | 'silent' | 'unknown' {
  if (actual.kind === 'tick_outcome' && actual.decision !== undefined) return actual.decision
  if (actual.kind === 'reply') {
    if (actual.error !== undefined) return 'silent'
    return (actual.text ?? '').length > 0 ? 'send' : 'silent'
  }
  return 'unknown'
}

function evalPredicate(pred: StatePredicate, snap: StateSnapshot): AssertionResult {
  switch (pred.kind) {
    case 'observation_body_matches': {
      const needle = pred.pattern.toLowerCase()
      const hit = snap.observations.active.some(o => o.body.toLowerCase().includes(needle))
        || snap.observations.archived.some(o => o.body.toLowerCase().includes(needle))
      return {
        label: `state:observation_body_matches:${pred.pattern}`,
        passed: hit,
      }
    }
    case 'memory_file_exists':
      return {
        label: `state:memory_file_exists:${pred.path}`,
        passed: pred.path in snap.memory.files,
      }
    case 'memory_file_matches': {
      const content = snap.memory.files[pred.path]
      return {
        label: `state:memory_file_matches:${pred.path}:${pred.pattern}`,
        passed: content !== undefined && content.toLowerCase().includes(pred.pattern.toLowerCase()),
      }
    }
    case 'outbox_count_at_chat':
      return {
        label: `state:outbox_count_at_chat:${pred.eq}`,
        passed: snap.outbox.length === pred.eq,
        detail: `actual=${snap.outbox.length}`,
      }
  }
}
```

- [ ] **Step 4: Wire into replay**

In `eval/companion/engine/replay.ts`, in the probe branch (after `captureProbe`):

```ts
import { runAssertions } from './assertions'

// inside the loop, after result.actual = await captureProbe(...):
const db2 = openDb({ path: join(daemon.stateDir, 'wechat-cc.db') })
try {
  const snap = await captureSnapshot({
    stateDir: daemon.stateDir, db: db2, chatId: trajectory.contact.chat_id, ilink: daemon.ilink,
  })
  result.snapshot = snap
  result.assertions = runAssertions({
    expected: event.expected,
    actual: result.actual,
    snapshot: snap,
  })
} finally { db2.close() }
```

And remove the duplicate post-event snapshot for probe events (the existing per-event snapshot block now only runs for non-probe events — restructure to avoid double-snapshot).

- [ ] **Step 5: Run + commit**

Run: `bun --bun vitest run eval/companion/engine/assertions.test.ts --exclude '' && bun run typecheck`
Expected: PASS.

```bash
git add eval/companion/engine/assertions.ts eval/companion/engine/assertions.test.ts eval/companion/engine/replay.ts
git commit -m "feat(eval): objective assertions — decision + recall + state predicates"
```

---

## Task 12: Judge interface + Claude SDK backend

**Files:**
- Create: `eval/companion/engine/judge.ts`
- Create: `eval/companion/engine/judge-claude-sdk.ts`
- Create: `eval/companion/engine/judge-prompts.ts`
- Create: `eval/companion/judge-config.json`
- Modify: `eval/companion/engine/replay.ts` (wire judge in)

The judge scores 1–5 per requested dimension. MVP ships one Claude SDK backend; stubs for Codex / API throw `'not implemented'`. Backend choice is read from `judge-config.json`.

- [ ] **Step 1: Define the rubric prompts**

Create `eval/companion/engine/judge-prompts.ts`. Source the rubric text verbatim from `docs/spike/2026-05-09-companion-eval-harness.md` §LLM-as-Judge (or extract from the spike file directly):

```ts
/**
 * Per-dimension rubric. Each entry describes what 1-5 means for that
 * dimension. The judge prompt asks the judge model to return one
 * { dimension, score, rationale } object per requested dimension.
 *
 * Source: docs/spike/2026-05-09-companion-eval-harness.md §LLM-as-Judge.
 * If that file moves or is rewritten, update the comment + verify the
 * rubric text still matches.
 */
export const RUBRIC: Record<'recall' | 'inference' | 'calibration' | 'initiative' | 'restraint', string> = {
  recall: '5 = surfaces the right prior fact at the right moment; 1 = ignores or contradicts established memory.',
  inference: '5 = sound, charitable interpretation of user state; 1 = jumps to wrong conclusion or projects feelings.',
  calibration: '5 = tone and length match the user\'s current bandwidth; 1 = tone mismatched (cheerful while user is stressed, etc).',
  initiative: '5 = proactive at exactly the right moment; 1 = pings when user wants silence, or stays silent when a check-in is wanted.',
  restraint: '5 = says only what\'s needed, no over-explaining or moralizing; 1 = lectures, adds disclaimers, prescribes solutions unprompted.',
}

export function buildJudgePrompt(opts: {
  trajectoryHistoryToProbe: string
  expectedSummary: string
  expectedMustRecall: string[]
  expectedToneHints: string[]
  actualText: string | undefined
  actualDecision: 'send' | 'silent' | undefined
  dimensions: ReadonlyArray<keyof typeof RUBRIC>
}): string {
  const rubricLines = opts.dimensions.map(d => `- ${d}: ${RUBRIC[d]}`).join('\n')
  return `You are evaluating an AI companion's response in a multi-turn conversation. Score ONLY these dimensions: ${opts.dimensions.join(', ')}.

# Conversation history (everything up to and including the probe point)
${opts.trajectoryHistoryToProbe}

# What was expected
- Summary: ${opts.expectedSummary}
- Must recall: ${opts.expectedMustRecall.join(', ') || '(none)'}
- Tone hints: ${opts.expectedToneHints.join(', ') || '(none)'}

# What actually happened
- Decision: ${opts.actualDecision ?? 'n/a'}
- Reply text: ${opts.actualText ?? '(silent / no reply)'}

# Rubric
${rubricLines}

# Output format
Return a JSON array, one object per dimension you scored. No prose outside the array.
[
  {"dimension": "recall", "score": 4, "rationale": "..."},
  ...
]`
}
```

- [ ] **Step 2: Define the judge interface**

Create `eval/companion/engine/judge.ts`:

```ts
import type { JudgeScore } from './replay'
import type { TrajectoryExpected } from './trajectory'
import type { ProbeActual } from './replay'

export type JudgeDimension = JudgeScore['dimension']

export interface JudgeProbeInput {
  trajectoryHistoryToProbe: string
  expected: TrajectoryExpected
  actual: ProbeActual
  dimensions: ReadonlyArray<JudgeDimension>
}

export interface Judge {
  name: string
  score(input: JudgeProbeInput): Promise<JudgeScore[]>
}

export function makeCodexSdkJudge(_opts: { model?: string } = {}): Judge {
  return {
    name: 'codex-sdk:not-implemented',
    score: () => { throw new Error('codex-sdk judge: not implemented (MVP ships claude-sdk only)') },
  }
}

export function makeAnthropicApiJudge(_opts: { apiKey: string; model?: string }): Judge {
  return {
    name: 'anthropic-api:not-implemented',
    score: () => { throw new Error('anthropic-api judge: not implemented (MVP ships claude-sdk only)') },
  }
}

// makeClaudeSdkJudge is defined in judge-claude-sdk.ts to keep this file
// SDK-import-free for callers that only need the interface (e.g. reporters).
```

- [ ] **Step 3: Implement the Claude SDK backend**

Create `eval/companion/engine/judge-claude-sdk.ts`:

```ts
/**
 * Claude SDK judge backend.
 *
 * Calls @anthropic-ai/claude-agent-sdk's `query()` with the rubric prompt
 * and parses the JSON array reply. The SDK is invoked the same way
 * src/daemon/wiring/side-effects.ts's makeIsolatedSdkEval does: one-shot
 * query, drain messages, extract assistant text.
 */
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { Judge, JudgeProbeInput, JudgeDimension } from './judge'
import type { JudgeScore } from './replay'
import { buildJudgePrompt } from './judge-prompts'

export function makeClaudeSdkJudge(opts: { model?: string } = {}): Judge {
  const model = opts.model ?? 'claude-opus-4-7'
  return {
    name: `claude-sdk:${model}`,
    async score(input: JudgeProbeInput): Promise<JudgeScore[]> {
      if (input.dimensions.length === 0) return []
      const prompt = buildJudgePrompt({
        trajectoryHistoryToProbe: input.trajectoryHistoryToProbe,
        expectedSummary: input.expected.summary,
        expectedMustRecall: input.expected.must_recall,
        expectedToneHints: input.expected.tone_hints,
        actualText: input.actual.text,
        actualDecision: input.actual.decision,
        dimensions: input.dimensions,
      })

      let text = ''
      const stream = query({
        prompt,
        options: { model, settingSources: [] },
      })
      for await (const msg of stream as AsyncIterable<SDKMessage>) {
        if (msg.type === 'assistant') {
          for (const block of msg.message.content) {
            if (block.type === 'text') text += block.text
          }
        }
      }

      const cleaned = text.trim().replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim()
      let parsed: unknown
      try { parsed = JSON.parse(cleaned) } catch (err) {
        throw new Error(`judge JSON parse failed: ${err instanceof Error ? err.message : String(err)} — text=${cleaned.slice(0, 200)}`)
      }
      if (!Array.isArray(parsed)) throw new Error(`judge returned non-array: ${typeof parsed}`)

      const out: JudgeScore[] = []
      for (const item of parsed) {
        if (typeof item !== 'object' || item === null) continue
        const o = item as Record<string, unknown>
        const dim = o.dimension as JudgeDimension | undefined
        const score = o.score
        const rationale = o.rationale
        if (typeof dim !== 'string' || typeof score !== 'number' || typeof rationale !== 'string') continue
        if (!input.dimensions.includes(dim)) continue
        const clamped = Math.max(1, Math.min(5, Math.round(score))) as JudgeScore['score']
        out.push({ dimension: dim, score: clamped, rationale })
      }
      return out
    },
  }
}
```

- [ ] **Step 4: Default judge config**

Create `eval/companion/judge-config.json`:

```json
{
  "kind": "claude-sdk",
  "model": "claude-opus-4-7"
}
```

- [ ] **Step 5: Wire judge into replay**

In `eval/companion/engine/replay.ts`:

```ts
import type { Judge } from './judge'

export interface ReplayOpts {
  judge: Judge
}

export async function replay(trajectory: Trajectory, opts: ReplayOpts): Promise<EventResult[]> {
  // ... existing setup ...

  for (let i = 0; i < trajectory.events.length; i++) {
    // ... existing event handling ...
    if (event.kind === 'probe' && event.dimensions.length > 0) {
      try {
        result.judgeScores = await opts.judge.score({
          trajectoryHistoryToProbe: renderHistoryToIndex(trajectory, i),
          expected: event.expected,
          actual: result.actual!,
          dimensions: event.dimensions,
        })
      } catch (err) {
        result.judgeScores = []
        // Don't halt — record and continue
        result.assertions = [
          ...(result.assertions ?? []),
          { label: 'judge_error', passed: false, detail: err instanceof Error ? err.message : String(err) },
        ]
      }
    }
    results.push(result)
  }
  // ...
}

function renderHistoryToIndex(t: Trajectory, idx: number): string {
  const lines: string[] = []
  for (let j = 0; j <= idx; j++) {
    const ev = t.events[j]!
    if (ev.kind === 'user_message') lines.push(`[${ev.at}] USER: ${ev.text}`)
    else if (ev.kind === 'tick') lines.push(`[${ev.at}] TICK (${ev.tick_kind})`)
    else lines.push(`[${ev.at}] PROBE (${ev.probe_kind})`)
  }
  return lines.join('\n')
}
```

- [ ] **Step 6: Typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add eval/companion/engine/judge.ts eval/companion/engine/judge-claude-sdk.ts \
        eval/companion/engine/judge-prompts.ts eval/companion/judge-config.json \
        eval/companion/engine/replay.ts
git commit -m "feat(eval): judge interface + Claude SDK backend + rubric prompts"
```

---

## Task 13: Reporter (markdown + jsonl)

**Files:**
- Create: `eval/companion/engine/reporter.ts`

Produces three artefacts per run: `report.md`, `trajectory.<id>.jsonl` (one line per event), and `judge-calls.jsonl` (debug).

- [ ] **Step 1: Implement**

Create `eval/companion/engine/reporter.ts`:

```ts
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Trajectory } from './trajectory'
import type { EventResult } from './replay'

export interface ReportInput {
  judgeName: string
  startedAt: Date
  finishedAt: Date
  trajectories: Array<{ trajectory: Trajectory; results: EventResult[] }>
}

export function writeReport(runDir: string, input: ReportInput): void {
  mkdirSync(runDir, { recursive: true })

  // 1. Per-trajectory jsonl raw dumps
  for (const t of input.trajectories) {
    const path = join(runDir, `trajectory.${t.trajectory.id}.jsonl`)
    for (const r of t.results) {
      appendFileSync(path, JSON.stringify(r) + '\n')
    }
  }

  // 2. Markdown report
  const md = renderMarkdown(input)
  writeFileSync(join(runDir, 'report.md'), md)
}

function renderMarkdown(input: ReportInput): string {
  const wallMs = input.finishedAt.getTime() - input.startedAt.getTime()
  const wallStr = `${Math.floor(wallMs / 60_000)}m${Math.floor((wallMs % 60_000) / 1000)}s`
  const errs = input.trajectories.reduce(
    (acc, t) => acc + t.results.filter(r => r.actual?.error !== undefined).length, 0,
  )
  const totalProbes = input.trajectories.reduce(
    (acc, t) => acc + t.results.filter(r => r.event.kind === 'probe').length, 0,
  )

  const lines: string[] = []
  lines.push(`# Companion eval run · ${input.startedAt.toISOString()}`)
  lines.push(`**Judge**: ${input.judgeName}  **Trajectories**: ${input.trajectories.length}  **Wall time**: ${wallStr}  **Errors**: ${errs}`)
  lines.push('')

  for (const t of input.trajectories) {
    const probes = t.results.filter(r => r.event.kind === 'probe')
    lines.push(`## ${t.trajectory.id} (${t.trajectory.failure_mode}) — ${probes.length} probes`)
    lines.push('')
    for (const p of probes) {
      if (p.event.kind !== 'probe') continue
      lines.push(`### Probe ${p.index} · ${p.event.probe_kind} @ ${p.event.at}`)
      lines.push(`- **Expected**: decision=${p.event.expected.decision} · summary="${p.event.expected.summary}"`)
      const actualSummary = p.actual?.error !== undefined
        ? `ERROR: ${p.actual.error}`
        : p.actual?.kind === 'tick_outcome'
          ? `decision=${p.actual.decision}${p.actual.text ? ` · text="${truncate(p.actual.text, 200)}"` : ''}`
          : p.actual?.kind === 'reply'
            ? `text="${truncate(p.actual.text ?? '', 200)}"`
            : 'state-only'
      lines.push(`- **Actual**: ${actualSummary}`)
      if (p.assertions && p.assertions.length > 0) {
        const checks = p.assertions.map(a => `${a.passed ? '✅' : '❌'} ${a.label}${a.detail ? ` (${a.detail})` : ''}`).join(' · ')
        lines.push(`- **Engine assertions**: ${checks}`)
      }
      if (p.judgeScores && p.judgeScores.length > 0) {
        lines.push(`- **Judge** (${input.judgeName}):`)
        for (const s of p.judgeScores) {
          lines.push(`  - ${s.dimension}: ${s.score} — ${s.rationale}`)
        }
      }
      lines.push('')
    }
  }

  // Summary
  lines.push('## Summary')
  lines.push(`- ${input.trajectories.length} trajectories · ${totalProbes} probes · ${errs} errors`)
  const dimAvgs = computeDimensionAverages(input.trajectories)
  if (Object.keys(dimAvgs).length > 0) {
    lines.push(`- Average dimension scores: ${Object.entries(dimAvgs).map(([d, v]) => `${d} ${v.toFixed(1)}`).join(' · ')}`)
  }

  return lines.join('\n') + '\n'
}

function truncate(s: string, n: number): string { return s.length > n ? s.slice(0, n) + '…' : s }

function computeDimensionAverages(
  trajs: ReadonlyArray<{ trajectory: Trajectory; results: EventResult[] }>,
): Record<string, number> {
  const sums: Record<string, { sum: number; count: number }> = {}
  for (const t of trajs) for (const r of t.results) for (const s of r.judgeScores ?? []) {
    const slot = sums[s.dimension] ?? (sums[s.dimension] = { sum: 0, count: 0 })
    slot.sum += s.score; slot.count += 1
  }
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(sums)) out[k] = v.sum / v.count
  return out
}
```

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add eval/companion/engine/reporter.ts
git commit -m "feat(eval): markdown + jsonl reporter"
```

---

## Task 14: CLI entry — `run.ts`

**Files:**
- Create: `eval/companion/run.ts`

The CLI loads trajectories, picks a judge per `judge-config.json`, runs replay, writes the report. Minimal: one optional `--trajectory <id>` flag; without it, runs all YAMLs in `trajectories/`.

- [ ] **Step 1: Implement**

Create `eval/companion/run.ts`:

```ts
#!/usr/bin/env bun
/**
 * Companion eval runner.
 *
 * Usage:
 *   bun run eval:companion                         # run all trajectories
 *   bun run eval:companion --trajectory tech_stress_followup_v1
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadTrajectory } from './engine/trajectory'
import { replay } from './engine/replay'
import { writeReport } from './engine/reporter'
import { makeClaudeSdkJudge } from './engine/judge-claude-sdk'
import { makeCodexSdkJudge, makeAnthropicApiJudge, type Judge } from './engine/judge'

const HERE = fileURLToPath(new URL('.', import.meta.url))

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const trajArgIdx = args.indexOf('--trajectory')
  const requested = trajArgIdx >= 0 ? args[trajArgIdx + 1] : undefined

  const judge = loadJudge()
  console.log(`[eval] judge: ${judge.name}`)

  const trajDir = join(HERE, 'trajectories')
  const files = readdirSync(trajDir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'))
  if (files.length === 0) throw new Error(`No trajectories found in ${trajDir}`)

  const startedAt = new Date()
  const runDir = join(HERE, 'runs', startedAt.toISOString().replace(/[:.]/g, '-'))

  const out: Array<{ trajectory: ReturnType<typeof loadTrajectory>; results: Awaited<ReturnType<typeof replay>> }> = []
  for (const file of files) {
    const traj = loadTrajectory(join(trajDir, file))
    if (requested !== undefined && traj.id !== requested) continue
    console.log(`[eval] running ${traj.id} (${traj.failure_mode}) — ${traj.events.length} events`)
    const results = await replay(traj, { judge })
    out.push({ trajectory: traj, results })
  }

  if (out.length === 0) {
    throw new Error(`No trajectory matched ${requested ?? '(all)'}`)
  }

  const finishedAt = new Date()
  writeReport(runDir, { judgeName: judge.name, startedAt, finishedAt, trajectories: out })
  console.log(`[eval] done — report: ${join(runDir, 'report.md')}`)
}

function loadJudge(): Judge {
  const cfgPath = join(HERE, 'judge-config.json')
  if (!existsSync(cfgPath)) throw new Error(`Missing ${cfgPath}`)
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as { kind: string; model?: string; apiKey?: string }
  switch (cfg.kind) {
    case 'claude-sdk': return makeClaudeSdkJudge({ ...(cfg.model !== undefined ? { model: cfg.model } : {}) })
    case 'codex-sdk': return makeCodexSdkJudge({ ...(cfg.model !== undefined ? { model: cfg.model } : {}) })
    case 'anthropic-api':
      if (!cfg.apiKey) throw new Error('anthropic-api judge requires apiKey in judge-config.json')
      return makeAnthropicApiJudge({ apiKey: cfg.apiKey, ...(cfg.model !== undefined ? { model: cfg.model } : {}) })
    default: throw new Error(`Unknown judge kind: ${cfg.kind}`)
  }
}

main().catch(err => {
  console.error('[eval] fatal:', err)
  process.exit(1)
})
```

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add eval/companion/run.ts
git commit -m "feat(eval): CLI runner — loads trajectories, picks judge, writes report"
```

---

## Task 15: First trajectory — `tech_stress_followup_v1.yaml`

**Files:**
- Create: `eval/companion/trajectories/tech_stress_followup_v1.yaml`

A canonical "work follow-up" scenario: user complains about a 504 incident → next morning the companion should ping with a recall-grounded check-in. This is content writing, not code — the file is the spec.

- [ ] **Step 1: Author the YAML**

Create `eval/companion/trajectories/tech_stress_followup_v1.yaml`:

```yaml
trajectory:
  id: tech_stress_followup_v1
  failure_mode: work_followup
  description: |
    User vents about a 504 incident around midnight. Next morning the companion
    has one push tick — should reference 504 + ask a short check-in question,
    not prescribe solutions. Demonstrates: cross-day recall + restraint.

  contact:
    chat_id: chat_test_1
    user_name: 顾时瑞
    persona: companion
    profile_md: |
      # 顾时瑞
      - 32 岁，后端工程师，负责一个交易系统
      - 偏好简短沟通；不喜欢被建议「要不要喝热水」式的话
    preferences_md: |
      # preferences
      - 工作日 9:30 之前不打扰
      - 不要技术建议；技术问题用户会自己处理
    initial_observations: []
    initial_memory_files: {}

  companion_config:
    enabled: true
    default_chat_id: chat_test_1
    quiet_hours_local: null

  events:
    # Night before — user vents
    - at: 2026-05-12T23:42:00+08:00
      kind: user_message
      text: "今晚 504 又来了，第三次。migration 还没回归我都不敢睡"

    - at: 2026-05-12T23:43:30+08:00
      kind: probe
      probe_kind: reactive_response
      expected:
        decision: send
        summary: "短，认可辛苦，不给技术建议"
        must_recall: []
        must_not_recall: ["建议", "可以试试", "为什么不"]
        tone_hints: ["共情但简短", "不开处方"]
        state_predicates: []
      dimensions: [calibration, restraint]

    # Next morning — push tick (jitter cancelled by SAFE_INFINITY scheduler)
    - at: 2026-05-13T09:30:00+08:00
      kind: tick
      tick_kind: push

    - at: 2026-05-13T09:30:30+08:00
      kind: probe
      probe_kind: proactive_decision
      expected:
        decision: send
        summary: "可以问一下 migration 之后稳了没 / 昨晚睡好没"
        must_recall: ["504"]
        must_not_recall: ["抑郁", "建议"]
        tone_hints: ["不要叫人‘加油’", "短"]
        state_predicates:
          - { kind: observation_body_matches, pattern: "504" }
      dimensions: [recall, calibration, initiative, restraint]
```

- [ ] **Step 2: Smoke-load it**

```bash
bun -e "import { loadTrajectory } from './eval/companion/engine/trajectory'; const t = loadTrajectory('./eval/companion/trajectories/tech_stress_followup_v1.yaml'); console.log('id=' + t.id + ' events=' + t.events.length)"
```

Expected: `id=tech_stress_followup_v1 events=4`.

- [ ] **Step 3: Commit**

```bash
git add eval/companion/trajectories/tech_stress_followup_v1.yaml
git commit -m "test(eval): trajectory tech_stress_followup_v1 (work_followup)"
```

---

## Task 16: Second trajectory — `emotional_care_v1.yaml`

**Files:**
- Create: `eval/companion/trajectories/emotional_care_v1.yaml`

`emotional_care` failure mode — user surfaces emotion, the companion must respond warmly without prescribing.

- [ ] **Step 1: Author the YAML**

Create `eval/companion/trajectories/emotional_care_v1.yaml`:

```yaml
trajectory:
  id: emotional_care_v1
  failure_mode: emotional_care
  description: |
    User mentions a fight with a friend. The companion should acknowledge
    feeling first, ask one open question, not jump to "you should..." or
    "have you tried...". Demonstrates: emotional restraint + warmth.

  contact:
    chat_id: chat_test_2
    user_name: 顾时瑞
    persona: companion
    profile_md: |
      # 顾时瑞
      - 不喜欢被劝
      - 朋友圈不大，跟我聊往往是想被听见
    preferences_md: |
      # preferences
      - 情绪话题不要给方法论；先共情
    initial_observations: []
    initial_memory_files: {}

  companion_config:
    enabled: true
    default_chat_id: chat_test_2
    quiet_hours_local: null

  events:
    - at: 2026-05-20T22:10:00+08:00
      kind: user_message
      text: "刚跟阿明吵了一架，挂了电话很烦。说不清谁对谁错"

    - at: 2026-05-20T22:10:45+08:00
      kind: probe
      probe_kind: reactive_response
      expected:
        decision: send
        summary: "承认烦，不评判对错，不给方法"
        must_recall: []
        must_not_recall: ["你应该", "可以试试", "建议", "其实他"]
        tone_hints: ["共情", "短", "可以问一句开放性的"]
        state_predicates: []
      dimensions: [calibration, inference, restraint]

    # Next-morning push — should NOT bring up the fight again unprompted
    - at: 2026-05-21T10:00:00+08:00
      kind: tick
      tick_kind: push

    - at: 2026-05-21T10:00:30+08:00
      kind: probe
      probe_kind: proactive_decision
      expected:
        decision: silent
        summary: "情绪话题已经收尾，没有新信号；不主动打扰"
        must_recall: []
        must_not_recall: []
        tone_hints: []
        state_predicates:
          - { kind: outbox_count_at_chat, eq: 1 }
      dimensions: [restraint, initiative]
```

- [ ] **Step 2: Smoke-load**

```bash
bun -e "import { loadTrajectory } from './eval/companion/engine/trajectory'; const t = loadTrajectory('./eval/companion/trajectories/emotional_care_v1.yaml'); console.log('id=' + t.id + ' events=' + t.events.length)"
```

Expected: `id=emotional_care_v1 events=4`.

- [ ] **Step 3: Commit**

```bash
git add eval/companion/trajectories/emotional_care_v1.yaml
git commit -m "test(eval): trajectory emotional_care_v1 (emotional_care)"
```

---

## Task 17: README + judge config docs

**Files:**
- Modify: `eval/companion/README.md`

- [ ] **Step 1: Write the README**

Overwrite `eval/companion/README.md`:

````markdown
# Companion Eval Harness

Regression-test infrastructure for the companion (`docs/superpowers/specs/2026-05-21-companion-eval-harness-design.md`). Re-run scripted multi-day user trajectories against a real daemon + real SDK subprocesses; get a markdown report.

## Run

```bash
bun run eval:companion                                # all trajectories
bun run eval:companion --trajectory tech_stress_followup_v1   # one
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

- Remaining 6 failure modes (cross_domain_mixing, fact_update_supersede, wrong_inference_correction, explicit_quiet, long_silence_initiative, multi_persona_isolation)
- Multi-seed judge averaging, pairwise blind comparison
- CI integration — explicit manual run only
- Codex / Anthropic-API judge backends (interfaces exist; bodies throw)

See the spec for the rationale on each.
````

- [ ] **Step 2: Commit**

```bash
git add eval/companion/README.md
git commit -m "docs(eval): README — run / cost / add-a-trajectory / interpret report"
```

---

## Task 18: Acceptance run

**Files:** None (verification only)

End-to-end smoke run against both trajectories. This task fails fast on any wiring bug and is the gate before claiming MVP done.

- [ ] **Step 1: Verify dependencies are installed**

Run: `bun install`
Expected: clean install; `yaml` resolved.

- [ ] **Step 2: Smoke-load both trajectories**

```bash
bun -e "import { loadTrajectory } from './eval/companion/engine/trajectory'; ['tech_stress_followup_v1','emotional_care_v1'].forEach(id => { const t = loadTrajectory('./eval/companion/trajectories/' + id + '.yaml'); console.log(id, 'OK', t.events.length, 'events') })"
```

Expected: both lines print `OK N events`.

- [ ] **Step 3: Run the engine's own unit tests**

```bash
bun --bun vitest run eval/companion/ --exclude ''
```

Expected: trajectory + clock + snapshot + assertions tests all pass.

- [ ] **Step 4: Acceptance run — `tech_stress_followup_v1`**

```bash
bun run eval:companion --trajectory tech_stress_followup_v1
```

Verify:
- Process exits 0.
- `eval/companion/runs/<ts>/report.md` exists.
- Report contains both probes from the trajectory.
- Engine assertions printed (✅ or ❌ — don't worry about which yet; the goal is "the pipeline runs end-to-end").

If it crashes — fix the bug, don't paper over it.

- [ ] **Step 5: Acceptance run — `emotional_care_v1`**

```bash
bun run eval:companion --trajectory emotional_care_v1
```

Same checks as Step 4.

- [ ] **Step 6: Acceptance run — both, no filter**

```bash
bun run eval:companion
```

Expected: both trajectories in the same report; summary row shows `2 trajectories · 4 probes`.

- [ ] **Step 7: Noise-floor check (optional but recommended)**

Run the suite twice and diff the reports:

```bash
bun run eval:companion && cp eval/companion/runs/$(ls -1t eval/companion/runs | head -1)/report.md /tmp/run1.md
bun run eval:companion && cp eval/companion/runs/$(ls -1t eval/companion/runs | head -1)/report.md /tmp/run2.md
diff /tmp/run1.md /tmp/run2.md | head -50
```

Expected: per-dimension scores swing within ±2. Wider swings → flag in the PR description; either acceptable noise or judge prompt needs tightening (defer to a follow-up).

- [ ] **Step 8: Final commit (catch-all)**

If any small fixes accumulated during the acceptance run that aren't covered by an earlier commit:

```bash
git status
git add <files>
git commit -m "fix(eval): <what>"
```

---

## Acceptance gate

MVP is done when all of these are true:

- [ ] `bun run eval:companion --trajectory tech_stress_followup_v1` boots a daemon, drives events, writes `runs/<ts>/report.md` without crashing
- [ ] Same for `emotional_care_v1`
- [ ] Engine behavior is deterministic given identical model outputs (snapshot/assert logic itself adds no noise)
- [ ] Repeated runs (no code change) show judge dimension scores within ±2 per probe
- [ ] Both trajectories have ≥1 `proactive_decision` probe and ≥1 `reactive_response` probe with filled `expected` blocks
- [ ] README documents how to add a trajectory, judge config, report interpretation, expected wall time

## Self-review notes (for the executing engineer)

- If `bun --bun vitest run eval/companion/...` skips files because of the exclude, pass `--exclude ''` to override the config's exclude list for that run. Don't permanently remove the exclude from `vitest.config.ts` — eval tests are too slow for the default suite.
- If `replay()` hangs waiting for `waitForReplyTo`, the 120s default timeout will fire. The shim returns `{ error: 'timeout' }` and replay continues — by design.
- The daemon-shim hard-codes `schedulerIntervalMs: SAFE_INFINITY_MS`. If you see the companion firing ticks the engine didn't ask for, the override isn't propagating — re-verify Task 2's wiring chain.
- The PR D push-tick guard (`isInFlight` check) is in `tick-bodies.ts`. fireTick goes through the same code path, so if a user_message dispatch is still in flight when fireTick('push') is called, the push will be skipped + logged. For trajectories, sequence events so user_message replies complete before any tick (the engine already awaits `waitForReplyTo`, so this is automatic for serial trajectories).
- If a trajectory references a file path that doesn't exist in `initial_memory_files` (e.g. `notes/migration.md`), the engine creates parent dirs — but it does NOT validate that paths are inside the chat's memory dir. Don't put `../` in keys.
