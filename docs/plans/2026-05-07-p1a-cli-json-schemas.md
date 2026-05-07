# P1.A · CLI JSON Schemas Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add zod schemas for ~30 `--json`-emitting CLI subcommands; insert producer-side `Schema.parse()` before each `console.log(JSON.stringify(...))`; add `// @ts-check` + JSDoc to ~10 desktop files that consume CLI JSON.

**Architecture:** `src/cli/schema.ts` is the single source of truth — exports zod schema values + `<Schema>T` inferred type aliases. CLI subcommand handlers in `cli.ts` and `src/cli/*.ts` import their schema and call `parse` immediately before printing. Desktop files `// @ts-check` themselves and import types via JSDoc — zero new toolchain.

**Tech Stack:** zod v4 (already in `package.json` dependencies), TypeScript 6, vitest, Bun runtime.

**Reference spec:** `docs/specs/2026-05-07-api-contract-and-agent-session.md` §P1.A

**Discovery checklist:**
- All `--json`-emitting subcommands are listed in spec §P1.A "Subcommand enumeration".
- Each subcommand's actual output shape lives in `cli.ts` or `src/cli/<name>.ts`. Find each via `grep -n 'JSON.stringify' cli.ts src/cli/`.
- Each desktop call site uses `invoke("wechat_cli_json", { args: [...] })`. Find via `grep -rn 'wechat_cli_json' apps/desktop/src/`.

---

### Task 1: Set up `schema.ts` skeleton + first schema (`doctor`)

**Files:**
- Create: `src/cli/schema.ts`
- Create: `src/cli/schema.test.ts`

- [ ] **Step 1: Discover the `doctor` output shape**

Run: `grep -n 'doctor' cli.ts src/cli/doctor.ts 2>/dev/null | head -20`

Then read the doctor handler — likely in `cli.ts` near the line that calls `JSON.stringify(report)` for the doctor subcommand. Note the fields the report object includes (e.g., `status`, `daemon_pid`, `mcp_servers`, `accounts`, etc.). This is your shape source-of-truth.

- [ ] **Step 2: Write failing test in `schema.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import { DoctorOutput } from './schema'

describe('DoctorOutput', () => {
  it('accepts a minimal valid report', () => {
    const sample = {
      ok: true,
      // ... fill in the minimal required fields per what you found in step 1
    }
    expect(DoctorOutput.safeParse(sample).success).toBe(true)
  })
  it('rejects a report missing `ok`', () => {
    expect(DoctorOutput.safeParse({}).success).toBe(false)
  })
})
```

- [ ] **Step 3: Run tests to verify failure**

```bash
bun --bun vitest run src/cli/schema.test.ts
```

Expected: FAIL with "Cannot find module './schema'"

- [ ] **Step 4: Implement the schema in `src/cli/schema.ts`**

```ts
/**
 * Zod schemas for every `--json`-emitting wechat-cc CLI subcommand.
 * The schema is the contract between daemon-side producers (cli.ts +
 * src/cli/*.ts call sites) and TypeScript consumers (apps/desktop/src/*.js
 * via // @ts-check + JSDoc, plus any future scripted consumer).
 *
 * Convention: <SchemaName> is the zod value; <SchemaName>T is the
 * inferred TS type. JSDoc consumers import the type alias because JSDoc
 * cannot express `z.infer<typeof X>` inline.
 */
import { z } from 'zod'

// wechat-cc doctor --json
export const DoctorOutput = z.object({
  ok: z.boolean(),
  // Add the fields you discovered in step 1. Use z.optional() for fields
  // that may legitimately be absent in some reports.
})
export type DoctorOutputT = z.infer<typeof DoctorOutput>
```

- [ ] **Step 5: Run tests to verify pass**

```bash
bun --bun vitest run src/cli/schema.test.ts
```

Expected: PASS — 2 tests

- [ ] **Step 6: Commit**

```bash
git add src/cli/schema.ts src/cli/schema.test.ts
git commit -m "feat(cli): zod schema scaffold + DoctorOutput"
```

---

### Task 2: Schema batch — setup family (`setup`, `setup-poll`, `setup-status`)

**Files:**
- Modify: `src/cli/schema.ts`
- Modify: `src/cli/schema.test.ts`

- [ ] **Step 1: Discover the shapes**

Read the relevant subcommand handlers — `setup`, `setup-poll`, `setup-status`, and `setup --qr-json` (called by the desktop QR module). Each handler ends with `console.log(JSON.stringify(...))`. Note the output object shape for each.

```bash
grep -n 'setup' cli.ts src/cli/setup-flow.ts | head
```

- [ ] **Step 2: Write failing tests**

Append to `src/cli/schema.test.ts`:

```ts
import {
  // ... existing imports ...
  SetupOutput,
  SetupPollOutput,
  SetupStatusOutput,
  SetupQrJsonOutput,
} from './schema'

describe('SetupOutput', () => {
  it('accepts the success shape', () => {
    expect(SetupOutput.safeParse({ ok: true /* ... */ }).success).toBe(true)
  })
  it('rejects missing ok', () => {
    expect(SetupOutput.safeParse({}).success).toBe(false)
  })
})

describe('SetupPollOutput', () => {
  it('accepts the polled status shape', () => {
    expect(SetupPollOutput.safeParse({ /* shape from step 1 */ }).success).toBe(true)
  })
  it('rejects an empty payload', () => {
    expect(SetupPollOutput.safeParse({}).success).toBe(false)
  })
})

describe('SetupStatusOutput', () => {
  it('accepts the snapshot shape', () => {
    expect(SetupStatusOutput.safeParse({ /* shape from step 1 */ }).success).toBe(true)
  })
  it('rejects an empty payload', () => {
    expect(SetupStatusOutput.safeParse({}).success).toBe(false)
  })
})

describe('SetupQrJsonOutput', () => {
  it('accepts the QR payload shape', () => {
    expect(SetupQrJsonOutput.safeParse({ /* shape from step 1 */ }).success).toBe(true)
  })
})
```

