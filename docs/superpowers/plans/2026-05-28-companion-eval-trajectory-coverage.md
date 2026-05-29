# Companion Eval — Trajectory Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring companion eval failure-mode coverage from 2 → 8 trajectories, plus a backward-compatible multi-contact engine change so cross-chat isolation can be expressed.

**Architecture:** Five new trajectories are pure YAML on the existing single-`contact` schema. The sixth (`cross_chat_isolation`) needs two chats, so the trajectory schema gains an optional `contacts: []` form (singular `contact:` is normalized to a one-element list at load), events gain an optional `chat:` selector, and `replay.ts` is de-singularized to seed/route/snapshot per contact. The stale `multi_persona_isolation` failure mode is renamed `cross_chat_isolation`. All pure logic (normalization, chat resolution) lives in load-time helpers that are unit-tested; `replay.ts` (which boots a real daemon) is verified by typecheck + smoke-load.

**Tech Stack:** TypeScript, Bun, zod v4 (default import), vitest, YAML. Spec: `docs/superpowers/specs/2026-05-28-companion-eval-trajectory-coverage-design.md`.

**Test commands:**
- Engine unit tests: `bun --bun vitest run -c vitest.eval-engine.config.ts eval/companion/engine/trajectory.test.ts`
- Typecheck: `bun x tsc --noEmit`
- Smoke-load a trajectory: `bun -e "import { loadTrajectory } from './eval/companion/engine/trajectory'; loadTrajectory('./eval/companion/trajectories/<file>.yaml'); console.log('ok')"`
- Full run (manual acceptance, real SDK, ~30–60s/event): `bun run eval:companion --trajectory <id>`

---

## Task 1: Rename failure mode `multi_persona_isolation` → `cross_chat_isolation`

**Files:**
- Modify: `eval/companion/engine/trajectory.ts:7-16` (`FAILURE_MODES`)
- Modify: `eval/companion/engine/trajectory.test.ts` (add rename assertions)
- Modify: `eval/companion/README.md` ("What's NOT in MVP" list)

- [ ] **Step 1: Write the failing test**

Add to `eval/companion/engine/trajectory.test.ts` inside the `describe('loadTrajectory', ...)` block:

```typescript
  it('accepts the renamed cross_chat_isolation failure mode', () => {
    const yaml = MINIMAL_YAML.replace('failure_mode: work_followup', 'failure_mode: cross_chat_isolation')
    const dir = mkdtempSync(join(tmpdir(), 'traj-test-'))
    const path = join(dir, 'rename.yaml')
    writeFileSync(path, yaml)
    try {
      const t = loadTrajectory(path)
      expect(t.failure_mode).toBe('cross_chat_isolation')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('rejects the old multi_persona_isolation name', () => {
    const yaml = MINIMAL_YAML.replace('failure_mode: work_followup', 'failure_mode: multi_persona_isolation')
    const dir = mkdtempSync(join(tmpdir(), 'traj-test-'))
    const path = join(dir, 'oldname.yaml')
    writeFileSync(path, yaml)
    try {
      expect(() => loadTrajectory(path)).toThrow(/failure_mode/)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun --bun vitest run -c vitest.eval-engine.config.ts eval/companion/engine/trajectory.test.ts`
Expected: FAIL — `accepts the renamed cross_chat_isolation` throws (mode not in enum yet).

- [ ] **Step 3: Rename in the enum**

In `eval/companion/engine/trajectory.ts`, change the `FAILURE_MODES` array entry:

```typescript
const FAILURE_MODES = [
  'work_followup',
  'emotional_care',
  'cross_domain_mixing',
  'fact_update_supersede',
  'wrong_inference_correction',
  'explicit_quiet',
  'long_silence_initiative',
  'cross_chat_isolation',
] as const
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun --bun vitest run -c vitest.eval-engine.config.ts eval/companion/engine/trajectory.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Update the README "What's NOT in MVP" list**

In `eval/companion/README.md`, in the `## What's NOT in MVP` section, change the failure-mode line so `multi_persona_isolation` reads `cross_chat_isolation`:

```markdown
- Remaining 6 failure modes (cross_domain_mixing, fact_update_supersede, wrong_inference_correction, explicit_quiet, long_silence_initiative, cross_chat_isolation)
```

- [ ] **Step 6: Confirm zero residual references to the old name**