- [ ] **Step 3: Run tests, expect failure**

```bash
bun --bun vitest run src/cli/schema.test.ts
```

Expected: FAIL — 4 new test groups can't import the symbols.

- [ ] **Step 4: Add the schemas in `schema.ts`**

```ts
// wechat-cc setup
export const SetupOutput = z.object({
  ok: z.boolean(),
  // ... fields
})
export type SetupOutputT = z.infer<typeof SetupOutput>

// wechat-cc setup-poll --qrcode <token>
export const SetupPollOutput = z.object({
  // ... fields
})
export type SetupPollOutputT = z.infer<typeof SetupPollOutput>

// wechat-cc setup-status --json
export const SetupStatusOutput = z.object({
  // ... fields
})
export type SetupStatusOutputT = z.infer<typeof SetupStatusOutput>

// wechat-cc setup --qr-json (called from apps/desktop/src/modules/qr.js)
export const SetupQrJsonOutput = z.object({
  // ... fields
})
export type SetupQrJsonOutputT = z.infer<typeof SetupQrJsonOutput>
```

- [ ] **Step 5: Run tests, expect pass**

```bash
bun --bun vitest run src/cli/schema.test.ts
```

Expected: PASS — all schema tests including the new 8.

- [ ] **Step 6: Commit**

```bash
git add src/cli/schema.ts src/cli/schema.test.ts
git commit -m "feat(cli): setup-family output schemas"
```

---

### Task 3: Schema batch — service family (`service status/install/start/stop/uninstall`, `install-progress`)

**Files:**
- Modify: `src/cli/schema.ts`
- Modify: `src/cli/schema.test.ts`

- [ ] **Step 1: Discover shapes**

The service subcommands live in `src/cli/service-manager.ts`. The `install-progress` is in `cli.ts`. Each prints `console.log(JSON.stringify(...))` on the `--json` branch.

```bash
grep -n 'JSON.stringify' src/cli/service-manager.ts cli.ts | grep -v test
```

Most service operations return `{ ok: true, ... }` on success and `{ ok: false, error: '...' }` on failure — express via `z.discriminatedUnion('ok', [...])`.

- [ ] **Step 2: Write failing tests**

```ts
import {
  // ... existing imports ...
  ServiceStatusOutput,
  ServiceInstallOutput,
  ServiceStartOutput,
  ServiceStopOutput,
  ServiceUninstallOutput,
  InstallProgressOutput,
} from './schema'

describe('ServiceStatusOutput', () => {
  it('accepts a status report', () => {
    expect(ServiceStatusOutput.safeParse({ /* shape */ }).success).toBe(true)
  })
})

// ... similar tests for the other 5 schemas, each with valid + invalid case
```

- [ ] **Step 3: Run tests, expect failure**

```bash
bun --bun vitest run src/cli/schema.test.ts
```

- [ ] **Step 4: Add the schemas**

Use the discriminated-union pattern for any subcommand whose output is `{ ok: true, ... } | { ok: false, error }`:

```ts
// wechat-cc service status --json
export const ServiceStatusOutput = z.object({
  // ... status fields (always returns ok:true if it returns at all)
})
export type ServiceStatusOutputT = z.infer<typeof ServiceStatusOutput>

// wechat-cc service install --json
export const ServiceInstallOutput = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), /* success fields */ }),
  z.object({ ok: z.literal(false), error: z.string() }),
])
export type ServiceInstallOutputT = z.infer<typeof ServiceInstallOutput>

// ... ServiceStartOutput, ServiceStopOutput, ServiceUninstallOutput same pattern

// wechat-cc install-progress --json
export const InstallProgressOutput = z.object({
  // ... progress shape
})
export type InstallProgressOutputT = z.infer<typeof InstallProgressOutput>
```

- [ ] **Step 5: Run tests, expect pass**

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(cli): service-family output schemas"
```

---

### Task 4: Schema batch — `account remove`, `daemon kill`, `provider show`

**Files:**
- Modify: `src/cli/schema.ts`
- Modify: `src/cli/schema.test.ts`

- [ ] **Step 1: Discover shapes**

```bash
grep -n -A5 'account.*remove\|daemon.*kill\|provider.*show' cli.ts | head -40
```

- [ ] **Step 2: Write failing tests**

```ts
import {
  AccountRemoveOutput,
  DaemonKillOutput,
  ProviderShowOutput,
} from './schema'

describe('AccountRemoveOutput', () => {
  it('accepts the success shape', () => { /* ... */ })
  it('rejects missing ok', () => { /* ... */ })
})

describe('DaemonKillOutput', () => {
  it('accepts the kill report', () => { /* ... */ })
  it('rejects empty payload', () => { /* ... */ })
})

describe('ProviderShowOutput', () => {
  it('accepts the config snapshot', () => { /* ... */ })
  it('rejects empty payload', () => { /* ... */ })
})
```

- [ ] **Step 3: Run tests, expect failure**

- [ ] **Step 4: Add the schemas**

```ts
// wechat-cc account remove <bot-id> --json
export const AccountRemoveOutput = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), /* fields */ }),
  z.object({ ok: z.literal(false), error: z.string() }),
])
export type AccountRemoveOutputT = z.infer<typeof AccountRemoveOutput>

// wechat-cc daemon kill <pid> --json
export const DaemonKillOutput = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), /* fields */ }),
  z.object({ ok: z.literal(false), error: z.string() }),
])
export type DaemonKillOutputT = z.infer<typeof DaemonKillOutput>

// wechat-cc provider show --json
export const ProviderShowOutput = z.object({
  // ... config fields
})
export type ProviderShowOutputT = z.infer<typeof ProviderShowOutput>
```

- [ ] **Step 5: Run tests, expect pass**

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(cli): account/daemon/provider output schemas"
```

---

### Task 5: Schema batch — memory family (`memory list/read/write`)

**Files:**
- Modify: `src/cli/schema.ts`
- Modify: `src/cli/schema.test.ts`

- [ ] **Step 1: Discover shapes**

```bash
grep -n -A5 'memory.*list\|memory.*read\|memory.*write' cli.ts | head -40
```

The memory subcommands live in `cli.ts` itself (around the lines you find via grep). Note: `memory write` has the unusual `--body-base64` arg pattern.

- [ ] **Step 2: Write failing tests**

```ts
import {
  MemoryListOutput,
  MemoryReadOutput,
  MemoryWriteOutput,
} from './schema'

describe('MemoryListOutput', () => {
  it('accepts the user-list shape', () => { /* ... */ })
  it('rejects missing field', () => { /* ... */ })
})

describe('MemoryReadOutput', () => {
  it('accepts ok-true with content', () => { /* ... */ })
  it('accepts ok-false with error', () => { /* ... */ })
})

describe('MemoryWriteOutput', () => {
  it('accepts ok-true', () => { /* ... */ })
  it('accepts ok-false with error', () => { /* ... */ })
})
```

- [ ] **Step 3: Run tests, expect failure**

- [ ] **Step 4: Add the schemas**

```ts
// wechat-cc memory list --json
export const MemoryListOutput = z.object({
  // ... users array or similar
})
export type MemoryListOutputT = z.infer<typeof MemoryListOutput>

// wechat-cc memory read <user-id> <path> --json
export const MemoryReadOutput = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), userId: z.string(), path: z.string(), content: z.string() }),
  z.object({ ok: z.literal(false), error: z.string() }),
])
export type MemoryReadOutputT = z.infer<typeof MemoryReadOutput>

// wechat-cc memory write <user-id> <path> --body-base64 <b64> --json
export const MemoryWriteOutput = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), /* fields */ }),
  z.object({ ok: z.literal(false), error: z.string() }),
])
export type MemoryWriteOutputT = z.infer<typeof MemoryWriteOutput>
```

- [ ] **Step 5: Run tests, expect pass**

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(cli): memory-family output schemas"
```

---

### Task 6: Schema batch — events / observations / milestones

**Files:**
- Modify: `src/cli/schema.ts`
- Modify: `src/cli/schema.test.ts`

- [ ] **Step 1: Discover shapes**

```bash
grep -n -A5 'events.*list\|observations\|milestones.*list' cli.ts | head -50
```

Note: cli.ts already wraps these as `{ ok: true, events: [...] }` / `{ ok: true, observations: [...] }` / `{ ok: true, milestones: [...] }`.

- [ ] **Step 2: Write failing tests**

```ts
import {
  EventsListOutput,
  ObservationsListOutput,
  ObservationsArchiveOutput,
  MilestonesListOutput,
} from './schema'

describe('EventsListOutput', () => {
  it('accepts a list of events', () => { /* ... */ })
})

describe('ObservationsListOutput', () => {
  it('accepts a list of observations', () => { /* ... */ })
})

describe('ObservationsArchiveOutput', () => {
  it('accepts ok-true with archived id', () => { /* ... */ })
})

describe('MilestonesListOutput', () => {
  it('accepts a list of milestones', () => { /* ... */ })
})
```

- [ ] **Step 3: Run tests, expect failure**

- [ ] **Step 4: Add the schemas**

```ts
// wechat-cc events list <chat-id> [--limit N] --json
export const EventsListOutput = z.object({
  ok: z.literal(true),
  events: z.array(z.object({
    ts: z.string(),
    kind: z.string(),
    trigger: z.string(),
    // ... any other fields the handler emits
  })),
})
export type EventsListOutputT = z.infer<typeof EventsListOutput>

// wechat-cc observations list <chat-id> [--include-archived] --json
export const ObservationsListOutput = z.object({
  ok: z.literal(true),
  observations: z.array(z.object({
    ts: z.string(),
    body: z.string(),
    // ... fields
  })),
})
export type ObservationsListOutputT = z.infer<typeof ObservationsListOutput>

// wechat-cc observations archive <chat-id> <obs-id> --json
export const ObservationsArchiveOutput = z.object({
  ok: z.literal(true),
  archived: z.string(),
})
export type ObservationsArchiveOutputT = z.infer<typeof ObservationsArchiveOutput>

// wechat-cc milestones list <chat-id> --json
export const MilestonesListOutput = z.object({
  ok: z.literal(true),
  milestones: z.array(z.object({
    ts: z.string(),
    body: z.string(),
    // ... fields
  })),
})
export type MilestonesListOutputT = z.infer<typeof MilestonesListOutput>
```

- [ ] **Step 5: Run tests, expect pass**

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(cli): events/observations/milestones schemas"
```

---

### Task 7: Schema batch — sessions family (`sessions list-projects/read-jsonl/delete/search`)

**Files:**
- Modify: `src/cli/schema.ts`
- Modify: `src/cli/schema.test.ts`

- [ ] **Step 1: Discover shapes**

```bash
grep -n -A5 'sessions.*list\|sessions.*read\|sessions.*delete\|sessions.*search' cli.ts | head -60
```

`sessions read-jsonl` is the largest payload (entire jsonl as parsed events) — uses `wechat_cli_json_via_file` from the desktop side because output can be megabytes. The schema describes the full shape regardless.

- [ ] **Step 2: Write failing tests**