Run: `grep -rn "multi_persona_isolation" eval/ docs/`
Expected: no matches (the spec already uses the new name in its definition table; if any historical doc reference remains, leave docs/specs/*harness-design* as-is since it is a historical record, but `eval/` must be clean).

- [ ] **Step 7: Commit**

```bash
git add eval/companion/engine/trajectory.ts eval/companion/engine/trajectory.test.ts eval/companion/README.md
git commit -m "refactor(eval): rename multi_persona_isolation -> cross_chat_isolation"
```

---

## Task 2: Multi-contact schema + normalization + per-event chat targeting

**Files:**
- Modify: `eval/companion/engine/trajectory.ts` (event schemas, trajectory schema → input schema + normalized output type, `loadTrajectory`, new `resolveEventChat` export)
- Modify: `eval/companion/engine/trajectory.test.ts` (normalization + chat-resolution tests)

- [ ] **Step 1: Write the failing tests**

Add to `eval/companion/engine/trajectory.test.ts`. Also add a `MULTI_CONTACT_YAML` constant near `MINIMAL_YAML`:

```typescript
const MULTI_CONTACT_YAML = `
trajectory:
  id: multi_v1
  failure_mode: cross_chat_isolation
  description: two contacts
  contacts:
    - chat_id: chat_a
      user_name: 顾时瑞
      persona: companion
      profile_md: "# a"
      preferences_md: "# a-prefs"
      initial_observations: []
      initial_memory_files: {}
    - chat_id: chat_b
      user_name: 旺仔
      persona: companion
      profile_md: "# b"
      preferences_md: "# b-prefs"
      initial_observations: []
      initial_memory_files: {}
  companion_config:
    enabled: true
    default_chat_id: chat_a
    quiet_hours_local: null
  events:
    - at: 2026-05-13T09:30:00+08:00
      kind: user_message
      chat: chat_b
      text: hi from b
    - at: 2026-05-13T09:30:30+08:00
      kind: probe
      chat: chat_b
      probe_kind: reactive_response
      expected:
        decision: send
        summary: x
        must_recall: []
        must_not_recall: []
        tone_hints: []
        state_predicates: []
      dimensions: [restraint]
`

describe('multi-contact', () => {
  function load(yaml: string) {
    const dir = mkdtempSync(join(tmpdir(), 'traj-test-'))
    const path = join(dir, 't.yaml')
    writeFileSync(path, yaml)
    try { return loadTrajectory(path) } finally { rmSync(dir, { recursive: true, force: true }) }
  }

  it('normalizes singular contact to a one-element contacts list', () => {
    const t = load(MINIMAL_YAML)
    expect(t.contacts).toHaveLength(1)
    expect(t.contacts[0]!.chat_id).toBe('chat_test_1')
    expect(t.primaryChatId).toBe('chat_test_1')
  })

  it('parses an explicit contacts list and sets primaryChatId to the first', () => {
    const t = load(MULTI_CONTACT_YAML)
    expect(t.contacts.map(c => c.chat_id)).toEqual(['chat_a', 'chat_b'])
    expect(t.primaryChatId).toBe('chat_a')
  })

  it('rejects a trajectory with neither contact nor contacts', () => {
    const yaml = MINIMAL_YAML.replace(/  contact:[\s\S]*?initial_memory_files: \{\}\n/, '')
    expect(() => load(yaml)).toThrow(/exactly one of/)
  })

  it('rejects a trajectory with both contact and contacts', () => {
    const both = MULTI_CONTACT_YAML.replace(
      '  contacts:',
      '  contact:\n    chat_id: dup\n    user_name: d\n    persona: companion\n    profile_md: "#"\n    preferences_md: "#"\n    initial_observations: []\n    initial_memory_files: {}\n  contacts:',
    )
    expect(() => load(both)).toThrow(/exactly one of/)
  })

  it('rejects an event referencing an unknown chat', () => {
    const bad = MULTI_CONTACT_YAML.replace('chat: chat_b\n      text: hi from b', 'chat: chat_zzz\n      text: hi from b')
    expect(() => load(bad)).toThrow(/unknown chat/)
  })

  it('resolveEventChat falls back to primary when chat omitted', () => {
    const t = load(MINIMAL_YAML)
    expect(resolveEventChat(t.events[0]!, t.primaryChatId)).toBe('chat_test_1')
  })

  it('resolveEventChat returns the event chat when present', () => {
    const t = load(MULTI_CONTACT_YAML)
    expect(resolveEventChat(t.events[0]!, t.primaryChatId)).toBe('chat_b')
  })
})
```

Update the import at the top of the test file to include `resolveEventChat`:

```typescript
import { loadTrajectory, resolveEventChat } from './trajectory'
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun --bun vitest run -c vitest.eval-engine.config.ts eval/companion/engine/trajectory.test.ts`
Expected: FAIL — `resolveEventChat` not exported, `t.contacts` / `t.primaryChatId` undefined.

- [ ] **Step 3: Add `chat` to each event schema**

In `eval/companion/engine/trajectory.ts`, add `chat: z.string().optional()` to all three event schemas:

```typescript
const UserMessageEventSchema = z.object({
  at: z.string(),
  kind: z.literal('user_message'),
  chat: z.string().optional(),
  text: z.string(),
})

const TickEventSchema = z.object({
  at: z.string(),
  kind: z.literal('tick'),
  chat: z.string().optional(),
  tick_kind: z.enum(['push', 'introspect']),
})

const ProbeEventSchema = z.object({
  at: z.string(),
  kind: z.literal('probe'),
  chat: z.string().optional(),
  probe_kind: z.enum(['reactive_response', 'proactive_decision', 'memory_recall', 'state_inspect']),
  ask: z.string().optional(),
  expected: ExpectedSchema,
  dimensions: z.array(z.enum(DIMENSIONS)).default([]),
})
```

- [ ] **Step 4: Replace `TrajectorySchema` with an input schema + normalized output type**

In `eval/companion/engine/trajectory.ts`, replace the `TrajectorySchema` definition and the `Trajectory` type export. Delete:

```typescript
const TrajectorySchema = z.object({
  id: z.string(),
  failure_mode: z.enum(FAILURE_MODES),
  description: z.string(),
  contact: ContactSchema,
  companion_config: CompanionConfigSchema,
  events: z.array(EventSchema),
})

export type Trajectory = z.infer<typeof TrajectorySchema>
```

Replace with:

```typescript
const TrajectoryInputSchema = z
  .object({
    id: z.string(),
    failure_mode: z.enum(FAILURE_MODES),
    description: z.string(),
    contact: ContactSchema.optional(),
    contacts: z.array(ContactSchema).min(1).optional(),
    companion_config: CompanionConfigSchema,
    events: z.array(EventSchema),
  })
  .refine(d => (d.contact === undefined) !== (d.contacts === undefined), {
    message: 'trajectory must have exactly one of `contact` or `contacts`',
  })

export type Contact = z.infer<typeof ContactSchema>

/** Normalized trajectory: always a `contacts` list, with the primary chat id resolved. */
export interface Trajectory {
  id: string
  failure_mode: (typeof FAILURE_MODES)[number]
  description: string
  contacts: Contact[]
  primaryChatId: string
  companion_config: z.infer<typeof CompanionConfigSchema>
  events: TrajectoryEvent[]
}
```

Note: keep the existing `export type TrajectoryEvent`, `TrajectoryProbe`, `TrajectoryExpected`, `StatePredicate` lines unchanged.

- [ ] **Step 5: Rewrite `loadTrajectory` to normalize + validate event chats, and add `resolveEventChat`**

Replace the existing `loadTrajectory` function body in `eval/companion/engine/trajectory.ts`:

```typescript
export function loadTrajectory(path: string): Trajectory {
  const raw = parseYaml(readFileSync(path, 'utf8')) as unknown
  if (typeof raw !== 'object' || raw === null || !('trajectory' in raw)) {
    throw new Error(`loadTrajectory(${path}): missing top-level 'trajectory' key`)
  }
  const parsed = TrajectoryInputSchema.safeParse((raw as { trajectory: unknown }).trajectory)
  if (!parsed.success) {
    throw new Error(`loadTrajectory(${path}): ${parsed.error.message}`)
  }
  const d = parsed.data
  const contacts = d.contacts ?? [d.contact!]
  const primaryChatId = contacts[0]!.chat_id
  const knownChats = new Set(contacts.map(c => c.chat_id))
  for (const ev of d.events) {
    if (ev.chat !== undefined && !knownChats.has(ev.chat)) {
      throw new Error(`loadTrajectory(${path}): event at ${ev.at} references unknown chat '${ev.chat}'`)
    }
  }
  return {
    id: d.id,
    failure_mode: d.failure_mode,
    description: d.description,
    contacts,
    primaryChatId,
    companion_config: d.companion_config,
    events: d.events,
  }
}

/** Resolve which chat an event targets: explicit `chat:` or the trajectory's primary contact. */
export function resolveEventChat(event: TrajectoryEvent, primaryChatId: string): string {
  return event.chat ?? primaryChatId
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun --bun vitest run -c vitest.eval-engine.config.ts eval/companion/engine/trajectory.test.ts`
Expected: PASS (all tests, including Task 1's).

- [ ] **Step 7: Commit**

```bash
git add eval/companion/engine/trajectory.ts eval/companion/engine/trajectory.test.ts
git commit -m "feat(eval): multi-contact trajectory schema + per-event chat targeting"
```

---

## Task 3: De-singularize `replay.ts` + `probes.ts`

**Files:**
- Modify: `eval/companion/engine/replay.ts` (`ReplayContext`, `replay`, `seedMemoryFiles`, `seedObservations`)
- Modify: `eval/companion/engine/probes.ts` (resolve probe chat; per-chat last reply/tick)

No new unit test (these boot a real daemon). Verification = `tsc --noEmit` + smoke-load of the two existing MVP trajectories (their replay paths must still typecheck and parse).

- [ ] **Step 1: Update `ReplayContext` to track per-chat state**

In `eval/companion/engine/replay.ts`, replace the `ReplayContext` interface:

```typescript
export interface ReplayContext {
  trajectory: Trajectory
  daemon: EvalDaemon
  primaryChatId: string
  lastUserMessageReply: Record<string, { text?: string; error?: string }>
  lastTickOutcome: Record<string, { decision: 'send' | 'silent'; text?: string }>
}
```

- [ ] **Step 2: Add the `resolveEventChat` import**

In `eval/companion/engine/replay.ts`, update the trajectory import:

```typescript
import type { Trajectory } from './trajectory'
import { resolveEventChat } from './trajectory'
```

(Keep the existing `import { parseIso } from './clock'` etc. unchanged.)

- [ ] **Step 3: Rewrite the `replay` function body**

Replace the `replay` function in `eval/companion/engine/replay.ts` with:

```typescript
export async function replay(trajectory: Trajectory, opts: ReplayOpts): Promise<EventResult[]> {
  const daemon = await startEvalDaemon({
    knownUsers: Object.fromEntries(trajectory.contacts.map(c => [c.chat_id, c.user_name])),
    companion: {
      enabled: trajectory.companion_config.enabled,
      default_chat_id: trajectory.companion_config.default_chat_id,
    },
  })

  try {
    for (const contact of trajectory.contacts) {
      seedMemoryFiles(daemon.stateDir, contact)
      seedObservations(daemon.stateDir, contact)
    }

    const ctx: ReplayContext = {
      trajectory, daemon,
      primaryChatId: trajectory.primaryChatId,
      lastUserMessageReply: {},
      lastTickOutcome: {},
    }
    const results: EventResult[] = []

    for (let i = 0; i < trajectory.events.length; i++) {
      const event = trajectory.events[i]!
      const result: EventResult = { index: i, event }
      const chatId = resolveEventChat(event, trajectory.primaryChatId)

      try {
        if (event.kind === 'user_message') {
          daemon.sendText(chatId, event.text, { createTimeMs: parseIso(event.at).getTime() })
          const outboxBefore = daemon.outboundFor(chatId).length
          try {
            await daemon.waitForReplyTo(chatId, 120_000)
            const newOnes = daemon.outboundFor(chatId).slice(outboxBefore)
            const lastNew = newOnes[newOnes.length - 1]
            ctx.lastUserMessageReply[chatId] = { text: lastNew?.text ?? '' }
          } catch (err) {
            ctx.lastUserMessageReply[chatId] = { error: err instanceof Error ? err.message : String(err) }
          }
        } else if (event.kind === 'tick') {
          const outboxBefore = daemon.outboundFor(chatId).length
          await daemon.daemonHandle.fireTick(event.tick_kind, parseIso(event.at))
          const newOnes = daemon.outboundFor(chatId).slice(outboxBefore)
          ctx.lastTickOutcome[chatId] = newOnes.length > 0
            ? { decision: 'send', ...(newOnes[newOnes.length - 1]?.text !== undefined ? { text: newOnes[newOnes.length - 1]!.text! } : {}) }
            : { decision: 'silent' }
        } else if (event.kind === 'probe') {
          result.actual = await captureProbe(event, ctx)
        }
      } catch (err) {
        result.actual = { kind: 'state', error: err instanceof Error ? err.message : String(err) }
      }

      const db = openDb({ path: join(daemon.stateDir, 'wechat-cc.db') })
      try {
        const snap = await captureSnapshot({
          stateDir: daemon.stateDir, db, chatId, ilink: daemon.ilink,
        })
        result.snapshot = snap
        if (event.kind === 'probe' && result.actual !== undefined) {
          result.assertions = runAssertions({
            expected: event.expected,
            actual: result.actual,
            snapshot: snap,
          })
          if (event.dimensions.length > 0) {
            try {
              result.judgeScores = await opts.judge.score({
                trajectoryHistoryToProbe: renderHistoryToIndex(trajectory, i),
                expected: event.expected,
                actual: result.actual,
                dimensions: event.dimensions,
              })
            } catch (err) {
              result.judgeScores = []
              result.assertions = [
                ...result.assertions,
                { label: 'judge_error', passed: false, detail: err instanceof Error ? err.message : String(err) },
              ]
            }
          }
        }
      } finally { db.close() }

      results.push(result)
    }

    return results
  } finally {
    await daemon.stop()
  }
}
```

- [ ] **Step 4: Rewrite `seedMemoryFiles` and `seedObservations` to take a single contact**

Replace both functions at the bottom of `eval/companion/engine/replay.ts`:

```typescript
function seedMemoryFiles(stateDir: string, contact: Trajectory['contacts'][number]): void {
  const dir = join(stateDir, 'memory', contact.chat_id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'profile.md'), contact.profile_md)
  writeFileSync(join(dir, 'preferences.md'), contact.preferences_md)
  for (const [rel, content] of Object.entries(contact.initial_memory_files)) {
    const target = join(dir, rel)
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, content)
  }
}