```ts
import {
  SessionsListProjectsOutput,
  SessionsReadJsonlOutput,
  SessionsDeleteOutput,
  SessionsSearchOutput,
} from './schema'

describe('SessionsListProjectsOutput', () => {
  it('accepts a project list', () => { /* ... */ })
})

describe('SessionsReadJsonlOutput', () => {
  it('accepts a parsed-events payload', () => { /* ... */ })
})

describe('SessionsDeleteOutput', () => {
  it('accepts the deleted alias confirmation', () => { /* ... */ })
})

describe('SessionsSearchOutput', () => {
  it('accepts a search-result list', () => { /* ... */ })
})
```

- [ ] **Step 3: Run tests, expect failure**

- [ ] **Step 4: Add the schemas**

```ts
// wechat-cc sessions list-projects --json
export const SessionsListProjectsOutput = z.object({
  ok: z.literal(true),
  projects: z.array(z.object({
    alias: z.string(),
    // ... fields the actual handler emits
  })),
})
export type SessionsListProjectsOutputT = z.infer<typeof SessionsListProjectsOutput>

// wechat-cc sessions read-jsonl <alias> --json
// Returns parsed jsonl events. Use z.unknown() for the events array if
// the per-event shape varies — this schema is structural, not deep.
export const SessionsReadJsonlOutput = z.object({
  ok: z.literal(true),
  events: z.array(z.unknown()),
  // ... any envelope fields the handler emits
})
export type SessionsReadJsonlOutputT = z.infer<typeof SessionsReadJsonlOutput>

// wechat-cc sessions delete <alias> --json
export const SessionsDeleteOutput = z.object({
  ok: z.literal(true),
  deleted: z.string(),
})
export type SessionsDeleteOutputT = z.infer<typeof SessionsDeleteOutput>

// wechat-cc sessions search <query> [--limit N] --json
export const SessionsSearchOutput = z.object({
  ok: z.literal(true),
  results: z.array(z.unknown()),
})
export type SessionsSearchOutputT = z.infer<typeof SessionsSearchOutput>
```

- [ ] **Step 5: Run tests, expect pass**

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(cli): sessions-family output schemas"
```

---

### Task 8: Schema batch — `demo seed/unseed`, `reply`, `logs`

**Files:**
- Modify: `src/cli/schema.ts`
- Modify: `src/cli/schema.test.ts`

- [ ] **Step 1: Discover shapes**

```bash
grep -n -A5 'demo.*seed\|reply\|logs' cli.ts | head -40
```

`logs --tail N --json` returns parsed log entries `{ timestamp, tag, message }`. `reply --to <chat_id> [text] --json` is a simple ok/error.

- [ ] **Step 2: Write failing tests**

```ts
import {
  DemoSeedOutput,
  DemoUnseedOutput,
  ReplyOutput,
  LogsOutput,
} from './schema'

describe('DemoSeedOutput', () => {
  it('accepts ok-true', () => { /* ... */ })
})

describe('DemoUnseedOutput', () => {
  it('accepts ok-true', () => { /* ... */ })
})

describe('ReplyOutput', () => {
  it('accepts ok-true with msg_id', () => { /* ... */ })
  it('accepts ok-false with error', () => { /* ... */ })
})

describe('LogsOutput', () => {
  it('accepts an entries array', () => { /* ... */ })
})
```

- [ ] **Step 3: Run tests, expect failure**

- [ ] **Step 4: Add the schemas**

```ts
// wechat-cc demo seed [--chat-id <id>] --json
export const DemoSeedOutput = z.object({
  ok: z.literal(true),
  // ... fields
})
export type DemoSeedOutputT = z.infer<typeof DemoSeedOutput>

// wechat-cc demo unseed [--chat-id <id>] --json
export const DemoUnseedOutput = z.object({
  ok: z.literal(true),
  // ... fields
})
export type DemoUnseedOutputT = z.infer<typeof DemoUnseedOutput>

// wechat-cc reply [--to <chat_id>] [text] --json
export const ReplyOutput = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), msg_id: z.string() }),
  z.object({ ok: z.literal(false), error: z.string() }),
])
export type ReplyOutputT = z.infer<typeof ReplyOutput>

// wechat-cc logs [--tail N] --json
export const LogsOutput = z.object({
  ok: z.literal(true),
  entries: z.array(z.object({
    timestamp: z.string(),
    tag: z.string(),
    message: z.string(),
  })),
})
export type LogsOutputT = z.infer<typeof LogsOutput>
```

- [ ] **Step 5: Run tests, expect pass**

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(cli): demo/reply/logs output schemas"
```

---

### Task 9: Schema batch — `update`, `conversations list`

**Files:**
- Modify: `src/cli/schema.ts`
- Modify: `src/cli/schema.test.ts`

- [ ] **Step 1: Discover shapes**

```bash
grep -n -A5 'update.*--json\|conversations.*list' cli.ts src/cli/update.ts | head -50
```

`update --check --json` and `update --json` (apply) have related but distinct shapes. `conversations list --json` was implemented in v0.6 PR5 — emits `{ ok: true, conversations: [...] }` with chatId/mode/last_user_name/user_id/account_id fields.

- [ ] **Step 2: Write failing tests**

```ts
import {
  UpdateCheckOutput,
  UpdateApplyOutput,
  ConversationsListOutput,
} from './schema'

describe('UpdateCheckOutput', () => {
  it('accepts an update-available report', () => { /* ... */ })
  it('accepts a no-update report', () => { /* ... */ })
})

describe('UpdateApplyOutput', () => {
  it('accepts ok-true', () => { /* ... */ })
  it('accepts ok-false with error', () => { /* ... */ })
})

describe('ConversationsListOutput', () => {
  it('accepts a conversations report', () => { /* ... */ })
})
```

- [ ] **Step 3: Run tests, expect failure**

- [ ] **Step 4: Add the schemas**

```ts
// wechat-cc update --check --json
export const UpdateCheckOutput = z.object({
  // ... fields the actual update --check emits (e.g., { available, current, latest, reason? })
})
export type UpdateCheckOutputT = z.infer<typeof UpdateCheckOutput>

// wechat-cc update --json (apply)
export const UpdateApplyOutput = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), /* fields */ }),
  z.object({ ok: z.literal(false), error: z.string() }),
])
export type UpdateApplyOutputT = z.infer<typeof UpdateApplyOutput>

// wechat-cc conversations list --json
export const ConversationsListOutput = z.object({
  ok: z.literal(true),
  conversations: z.array(z.object({
    chatId: z.string(),
    mode: z.unknown(), // or refined Mode shape from src/core/conversation
    last_user_name: z.string().optional(),
    user_id: z.string().optional(),
    account_id: z.string().optional(),
  })),
})
export type ConversationsListOutputT = z.infer<typeof ConversationsListOutput>
```

- [ ] **Step 5: Run tests, expect pass**

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(cli): update + conversations list output schemas"
```

---

### Task 10: Schema batch — `guard status/enable/disable`, `avatar info/set/remove`

**Files:**
- Modify: `src/cli/schema.ts`
- Modify: `src/cli/schema.test.ts`

- [ ] **Step 1: Discover shapes**

```bash
grep -n -A5 'guard.*status\|guard.*enable\|guard.*disable\|avatar' cli.ts | head -60
```

Avatar `set` accepts `--base64` content. All three avatar subcommands have ok/error shapes.

- [ ] **Step 2: Write failing tests**

```ts
import {
  GuardStatusOutput, GuardEnableOutput, GuardDisableOutput,
  AvatarInfoOutput, AvatarSetOutput, AvatarRemoveOutput,
} from './schema'

describe('GuardStatusOutput', () => {
  it('accepts a status snapshot', () => { /* ... */ })
})

describe('GuardEnableOutput', () => {
  it('accepts ok-true with enabled state', () => { /* ... */ })
})

describe('GuardDisableOutput', () => {
  it('accepts ok-true', () => { /* ... */ })
})

describe('AvatarInfoOutput', () => {
  it('accepts the info report', () => { /* ... */ })
})

describe('AvatarSetOutput', () => {
  it('accepts ok-true', () => { /* ... */ })
  it('accepts ok-false', () => { /* ... */ })
})

describe('AvatarRemoveOutput', () => {
  it('accepts ok-true', () => { /* ... */ })
  it('accepts ok-false', () => { /* ... */ })
})
```

- [ ] **Step 3: Run tests, expect failure**

- [ ] **Step 4: Add the schemas**

```ts
// wechat-cc guard status --json
export const GuardStatusOutput = z.object({
  // ... status fields
})
export type GuardStatusOutputT = z.infer<typeof GuardStatusOutput>

// wechat-cc guard enable --json
export const GuardEnableOutput = z.object({
  ok: z.literal(true),
  enabled: z.boolean(),
})
export type GuardEnableOutputT = z.infer<typeof GuardEnableOutput>

// wechat-cc guard disable --json
export const GuardDisableOutput = z.object({
  ok: z.literal(true),
  enabled: z.boolean(),
})
export type GuardDisableOutputT = z.infer<typeof GuardDisableOutput>

// wechat-cc avatar info <key> --json
export const AvatarInfoOutput = z.object({
  ok: z.literal(true),
  // ... avatar info fields
})
export type AvatarInfoOutputT = z.infer<typeof AvatarInfoOutput>

// wechat-cc avatar set <key> --base64 <b64> --json
export const AvatarSetOutput = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), /* fields */ }),
  z.object({ ok: z.literal(false), error: z.string() }),
])
export type AvatarSetOutputT = z.infer<typeof AvatarSetOutput>

// wechat-cc avatar remove <key> --json
export const AvatarRemoveOutput = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), /* fields */ }),
  z.object({ ok: z.literal(false), error: z.string() }),
])
export type AvatarRemoveOutputT = z.infer<typeof AvatarRemoveOutput>
```

- [ ] **Step 5: Run tests, expect pass**

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(cli): guard + avatar output schemas"
```

---

### Task 11: Insert `Schema.parse()` calls at every CLI `--json` print site

**Files:**
- Modify: `cli.ts`
- Modify: `src/cli/service-manager.ts`
- Modify: `src/cli/setup-flow.ts`
- Modify: `src/cli/update.ts`
- Modify: any other `src/cli/*.ts` file containing `console.log(JSON.stringify(...))`

This task is mechanical but spans the codebase. Do it in a single commit per logical area to keep diffs reviewable.

- [ ] **Step 1: Find every print site**

```bash
grep -n 'console.log(JSON.stringify' cli.ts src/cli/*.ts | grep -v test
```

You should see ~30 hits matching the schemas added in Tasks 1-10.

- [ ] **Step 2: For each print site, add a parse call before printing**

Pattern (using doctor as the canonical example):

```diff
- if (args.json) console.log(JSON.stringify(report, null, 2))
+ if (args.json) {
+   const validated = DoctorOutput.parse(report)
+   console.log(JSON.stringify(validated, null, 2))
+ }
```

If the print is single-line and not branched on `args.json`, replace inline:

```diff
- console.log(JSON.stringify({ ok: true, events: list }, null, 2))
+ console.log(JSON.stringify(EventsListOutput.parse({ ok: true, events: list }), null, 2))
```

`parse` (not `safeParse`) is intentional: a schema mismatch is a bug; throw and fail tests loudly.

- [ ] **Step 3: Add schema imports at the top of each modified file**