function seedObservations(stateDir: string, contact: Trajectory['contacts'][number]): void {
  if (contact.initial_observations.length === 0) return
  const db = openDb({ path: join(stateDir, 'wechat-cc.db') })
  try {
    const store = makeObservationsStore(db, contact.chat_id)
    for (const obs of contact.initial_observations) {
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
```

(`renderHistoryToIndex` is unchanged — leave it as-is.)

- [ ] **Step 5: Update `probes.ts` to resolve the probe's chat and read per-chat state**

Replace the body of `captureProbe` in `eval/companion/engine/probes.ts`:

```typescript
export async function captureProbe(
  event: Extract<Trajectory['events'][number], { kind: 'probe' }>,
  ctx: ReplayContext,
): Promise<ProbeActual> {
  const chatId = event.chat ?? ctx.primaryChatId
  switch (event.probe_kind) {
    case 'reactive_response': {
      const r = ctx.lastUserMessageReply[chatId]
      if (!r) return { kind: 'reply', error: 'no prior user_message in this chat' }
      if (r.error !== undefined) return { kind: 'reply', error: r.error }
      return { kind: 'reply', text: r.text ?? '' }
    }
    case 'proactive_decision': {
      const t = ctx.lastTickOutcome[chatId]
      if (!t) return { kind: 'tick_outcome', error: 'no prior tick in this chat' }
      return {
        kind: 'tick_outcome',
        decision: t.decision,
        ...(t.text !== undefined ? { text: t.text } : {}),
      }
    }
    case 'memory_recall': {
      if (!event.ask) return { kind: 'reply', error: 'memory_recall probe requires ask:' }
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
      return { kind: 'state' }
  }
}
```

- [ ] **Step 6: Typecheck**

Run: `bun x tsc --noEmit`
Expected: clean (no errors). If `eval/**` is excluded from the root tsconfig, also run `bun build eval/companion/run.ts --target=bun --outfile=/dev/null` to force type resolution of the changed files; expected: builds without type errors.

- [ ] **Step 7: Smoke-load both existing MVP trajectories**

Run:
```bash
bun -e "import { loadTrajectory } from './eval/companion/engine/trajectory'; for (const f of ['tech_stress_followup_v1','emotional_care_v1']) { loadTrajectory('./eval/companion/trajectories/'+f+'.yaml'); console.log(f, 'ok') }"
```
Expected: prints `tech_stress_followup_v1 ok` and `emotional_care_v1 ok`.

- [ ] **Step 8: Run the existing engine unit tests (regression)**

Run: `bun --bun vitest run -c vitest.eval-engine.config.ts eval/companion/engine/`
Expected: PASS (trajectory / assertions / snapshot / clock tests).

- [ ] **Step 9: Commit**

```bash
git add eval/companion/engine/replay.ts eval/companion/engine/probes.ts
git commit -m "feat(eval): de-singularize replay/probes for multi-contact trajectories"
```

---

## Task 4: Trajectory — `cross_domain_mixing`

**Files:**
- Create: `eval/companion/trajectories/cross_domain_mixing_v1.yaml`

- [ ] **Step 1: Write the trajectory**

```yaml
trajectory:
  id: cross_domain_mixing_v1
  failure_mode: cross_domain_mixing
  description: |
    One message blends a work win and a personal logistics item. The companion
    should respond naturally to both — fluidly being helper and listener at once
    — without announcing a "switch", bulleting, or lecturing. Positive case for
    the one-fluid-companion design.

  contact:
    chat_id: chat_mix_1
    user_name: 顾时瑞
    persona: companion
    profile_md: |
      # 顾时瑞
      - 后端工程师；偏好简短自然的沟通
      - 不喜欢被分点说教
    preferences_md: |
      # preferences
      - 不要把回复拆成"关于工作 / 关于生活"两段
    initial_observations: []
    initial_memory_files: {}

  companion_config:
    enabled: true
    default_chat_id: chat_mix_1
    quiet_hours_local: null

  events:
    - at: 2026-05-20T19:30:00+08:00
      kind: user_message
      text: "今天上线终于过了，松一口气。对了我妈下周来住几天，得收拾下屋子"

    - at: 2026-05-20T19:30:45+08:00
      kind: probe
      probe_kind: reactive_response
      expected:
        decision: send
        summary: "自然接住上线的轻松 + 妈妈来访两件事，不生硬分模块/分点"
        must_recall: []
        must_not_recall: ["首先", "其次", "关于工作", "关于生活", "第一", "第二"]
        tone_hints: ["自然", "像朋友顺着聊", "不要分点说教"]
        state_predicates: []
      dimensions: [calibration, restraint]
```

- [ ] **Step 2: Smoke-load**

Run: `bun -e "import { loadTrajectory } from './eval/companion/engine/trajectory'; loadTrajectory('./eval/companion/trajectories/cross_domain_mixing_v1.yaml'); console.log('ok')"`
Expected: prints `ok`.

- [ ] **Step 3: Commit**

```bash
git add eval/companion/trajectories/cross_domain_mixing_v1.yaml
git commit -m "test(eval): cross_domain_mixing trajectory"
```

---

## Task 5: Trajectory — `fact_update_supersede`

**Files:**
- Create: `eval/companion/trajectories/fact_update_supersede_v1.yaml`

- [ ] **Step 1: Write the trajectory**

```yaml
trajectory:
  id: fact_update_supersede_v1
  failure_mode: fact_update_supersede
  description: |
    A fact is stated, then later superseded. A recall probe must reflect the new
    fact (mysql), not the stale one (postgres). The recall-probe reply text is the
    objective signal — no memory_file_matches predicate, because the companion
    chooses which .md file to write the fact into.

  contact:
    chat_id: chat_fact_1
    user_name: 顾时瑞
    persona: companion
    profile_md: |
      # 顾时瑞
      - 后端工程师
    preferences_md: |
      # preferences
      - 简短
    initial_observations: []
    initial_memory_files: {}

  companion_config:
    enabled: true
    default_chat_id: chat_fact_1
    quiet_hours_local: null

  events:
    - at: 2026-05-18T14:00:00+08:00
      kind: user_message
      text: "我们这套服务现在用 postgres"

    - at: 2026-05-19T14:00:00+08:00
      kind: user_message
      text: "数据库迁到 mysql 了，postgres 弃用了"

    - at: 2026-05-19T14:01:00+08:00
      kind: probe
      probe_kind: memory_recall
      ask: "我们现在用什么数据库？"
      expected:
        decision: send
        summary: "回答 mysql，不再说 postgres 是当前在用的"
        must_recall: ["mysql"]
        must_not_recall: ["postgres"]
        tone_hints: ["直接"]
        state_predicates: []
      dimensions: [recall, calibration]
```

- [ ] **Step 2: Smoke-load**

Run: `bun -e "import { loadTrajectory } from './eval/companion/engine/trajectory'; loadTrajectory('./eval/companion/trajectories/fact_update_supersede_v1.yaml'); console.log('ok')"`
Expected: prints `ok`.

- [ ] **Step 3: Commit**

```bash
git add eval/companion/trajectories/fact_update_supersede_v1.yaml
git commit -m "test(eval): fact_update_supersede trajectory"
```

---

## Task 6: Trajectory — `wrong_inference_correction`

**Files:**
- Create: `eval/companion/trajectories/wrong_inference_correction_v1.yaml`

- [ ] **Step 1: Write the trajectory**

```yaml
trajectory:
  id: wrong_inference_correction_v1
  failure_mode: wrong_inference_correction
  description: |
    The user vents in a way that invites a wrong inference ("again working late"),
    then explicitly corrects it ("I actually like this project, it's voluntary").
    The reply must accept the correction; a later push must not regress to the
    "he's stressed / unwilling" inference.

  contact:
    chat_id: chat_infer_1
    user_name: 顾时瑞
    persona: companion
    profile_md: |
      # 顾时瑞
      - 后端工程师
    preferences_md: |
      # preferences
      - 不要假设我的情绪；问，别替我下结论
    initial_observations: []
    initial_memory_files: {}

  companion_config:
    enabled: true
    default_chat_id: chat_infer_1
    quiet_hours_local: null

  events:
    - at: 2026-05-15T22:00:00+08:00
      kind: user_message
      text: "又要加班到很晚了"

    - at: 2026-05-15T22:02:00+08:00
      kind: user_message
      text: "其实我挺喜欢这个项目的，加班是我自己要做的，别担心"

    - at: 2026-05-15T22:02:45+08:00
      kind: probe
      probe_kind: reactive_response
      expected:
        decision: send
        summary: "接受更正，不再假设他压力大/不情愿"
        must_recall: []
        must_not_recall: ["压力大", "不情愿", "辛苦了吗", "别太累"]
        tone_hints: ["接住他对项目的热情", "不要怜悯"]
        state_predicates: []
      dimensions: [inference, calibration, restraint]

    - at: 2026-05-16T10:00:00+08:00
      kind: tick
      tick_kind: push

    - at: 2026-05-16T10:00:30+08:00
      kind: probe
      probe_kind: proactive_decision
      expected:
        decision: n/a
        summary: "回归检查：若推送，不能回到'他压力大/不情愿'的错误推断"
        must_recall: []
        must_not_recall: ["压力大", "不情愿"]
        tone_hints: []
        state_predicates: []
      dimensions: [recall, inference]
```

- [ ] **Step 2: Smoke-load**

Run: `bun -e "import { loadTrajectory } from './eval/companion/engine/trajectory'; loadTrajectory('./eval/companion/trajectories/wrong_inference_correction_v1.yaml'); console.log('ok')"`
Expected: prints `ok`.

- [ ] **Step 3: Commit**

```bash
git add eval/companion/trajectories/wrong_inference_correction_v1.yaml
git commit -m "test(eval): wrong_inference_correction trajectory"
```

> Note on the second probe's `decision: n/a` — the push decision (send vs silent) is not what this mode tests; the regression guard is purely `must_not_recall`. `decision: n/a` skips the decision assertion (see `assertions.ts` — `if (input.expected.decision !== 'n/a')`).

---

## Task 7: Trajectory — `explicit_quiet`

**Files:**
- Create: `eval/companion/trajectories/explicit_quiet_v1.yaml`

- [ ] **Step 1: Write the trajectory**

```yaml
trajectory:
  id: explicit_quiet_v1
  failure_mode: explicit_quiet
  description: |
    The user explicitly asks not to be pushed for a few days. The reply is a brief
    acknowledgment with no prying; the next push tick must be silent (outbox stays
    at 1 — only the acknowledgment).

  contact:
    chat_id: chat_quiet_1
    user_name: 顾时瑞
    persona: companion
    profile_md: |
      # 顾时瑞
      - 偏好简短沟通
    preferences_md: |
      # preferences
      - 说要安静就别追问原因
    initial_observations: []
    initial_memory_files: {}

  companion_config:
    enabled: true
    default_chat_id: chat_quiet_1
    quiet_hours_local: null

  events:
    - at: 2026-05-20T21:00:00+08:00
      kind: user_message
      text: "这几天别推我消息了，我想自己静静"

    - at: 2026-05-20T21:00:30+08:00
      kind: probe
      probe_kind: reactive_response
      expected:
        decision: send
        summary: "简短确认会安静，不追问发生了什么"
        must_recall: []
        must_not_recall: ["为什么", "发生什么", "怎么了", "出什么事"]
        tone_hints: ["简短", "尊重", "不追问"]
        state_predicates: []
      dimensions: [restraint, calibration]

    - at: 2026-05-21T10:00:00+08:00
      kind: tick
      tick_kind: push

    - at: 2026-05-21T10:00:30+08:00
      kind: probe
      probe_kind: proactive_decision
      expected:
        decision: silent
        summary: "用户明确要求安静；不推送"
        must_recall: []
        must_not_recall: []
        tone_hints: []
        state_predicates:
          - { kind: outbox_count_at_chat, eq: 1 }
      dimensions: [restraint, initiative]
```

- [ ] **Step 2: Smoke-load**

Run: `bun -e "import { loadTrajectory } from './eval/companion/engine/trajectory'; loadTrajectory('./eval/companion/trajectories/explicit_quiet_v1.yaml'); console.log('ok')"`
Expected: prints `ok`.

- [ ] **Step 3: Commit**

```bash
git add eval/companion/trajectories/explicit_quiet_v1.yaml
git commit -m "test(eval): explicit_quiet trajectory"
```

---

## Task 8: Trajectory — `long_silence_initiative`

**Files:**
- Create: `eval/companion/trajectories/long_silence_initiative_v1.yaml`

- [ ] **Step 1: Write the trajectory**

```yaml
trajectory:
  id: long_silence_initiative_v1
  failure_mode: long_silence_initiative
  description: |
    Designed around an open thread (an interview) so the expected decision is
    deterministic — a recall-driven check-in — rather than a coin-flip on the
    inherently-ambiguous "ping or wait". User mentions a Wednesday interview, then
    goes quiet ~7 days. The day-8 push should reference the interview and ask a
    light check-in, not guilt-trip the silence.

  contact:
    chat_id: chat_silence_1
    user_name: 顾时瑞
    persona: companion
    profile_md: |
      # 顾时瑞
      - 偏好简短沟通
    preferences_md: |
      # preferences
      - 不要因为我没回消息就阴阳怪气
    initial_observations: []
    initial_memory_files: {}

  companion_config:
    enabled: true
    default_chat_id: chat_silence_1
    quiet_hours_local: null

  events:
    - at: 2026-05-12T20:00:00+08:00
      kind: user_message
      text: "下周三有个面试，有点紧张"

    - at: 2026-05-12T20:00:30+08:00
      kind: probe
      probe_kind: reactive_response
      expected:
        decision: send
        summary: "简短鼓励，不灌鸡汤"
        must_recall: []
        must_not_recall: ["加油加油", "你一定行"]
        tone_hints: ["简短", "稳"]
        state_predicates: []
      dimensions: [calibration, restraint]

    - at: 2026-05-20T10:00:00+08:00
      kind: tick
      tick_kind: push

    - at: 2026-05-20T10:00:30+08:00
      kind: probe
      probe_kind: proactive_decision
      expected:
        decision: send
        summary: "面试过去了，轻轻问一句结果/感受；不抱怨他不回消息"
        must_recall: ["面试"]
        must_not_recall: ["你怎么不理我", "为什么不回", "好久没"]
        tone_hints: ["轻", "关心结果而非催促"]
        state_predicates: []
      dimensions: [recall, initiative, calibration, restraint]
```

- [ ] **Step 2: Smoke-load**

Run: `bun -e "import { loadTrajectory } from './eval/companion/engine/trajectory'; loadTrajectory('./eval/companion/trajectories/long_silence_initiative_v1.yaml'); console.log('ok')"`
Expected: prints `ok`.

- [ ] **Step 3: Commit**

```bash
git add eval/companion/trajectories/long_silence_initiative_v1.yaml
git commit -m "test(eval): long_silence_initiative trajectory"
```

---

## Task 9: Trajectory — `cross_chat_isolation` (multi-contact)

**Files:**
- Create: `eval/companion/trajectories/cross_chat_isolation_v1.yaml`

This is the only trajectory exercising the multi-contact engine change (Tasks 2–3).

- [ ] **Step 1: Write the trajectory**

```yaml
trajectory:
  id: cross_chat_isolation_v1
  failure_mode: cross_chat_isolation
  description: |
    Two different people, both the same fluid companion, on separate chats. A
    private fact 旺仔 states in chat_b ("breaking up") must NOT surface when the
    companion replies to 顾时瑞 in chat_a. The chat_b positive-control probe proves
    the fact was actually stored — without it the negative assertion is meaningless.
    Memory is keyed by chat_id, so a healthy run passes trivially; this is a
    regression guard against future mis-routing / cross-chat memory reads.

  contacts:
    - chat_id: chat_iso_a
      user_name: 顾时瑞
      persona: companion
      profile_md: |
        # 顾时瑞
        - 后端工程师
      preferences_md: |
        # preferences
        - 简短
      initial_observations: []
      initial_memory_files: {}
    - chat_id: chat_iso_b
      user_name: 旺仔
      persona: companion
      profile_md: |
        # 旺仔
        - 顾时瑞的朋友
      preferences_md: |
        # preferences
        - 喜欢被倾听
      initial_observations: []
      initial_memory_files: {}

  companion_config:
    enabled: true
    default_chat_id: chat_iso_a
    quiet_hours_local: null

  events:
    - at: 2026-05-20T21:00:00+08:00
      kind: user_message
      chat: chat_iso_b
      text: "最近跟对象闹分手，心情很差"

    - at: 2026-05-20T21:00:45+08:00
      kind: probe
      chat: chat_iso_b
      probe_kind: reactive_response
      expected:
        decision: send
        summary: "正控：在旺仔的 chat 里确实接住了分手这件事"
        must_recall: ["分手"]
        must_not_recall: []
        tone_hints: ["共情"]
        state_predicates: []
      dimensions: [recall]

    - at: 2026-05-20T21:05:00+08:00
      kind: user_message
      chat: chat_iso_a
      text: "帮我看下今天的部署计划"

    - at: 2026-05-20T21:05:45+08:00
      kind: probe
      chat: chat_iso_a
      probe_kind: reactive_response
      expected:
        decision: send
        summary: "隔离：给顾时瑞回复时绝不能提到旺仔的私事（分手/对象/心情）"
        must_recall: []
        must_not_recall: ["分手", "对象", "心情"]
        tone_hints: ["就事论事谈部署"]
        state_predicates: []
      dimensions: [restraint, recall]
```

- [ ] **Step 2: Smoke-load (also verifies multi-contact parsing end-to-end)**

Run: `bun -e "import { loadTrajectory } from './eval/companion/engine/trajectory'; const t = loadTrajectory('./eval/companion/trajectories/cross_chat_isolation_v1.yaml'); console.log(t.contacts.length, t.primaryChatId)"`
Expected: prints `2 chat_iso_a`.

- [ ] **Step 3: Commit**

```bash
git add eval/companion/trajectories/cross_chat_isolation_v1.yaml
git commit -m "test(eval): cross_chat_isolation multi-contact trajectory"
```

---

## Task 10: Update README + full acceptance run

**Files:**
- Modify: `eval/companion/README.md` ("Add a trajectory" + "What's NOT in MVP")

- [ ] **Step 1: Document multi-contact + per-event chat in "Add a trajectory"**

In `eval/companion/README.md`, in the `## Add a trajectory` section, append a step after the existing list:

```markdown
6. **Multi-contact trajectories** (e.g. `cross_chat_isolation`): use `contacts:` (a list of contacts) instead of `contact:`. The first contact is the primary. Tag each `user_message` / `tick` / `probe` event with `chat: <chat_id>` to target a specific contact; events without `chat:` target the primary. Exactly one of `contact:` / `contacts:` must be present.
```

- [ ] **Step 2: Trim the "What's NOT in MVP" failure-mode line**

In `eval/companion/README.md`, in `## What's NOT in MVP`, remove the now-completed failure-modes bullet entirely (all 8 modes now have trajectories) and replace it with:

```markdown
- (All 8 failure modes now have at least one trajectory.)
```

Leave the other "NOT in MVP" bullets (multi-seed averaging, CI integration, Codex / Anthropic-API judge backends) unchanged — those are Sub-project B.

- [ ] **Step 3: Commit the docs**

```bash
git add eval/companion/README.md
git commit -m "docs(eval): document multi-contact trajectories; all 8 modes covered"
```

- [ ] **Step 4: Full acceptance run (manual — real SDK, budget ~15–30 min)**

Run each new trajectory once and eyeball the report. These cost real Claude SDK calls; run them deliberately, not in CI:

```bash
bun run eval:companion --trajectory cross_domain_mixing_v1
bun run eval:companion --trajectory fact_update_supersede_v1
bun run eval:companion --trajectory wrong_inference_correction_v1
bun run eval:companion --trajectory explicit_quiet_v1
bun run eval:companion --trajectory long_silence_initiative_v1
bun run eval:companion --trajectory cross_chat_isolation_v1
```

For each: open `eval/companion/runs/<timestamp>/report.md`. Expected — engine assertions (✅/❌) are the objective gate; investigate any ❌. Judge dimension scores (1–5) are for trend, not pass/fail. `cross_chat_isolation_v1`'s chat_iso_a `must_not_recall` assertions must be ✅ (no leak) and chat_iso_b `must_recall:["分手"]` must be ✅ (fact stored).

> A ❌ here may indicate either a trajectory that needs its assertion tuned (e.g. a `must_not_recall` needle that's too aggressive) or a genuine companion behavior finding. Tune the trajectory if the needle was wrong; file a separate issue if it's a real companion bug (out of scope for this plan — the harness observes, it doesn't fix the daemon).

- [ ] **Step 5: (If any trajectory needed assertion tuning in Step 4)** commit the tuned YAML

```bash
git add eval/companion/trajectories/
git commit -m "test(eval): tune trajectory assertions after first acceptance run"
```

---

## Self-review notes

- **Spec coverage:** §2.1 rename → Task 1. §2.2 multi-contact schema → Task 2. §2.3 per-event chat → Task 2. §2.4 replay de-singularization → Task 3. §3.1–§3.6 six trajectories → Tasks 4–9. §4 validation → smoke-load + unit tests per task + Task 10 acceptance run. §5 out-of-scope respected (no judge/CI/predicate work).
- **Type consistency:** `Trajectory` gains `contacts: Contact[]` + `primaryChatId`; `Contact` exported (Task 2) and consumed in `replay.ts` via `Trajectory['contacts'][number]` (Task 3). `resolveEventChat(event, primaryChatId)` defined in Task 2, imported in Task 3. `ReplayContext.lastUserMessageReply` / `lastTickOutcome` changed from single to `Record<string, …>` consistently across `replay.ts` and `probes.ts` (Task 3 steps 1, 3, 5).
- **decision: n/a** is a valid `ExpectedSchema` value (`z.enum(['send','silent','n/a'])`) and is honored by `assertions.ts`; used in Task 6's regression probe.
```