`cli.ts`:
```ts
import {
  DoctorOutput, SetupOutput, SetupPollOutput, SetupStatusOutput, SetupQrJsonOutput,
  AccountRemoveOutput, DaemonKillOutput, ProviderShowOutput,
  MemoryListOutput, MemoryReadOutput, MemoryWriteOutput,
  EventsListOutput, ObservationsListOutput, ObservationsArchiveOutput, MilestonesListOutput,
  SessionsListProjectsOutput, SessionsReadJsonlOutput, SessionsDeleteOutput, SessionsSearchOutput,
  DemoSeedOutput, DemoUnseedOutput, ReplyOutput, LogsOutput,
  ConversationsListOutput,
  GuardStatusOutput, GuardEnableOutput, GuardDisableOutput,
  AvatarInfoOutput, AvatarSetOutput, AvatarRemoveOutput,
  InstallProgressOutput,
} from './src/cli/schema'
```

(Trim to only the schemas actually used in that file.)

In `src/cli/service-manager.ts`:
```ts
import {
  ServiceStatusOutput, ServiceInstallOutput, ServiceStartOutput,
  ServiceStopOutput, ServiceUninstallOutput,
} from './schema'
```

In `src/cli/update.ts`:
```ts
import { UpdateCheckOutput, UpdateApplyOutput } from './schema'
```

- [ ] **Step 4: Run all CLI subcommand tests**

```bash
bun --bun vitest run cli.test.ts src/cli/
```

Expected: all existing tests pass. If any test fails because the schema rejects a real CLI output, the schema is wrong — fix the schema (it's the contract), not the test.

- [ ] **Step 5: Run typecheck**

```bash
bun run typecheck
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add cli.ts src/cli/
git commit -m "feat(cli): producer-side Schema.parse() at every --json print site"
```

---

### Task 12: Update `tsconfig.json` to type-check desktop CLI consumers

**Files:**
- Modify: `tsconfig.json`

- [ ] **Step 1: Discover the desktop consumer files**

```bash
grep -rln 'wechat_cli_json' apps/desktop/src/ | grep -v test | sort -u
```

Expected list (verify against current state):
- `apps/desktop/src/conversations-poller.js`
- `apps/desktop/src/doctor-poller.js`
- `apps/desktop/src/main.js`
- `apps/desktop/src/modules/service.js`
- `apps/desktop/src/modules/sessions.js`
- `apps/desktop/src/modules/update.js`
- `apps/desktop/src/modules/memory.js`
- `apps/desktop/src/modules/qr.js`

- [ ] **Step 2: Edit `tsconfig.json`**

```diff
   "compilerOptions": {
     "target": "ESNext",
     "module": "ESNext",
     "moduleResolution": "bundler",
     "strict": true,
     "noUncheckedIndexedAccess": true,
     "skipLibCheck": true,
     "types": ["bun"],
     "lib": ["ESNext"],
     "esModuleInterop": true,
     "allowImportingTsExtensions": true,
     "noEmit": true,
     "verbatimModuleSyntax": true,
-    "resolveJsonModule": true
+    "resolveJsonModule": true,
+    "allowJs": true
   },
   "include": [
     "**/*.ts",
     "src/**/*.ts",
-    "types/**/*.d.ts"
+    "types/**/*.d.ts",
+    "apps/desktop/src/conversations-poller.js",
+    "apps/desktop/src/doctor-poller.js",
+    "apps/desktop/src/main.js",
+    "apps/desktop/src/modules/service.js",
+    "apps/desktop/src/modules/sessions.js",
+    "apps/desktop/src/modules/update.js",
+    "apps/desktop/src/modules/memory.js",
+    "apps/desktop/src/modules/qr.js"
   ],
```

- [ ] **Step 3: Run typecheck**

```bash
bun run typecheck
```

Expected: pass. The included `.js` files don't yet have `// @ts-check`, so they're parsed but not type-checked. (If a baseline `.ts` test file imports them, that test already worked under `allowJs: false` because tsc treated the import as `any` — `allowJs: true` keeps that working.)

- [ ] **Step 4: Commit**

```bash
git add tsconfig.json
git commit -m "feat(tsconfig): allowJs + include desktop CLI consumers"
```

---

### Task 13: Add `// @ts-check` + JSDoc to `conversations-poller.js`

**Files:**
- Modify: `apps/desktop/src/conversations-poller.js`

- [ ] **Step 1: Add the directive + typedef + per-function JSDoc**

```diff
+// @ts-check
+/** @typedef {import('../../../src/cli/schema').ConversationsListOutputT} ConversationsList */
+
 // conversations-poller — RFC 03 P5.2. Polls
 // `wechat-cc conversations list --json` and notifies subscribers.
 // ...

+/**
+ * @param {{ invoke: (cmd: string, args: { args: string[] }) => Promise<unknown>, intervalMs?: number }} opts
+ */
 export function createConversationsPoller({ invoke, intervalMs = 10000 }) {
+  /** @type {ConversationsList | null} */
   let last = null
+  /** @type {unknown} */
   let lastError = null
+  /** @type {Set<(report: ConversationsList) => void>} */
   const subscribers = new Set()
   // ...

   function refresh() {
     if (inflight) return inflight
     inflight = (async () => {
       try {
-        const report = await invoke("wechat_cli_json", { args: ["conversations", "list", "--json"] })
+        /** @type {ConversationsList} */
+        const report = /** @type {ConversationsList} */ (await invoke("wechat_cli_json", { args: ["conversations", "list", "--json"] }))
         last = report
         // ...
```

The `/** @type {ConversationsList} */ (await ...)` cast is necessary because `invoke()` returns `unknown`. JSDoc-style cast is the standard idiom.

- [ ] **Step 2: Run typecheck**

```bash
bun run typecheck
```

Expected: pass. If you see type errors in the file, the JSDoc is incomplete — add type annotations to the relevant variables or function signatures.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/conversations-poller.js
git commit -m "feat(desktop): // @ts-check + JSDoc types on conversations-poller"
```

---

### Task 14: Add `// @ts-check` + JSDoc to `doctor-poller.js`

**Files:**
- Modify: `apps/desktop/src/doctor-poller.js`

Apply the same pattern as Task 13. The relevant typedef:

```js
/** @typedef {import('../../../src/cli/schema').DoctorOutputT} DoctorReport */
```

- [ ] **Step 1: Add directive + typedef + JSDoc**

```diff
+// @ts-check
+/** @typedef {import('../../../src/cli/schema').DoctorOutputT} DoctorReport */
+
 // doctor-poller.js — single ownership of the `wechat-cc doctor --json`
 // ...

+/**
+ * @param {{ invoke: (cmd: string, args: { args: string[] }) => Promise<unknown>, intervalMs?: number }} opts
+ */
 export function createDoctorPoller({ invoke, intervalMs = 5000 }) {
+  /** @type {DoctorReport | null} */
   let lastReport = null
+  /** @type {unknown} */
   let lastError = null
+  /** @type {Set<(report: DoctorReport) => void>} */
   const subscribers = new Set()
   // ...
```

For the `waitForCondition` function:

```diff
+  /**
+   * @param {(report: DoctorReport) => boolean} predicate
+   * @param {number} [timeoutMs]
+   * @param {number} [pollIntervalMs]
+   * @returns {Promise<DoctorReport | null>}
+   */
   async function waitForCondition(predicate, timeoutMs = 8000, pollIntervalMs = 500) {
```

For the invoke result:

```diff
-        const report = await invoke("wechat_cli_json", { args: ["doctor", "--json"] })
+        const report = /** @type {DoctorReport} */ (await invoke("wechat_cli_json", { args: ["doctor", "--json"] }))
```

- [ ] **Step 2: Run typecheck**

```bash
bun run typecheck
```

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/doctor-poller.js
git commit -m "feat(desktop): // @ts-check + JSDoc types on doctor-poller"
```

---

### Task 15: Add `// @ts-check` + JSDoc to `main.js`

**Files:**
- Modify: `apps/desktop/src/main.js`

`main.js` is 673 lines and calls multiple CLI subcommands. List the typedefs for every CLI command it consumes (find via grep `wechat_cli_json` in main.js).

- [ ] **Step 1: Discover which CLI subcommands main.js calls**

```bash
grep -n 'wechat_cli_json' apps/desktop/src/main.js
```

Expected (from earlier exploration): guard status, provider show, guard enable/disable, avatar info/remove/set.

- [ ] **Step 2: Add directive + typedefs**

```js
// @ts-check
/** @typedef {import('../../../src/cli/schema').GuardStatusOutputT} GuardStatus */
/** @typedef {import('../../../src/cli/schema').ProviderShowOutputT} ProviderConfig */
/** @typedef {import('../../../src/cli/schema').GuardEnableOutputT} GuardEnable */
/** @typedef {import('../../../src/cli/schema').GuardDisableOutputT} GuardDisable */
/** @typedef {import('../../../src/cli/schema').AvatarInfoOutputT} AvatarInfo */
/** @typedef {import('../../../src/cli/schema').AvatarSetOutputT} AvatarSet */
/** @typedef {import('../../../src/cli/schema').AvatarRemoveOutputT} AvatarRemove */
```

- [ ] **Step 3: Cast each invoke result to the right type**

For each `await invoke("wechat_cli_json", { args: [...] })`, wrap the result in a JSDoc cast:

```diff
-    const r = await invoke("wechat_cli_json", { args: ["guard", "status", "--json"] })
+    const r = /** @type {GuardStatus} */ (await invoke("wechat_cli_json", { args: ["guard", "status", "--json"] }))
```

Repeat for every `wechat_cli_json` call site in the file.

- [ ] **Step 4: Run typecheck**

```bash
bun run typecheck
```

If the file has additional type errors (e.g., DOM element accesses not typed), you may need `/** @type {HTMLElement | null} */` annotations. Add them as required for `tsc` to pass.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main.js
git commit -m "feat(desktop): // @ts-check + JSDoc types on main.js"
```

---

### Task 16: Add `// @ts-check` + JSDoc to `modules/service.js`

**Files:**
- Modify: `apps/desktop/src/modules/service.js`

CLI commands consumed: `install-progress`, `service status`, `service install/start/stop/uninstall`, `daemon kill`.

- [ ] **Step 1: Add directive + typedefs**

```js
// @ts-check
/** @typedef {import('../../../../src/cli/schema').InstallProgressOutputT} InstallProgress */
/** @typedef {import('../../../../src/cli/schema').ServiceStatusOutputT} ServiceStatus */
/** @typedef {import('../../../../src/cli/schema').ServiceInstallOutputT} ServiceInstall */
/** @typedef {import('../../../../src/cli/schema').ServiceStartOutputT} ServiceStart */
/** @typedef {import('../../../../src/cli/schema').ServiceStopOutputT} ServiceStop */
/** @typedef {import('../../../../src/cli/schema').ServiceUninstallOutputT} ServiceUninstall */
/** @typedef {import('../../../../src/cli/schema').DaemonKillOutputT} DaemonKill */
```

(Note four `..` because `modules/` is one level deeper than `src/`.)

- [ ] **Step 2: Cast each invoke result**

Same pattern as Task 15 — wrap each `invoke` call with `/** @type {...} */`.

- [ ] **Step 3: Run typecheck**

```bash
bun run typecheck
```

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/modules/service.js
git commit -m "feat(desktop): // @ts-check + JSDoc types on modules/service"
```

---

### Task 17: Add `// @ts-check` + JSDoc to `modules/sessions.js`

**Files:**
- Modify: `apps/desktop/src/modules/sessions.js`

CLI commands consumed: `sessions list-projects`, `sessions read-jsonl`, `sessions delete`, `sessions search`, `avatar info`.

- [ ] **Step 1: Add directive + typedefs**

```js
// @ts-check
/** @typedef {import('../../../../src/cli/schema').SessionsListProjectsOutputT} SessionsListProjects */
/** @typedef {import('../../../../src/cli/schema').SessionsReadJsonlOutputT} SessionsReadJsonl */
/** @typedef {import('../../../../src/cli/schema').SessionsDeleteOutputT} SessionsDelete */
/** @typedef {import('../../../../src/cli/schema').SessionsSearchOutputT} SessionsSearch */
/** @typedef {import('../../../../src/cli/schema').AvatarInfoOutputT} AvatarInfo */
```

- [ ] **Step 2: Cast each invoke result**

Same pattern. `wechat_cli_json_via_file` returns the same shape as `wechat_cli_json` for `sessions read-jsonl` (the file-based transport is opaque to consumers).

- [ ] **Step 3: Run typecheck**

```bash
bun run typecheck
```

This file is 1150 lines — type checking may surface lots of pre-existing implicit-`any` issues. Add JSDoc to local variables only as needed to make `tsc` pass; don't refactor unrelated code.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/modules/sessions.js
git commit -m "feat(desktop): // @ts-check + JSDoc types on modules/sessions"
```

---

### Task 18: Add `// @ts-check` + JSDoc to `modules/update.js`

**Files:**
- Modify: `apps/desktop/src/modules/update.js`

CLI commands consumed: `update --check`, `update`.

- [ ] **Step 1: Add directive + typedefs**

```js
// @ts-check
/** @typedef {import('../../../../src/cli/schema').UpdateCheckOutputT} UpdateCheck */
/** @typedef {import('../../../../src/cli/schema').UpdateApplyOutputT} UpdateApply */
```

- [ ] **Step 2: Cast each invoke result**

Same pattern.

- [ ] **Step 3: Run typecheck**

```bash
bun run typecheck
```

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/modules/update.js
git commit -m "feat(desktop): // @ts-check + JSDoc types on modules/update"
```

---

### Task 19: Add `// @ts-check` + JSDoc to `modules/memory.js`

**Files:**
- Modify: `apps/desktop/src/modules/memory.js`

CLI commands consumed: `memory list`, `memory read`, `memory write`.

- [ ] **Step 1: Add directive + typedefs**

```js
// @ts-check
/** @typedef {import('../../../../src/cli/schema').MemoryListOutputT} MemoryList */
/** @typedef {import('../../../../src/cli/schema').MemoryReadOutputT} MemoryRead */
/** @typedef {import('../../../../src/cli/schema').MemoryWriteOutputT} MemoryWrite */
```

- [ ] **Step 2: Cast each invoke result**

Same pattern.

- [ ] **Step 3: Run typecheck**

```bash
bun run typecheck
```

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/modules/memory.js
git commit -m "feat(desktop): // @ts-check + JSDoc types on modules/memory"
```

---

### Task 20: Add `// @ts-check` + JSDoc to `modules/qr.js`

**Files:**
- Modify: `apps/desktop/src/modules/qr.js`

CLI commands consumed: `setup --qr-json`, plus possibly other `setup` variants.

- [ ] **Step 1: Add directive + typedefs**

```js
// @ts-check
/** @typedef {import('../../../../src/cli/schema').SetupQrJsonOutputT} SetupQrJson */
/** @typedef {import('../../../../src/cli/schema').SetupOutputT} SetupOutput */
```

(If qr.js calls other setup variants, add their typedefs too.)

- [ ] **Step 2: Cast each invoke result**

Same pattern.

- [ ] **Step 3: Run typecheck**

```bash
bun run typecheck
```

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/modules/qr.js
git commit -m "feat(desktop): // @ts-check + JSDoc types on modules/qr"
```

---

### Task 21: Final integration verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full type check**

```bash
bun run typecheck
```

Expected: PASS with zero errors.

- [ ] **Step 2: Run the full test suite**

```bash
bun --bun vitest run
```

Expected: PASS. Test count should be higher than baseline (1316 at the start of v0.5.13) by approximately 60 (the new schema parse tests).

- [ ] **Step 3: Run the desktop shim e2e tests**

```bash
bun --bun vitest run -c vitest.e2e.config.ts apps/desktop/shim.e2e.test.ts
```

Expected: PASS. The shim drives the real CLI; if the producer-side parse rejects something, you'd see it here.

- [ ] **Step 4: Run Playwright if convenient (optional locally; required in CI)**

```bash
cd apps/desktop && bun playwright test
```

Expected: PASS.

- [ ] **Step 5: Verify `tsc --listFiles` only includes the 8 desktop files**

```bash
bun x tsc --listFiles --noEmit | grep apps/desktop | sort -u
```

Expected: only the 8 files explicitly added in Task 12. Any extra desktop files appearing here means a tsconfig change leaked. Fix the include list.

- [ ] **Step 6: No commit needed for verification.**

If you reached this step with all green, the P1.A PR is ready. Push the branch and open a PR titled `feat(p1a): producer-validated CLI JSON schemas + desktop type contracts`.

---

## Final notes for the implementer

- **Schema discovery is iterative**: when you write a schema and the existing CLI test fails because the real output has a field you missed, add the field to the schema. The schema must reflect reality, not the other way around.
- **`parse` vs `safeParse`**: only use `safeParse` if you have a documented reason to tolerate shape drift in production. The default is `parse` everywhere — fail loud at CI time.
- **JSDoc paths**: `apps/desktop/src/conversations-poller.js` → `../../../src/cli/schema` (three levels up); files under `apps/desktop/src/modules/` need `../../../../src/cli/schema` (four levels up).
- **No new dependencies**: zod is already in `package.json`. No installs needed.
- **Frequent commits**: every task above ends with a commit. Don't batch — small commits make bisect easier if something regresses.
