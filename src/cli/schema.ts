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
// zod v4: `import { z } from 'zod'` resolves to undefined under vitest's
// bundler; use the default export instead (both forms are equivalent at
// runtime — this is a build-tool interop quirk, not a zod API difference).
import z from 'zod'

// ── Shared building blocks ────────────────────────────────────────────────────

const Runtime = z.enum(['source', 'compiled-bundle'])

const FixHint = z.object({
  command: z.string().optional(),
  action: z.string().optional(),
  link: z.string().optional(),
})

const Severity = z.enum(['hard', 'soft'])

/** Base fields shared by all `checks.*` entries that have ok/severity/fix. */
const DoctorCheckBase = z.object({
  ok: z.boolean(),
  severity: Severity.optional(),
  fix: FixHint.optional(),
})

const BoundAccount = z.object({
  id: z.string(),
  botId: z.string(),
  userId: z.string(),
  baseUrl: z.string(),
})

const ExpiredBotEntry = z.object({
  botId: z.string(),
  firstSeenExpiredAt: z.string(),
  lastReason: z.string().optional(),
})

const DaemonSnapshot = z.object({
  alive: z.boolean(),
  pid: z.number().nullable(),
  /** Present only when daemon is alive and internal-api-info.json is readable. */
  internal_api: z.object({ port: z.number(), token_file_path: z.string() }).optional(),
})

const ServiceKind = z.enum(['launchagent', 'scheduled-task', 'systemd-user'])

const ServiceSnapshot = z.object({
  installed: z.boolean(),
  kind: ServiceKind,
})

const AgentProviderKind = z.enum(['claude', 'codex', 'cursor', 'gemini'])

const DmPolicy = z.enum(['allowlist', 'disabled'])

const AccessSnapshot = z.object({
  dmPolicy: DmPolicy,
  allowFrom: z.array(z.string()),
  admins: z.array(z.string()).optional(),
})

// ── wechat-cc doctor --json ───────────────────────────────────────────────────

export const DoctorOutput = z.object({
  ready: z.boolean(),
  stateDir: z.string(),
  runtime: Runtime,
  wslDetected: z.boolean(),
  checks: z.object({
    bun: DoctorCheckBase.extend({ path: z.string().nullable() }),
    git: DoctorCheckBase.extend({ path: z.string().nullable() }),
    claude: DoctorCheckBase.extend({ path: z.string().nullable() }),
    codex: DoctorCheckBase.extend({ path: z.string().nullable() }),
    // Cursor has no PATH binary — SDK + API key are the install signals.
    // Both must be true for the daemon's bootstrap to register cursor
    // (see src/daemon/bootstrap/index.ts) so `ok` mirrors that AND.
    cursor: DoctorCheckBase.extend({
      apiKeySet: z.boolean(),
      sdkInstalled: z.boolean(),
    }),
    accounts: DoctorCheckBase.extend({
      count: z.number(),
      items: z.array(BoundAccount),
    }),
    access: DoctorCheckBase.extend({
      dmPolicy: DmPolicy,
      allowFromCount: z.number(),
      admins: z.array(z.string()).optional(),
    }),
    provider: DoctorCheckBase.extend({
      provider: AgentProviderKind,
      model: z.string().optional(),
      binaryPath: z.string().nullable(),
    }),
    daemon: DaemonSnapshot,
    service: ServiceSnapshot,
  }),
  userNames: z.record(z.string(), z.string()),
  expiredBots: z.array(ExpiredBotEntry),
  nextActions: z.array(z.string()),
})
export type DoctorOutputT = z.infer<typeof DoctorOutput>

// ── wechat-cc setup-poll --json ───────────────────────────────────────────────
// Mirrors the SetupPollResult discriminated union from src/cli/setup-flow.ts.

const SetupPollStatusSimple = z.object({
  status: z.enum(['wait', 'scaned', 'expired']),
})

const SetupPollStatusRedirect = z.object({
  status: z.literal('scaned_but_redirect'),
  baseUrl: z.string(),
})

const SetupPollStatusConfirmed = z.object({
  status: z.literal('confirmed'),
  accountId: z.string(),
  userId: z.string(),
  // 'first' | 'reconnect' | 'redundant' | 'new_account' — see setup-flow.ts
  // and docs/specs/2026-05-10-rescan-feedback.md for the full state machine.
  scenario: z.enum(['first', 'reconnect', 'redundant', 'new_account']),
})

export const SetupPollOutput = z.discriminatedUnion('status', [
  SetupPollStatusSimple,
  SetupPollStatusRedirect,
  SetupPollStatusConfirmed,
])
export type SetupPollOutputT = z.infer<typeof SetupPollOutput>

// ── wechat-cc setup-status --json ────────────────────────────────────────────
// Mirrors the return value of setupStatus() from src/cli/doctor.ts.

export const SetupStatusOutput = z.object({
  stateDir: z.string(),
  bound: z.boolean(),
  accounts: z.array(BoundAccount),
  access: AccessSnapshot,
  provider: AgentProviderKind,
  model: z.string().optional(),
  daemon: DaemonSnapshot,
  service: ServiceSnapshot,
})
export type SetupStatusOutputT = z.infer<typeof SetupStatusOutput>

// ── wechat-cc setup --qr-json ─────────────────────────────────────────────────
// Output of `requestSetupQrCode()` (src/cli/setup-flow.ts).
// Consumed by apps/desktop/src/modules/qr.js via `invoke("wechat_cli_json", { args: ["setup", "--qr-json"] })`.

export const SetupQrJsonOutput = z.object({
  qrcode: z.string(),
  qrcode_img_content: z.string(),
  expires_in_ms: z.number(),
})
export type SetupQrJsonOutputT = z.infer<typeof SetupQrJsonOutput>

// ── wechat-cc service <action> --json ─────────────────────────────────────────

// Inline ServicePlan shape (mirrors ServicePlan interface in service-manager.ts).
// Embedded in every service --json response so consumers can inspect commands.
const ServicePlanSchema = z.object({
  kind: ServiceKind,
  serviceName: z.string(),
  serviceFile: z.string().nullable(),
  fileContent: z.string().nullable(),
  installCommands: z.array(z.array(z.string())),
  startCommands: z.array(z.array(z.string())),
  stopCommands: z.array(z.array(z.string())),
  uninstallCommands: z.array(z.array(z.string())),
})

// AgentConfig shape (mirrors AgentConfig interface in src/lib/agent-config.ts).
const AgentConfigSchema = z.object({
  provider: AgentProviderKind,
  model: z.string().optional(),
  cursorModel: z.string().optional(),
  geminiModel: z.string().optional(),
  dangerouslySkipPermissions: z.boolean(),
  autoStart: z.boolean(),
  closeStopsDaemon: z.boolean(),
})

// wechat-cc service status --json
// Emits { ...ServiceStatusReport, plan, agentConfig } — always succeeds when
// reached (failures exit non-zero without printing JSON).
export const ServiceStatusOutput = z.object({
  installed: z.boolean(),
  alive: z.boolean(),
  pid: z.number().nullable(),
  state: z.enum(['missing', 'running', 'stale', 'stopped']),
  plan: ServicePlanSchema,
  agentConfig: AgentConfigSchema,
})
export type ServiceStatusOutputT = z.infer<typeof ServiceStatusOutput>

// wechat-cc service install --json
// Success: { ok: true, action: 'install', plan, agentConfig, dryRun }
// (install throws on failure — ok: false arm reserved for future error output)
export const ServiceInstallOutput = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    action: z.literal('install'),
    plan: ServicePlanSchema,
    agentConfig: AgentConfigSchema,
    dryRun: z.boolean(),
  }),
  z.object({ ok: z.literal(false), error: z.string() }),
])
export type ServiceInstallOutputT = z.infer<typeof ServiceInstallOutput>

// wechat-cc service start --json
export const ServiceStartOutput = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    action: z.literal('start'),
    plan: ServicePlanSchema,
    agentConfig: AgentConfigSchema,
    dryRun: z.boolean(),
  }),
  z.object({ ok: z.literal(false), error: z.string() }),
])
export type ServiceStartOutputT = z.infer<typeof ServiceStartOutput>

// wechat-cc service stop --json
export const ServiceStopOutput = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    action: z.literal('stop'),
    plan: ServicePlanSchema,
    agentConfig: AgentConfigSchema,
    dryRun: z.boolean(),
  }),
  z.object({ ok: z.literal(false), error: z.string() }),
])
export type ServiceStopOutputT = z.infer<typeof ServiceStopOutput>

// wechat-cc service uninstall --json
export const ServiceUninstallOutput = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    action: z.literal('uninstall'),
    plan: ServicePlanSchema,
    agentConfig: AgentConfigSchema,
    dryRun: z.boolean(),
  }),
  z.object({ ok: z.literal(false), error: z.string() }),
])
export type ServiceUninstallOutputT = z.infer<typeof ServiceUninstallOutput>

// ── wechat-cc install-progress --json ────────────────────────────────────────
// Reads install-progress.json from STATE_DIR (written by the service install
// onProgress hook). Returns {} when no install is in flight — that empty-object
// case is NOT matched by this schema; consumers should handle it separately.

export const InstallProgressOutput = z.object({
  step: z.number(),
  total: z.number(),
  label: z.string(),
  ts: z.number(),
})
export type InstallProgressOutputT = z.infer<typeof InstallProgressOutput>

// ── wechat-cc account remove <bot-id> --json ─────────────────────────────────
// Success: { ok: true, ...RemoveAccountResult, restartRequired: true }
// (removeAccount() throws on invalid botId — ok: false arm handles rethrown error)

export const AccountRemoveOutput = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    botId: z.string(),
    removed: z.array(z.string()),
    warnings: z.array(z.string()),
    restartRequired: z.literal(true),
  }),
  z.object({ ok: z.literal(false), error: z.string() }),
])
export type AccountRemoveOutputT = z.infer<typeof AccountRemoveOutput>

// ── wechat-cc daemon kill <pid> --json ────────────────────────────────────────
// Emits KillResult directly (no ok wrapper): { killed, pid, message }.
// Discriminated union on `killed` covers the success and failure branches
// that killDaemonByPid returns (process exits non-zero when killed=false).

export const DaemonKillOutput = z.discriminatedUnion('killed', [
  z.object({ killed: z.literal(true), pid: z.number(), message: z.string() }),
  z.object({ killed: z.literal(false), pid: z.number(), message: z.string() }),
])
export type DaemonKillOutputT = z.infer<typeof DaemonKillOutput>

// ── wechat-cc provider show --json ───────────────────────────────────────────
// Emits loadAgentConfig() verbatim — same shape as AgentConfigSchema.
// Always succeeds when reached (loadAgentConfig falls back to defaults).

export const ProviderShowOutput = AgentConfigSchema
export type ProviderShowOutputT = z.infer<typeof ProviderShowOutput>

// ── wechat-cc memory list --json ─────────────────────────────────────────────
// Emits listAllMemory() verbatim: MemoryUserEntry[] (may be empty array).
// Each entry has userId, fileCount, totalBytes, and files[].
// files[] items have name, path (relative to user dir), size (bytes), mtime (ISO).

const MemoryFileEntry = z.object({
  name: z.string(),
  path: z.string(),
  size: z.number(),
  mtime: z.string(),
})

const MemoryUserEntry = z.object({
  userId: z.string(),
  fileCount: z.number(),
  totalBytes: z.number(),
  files: z.array(MemoryFileEntry),
})

export const MemoryListOutput = z.array(MemoryUserEntry)
export type MemoryListOutputT = z.infer<typeof MemoryListOutput>

// ── wechat-cc memory read <user-id> <path> --json ────────────────────────────
// Success: { ok: true, userId, path, content }
// Error  : { ok: false, error } — emitted on stdout (exit 0) so GUI callers
//          can read structured failure rather than crash on non-zero exit.

export const MemoryReadOutput = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    userId: z.string(),
    path: z.string(),
    content: z.string(),
  }),
  z.object({ ok: z.literal(false), error: z.string() }),
])
export type MemoryReadOutputT = z.infer<typeof MemoryReadOutput>

// ── wechat-cc memory write <user-id> <path> --body-base64 <b64> --json ───────
// Success: { ok: true, userId, path, bytesWritten, created }
//   (spreads writeMemoryFile() result { bytesWritten, created } + positional args)
// Error  : { ok: false, error } — emitted on stdout (exit 0) so GUI callers
//          can read structured failure rather than crash on non-zero exit.

export const MemoryWriteOutput = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    userId: z.string(),
    path: z.string(),
    bytesWritten: z.number(),
    created: z.boolean(),
  }),
  z.object({ ok: z.literal(false), error: z.string() }),
])
export type MemoryWriteOutputT = z.infer<typeof MemoryWriteOutput>

// ── wechat-cc events list --json ──────────────────────────────────────────────
// Emits { ok: true, events: EventRecord[] }.
// EventRecord fields: id, ts, kind (EventKind), trigger, reasoning,
// plus optional push_text, observation_id, milestone_id, jsonl_session_id.

const EventKind = z.enum([
  'cron_eval_pushed',
  'cron_eval_skipped',
  'cron_eval_failed',
  'observation_written',
  'milestone',
])

const EventEntry = z.object({
  id: z.string(),
  ts: z.string(),
  kind: EventKind,
  trigger: z.string(),
  reasoning: z.string(),
  push_text: z.string().optional(),
  observation_id: z.string().optional(),
  milestone_id: z.string().optional(),
  jsonl_session_id: z.string().optional(),
})

export const EventsListOutput = z.object({
  ok: z.literal(true),
  events: z.array(EventEntry),
})
export type EventsListOutputT = z.infer<typeof EventsListOutput>

// ── wechat-cc observations list --json ───────────────────────────────────────
// Emits { ok: true, observations: ObservationRecord[] } (active or archived).
// ObservationRecord fields: id, ts, body, plus optional tone, archived flag,
// archived_at, event_id.

const ObservationTone = z.enum(['concern', 'curious', 'proud', 'playful', 'quiet'])

const ObservationEntry = z.object({
  id: z.string(),
  ts: z.string(),
  body: z.string(),
  tone: ObservationTone.optional(),
  archived: z.boolean(),
  archived_at: z.string().optional(),
  event_id: z.string().optional(),
})

export const ObservationsListOutput = z.object({
  ok: z.literal(true),
  observations: z.array(ObservationEntry),
})
export type ObservationsListOutputT = z.infer<typeof ObservationsListOutput>

// ── wechat-cc observations archive --json ────────────────────────────────────
// Emits { ok: true, archived: <obs-id> } — scalar, not an array.

export const ObservationsArchiveOutput = z.object({
  ok: z.literal(true),
  archived: z.string(),
})
export type ObservationsArchiveOutputT = z.infer<typeof ObservationsArchiveOutput>

// ── wechat-cc milestones list --json ─────────────────────────────────────────
// Emits { ok: true, milestones: MilestoneRecord[] } (id-deduped).
// MilestoneRecord fields: id, ts, body, plus optional event_id.

const MilestoneEntry = z.object({
  id: z.string(),
  ts: z.string(),
  body: z.string(),
  event_id: z.string().optional(),
})

export const MilestonesListOutput = z.object({
  ok: z.literal(true),
  milestones: z.array(MilestoneEntry),
})
export type MilestonesListOutputT = z.infer<typeof MilestonesListOutput>

// ── wechat-cc sessions list-projects --json ───────────────────────────────────
// Emits { ok: true, projects: ProjectEntry[] }.
// ProjectEntry fields: alias, session_id, last_used_at, summary (nullable),
// summary_updated_at (nullable).

const ProjectEntry = z.object({
  alias: z.string(),
  session_id: z.string(),
  last_used_at: z.string(),
  summary: z.string().nullable(),
  summary_updated_at: z.string().nullable(),
})

export const SessionsListProjectsOutput = z.object({
  ok: z.literal(true),
  projects: z.array(ProjectEntry),
})
export type SessionsListProjectsOutputT = z.infer<typeof SessionsListProjectsOutput>

// ── wechat-cc sessions list-chats --json ──────────────────────────────────────
// Emits { ok: true, chats: ChatEntry[] } for the desktop contact sidebar.
const ChatEntry = z.object({
  chat_id: z.string(),
  user_name: z.string().nullable(),
  account_id: z.string().nullable(),
  session_count: z.number(),
  last_used_at: z.string(),
})

export const SessionsListChatsOutput = z.object({
  ok: z.literal(true),
  chats: z.array(ChatEntry),
})
export type SessionsListChatsOutputT = z.infer<typeof SessionsListChatsOutput>

// ── wechat-cc sessions read-jsonl --json ──────────────────────────────────────
// Discriminated union: success emits { ok: true, alias, session_id, turns }
// (codex sessions additionally carry provider:'codex'); error paths emit
// { ok: false, error } with optional extra fields (path, codex_root).
// turns/events are opaque — shape varies widely across claude/codex providers.

export const SessionsReadJsonlOutput = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    alias: z.string(),
    session_id: z.string(),
    provider: z.string().optional(),
    turns: z.array(z.unknown()),
  }),
  z.object({
    ok: z.literal(false),
    error: z.string(),
    path: z.string().optional(),
    codex_root: z.string().optional(),
  }),
])
export type SessionsReadJsonlOutputT = z.infer<typeof SessionsReadJsonlOutput>

// ── wechat-cc sessions delete --json ─────────────────────────────────────────
// Always emits { ok: true, deleted: <alias> } — throws on unexpected failures.

export const SessionsDeleteOutput = z.object({
  ok: z.literal(true),
  deleted: z.string(),
})
export type SessionsDeleteOutputT = z.infer<typeof SessionsDeleteOutput>

// ── wechat-cc sessions search --json ─────────────────────────────────────────
// Emits { ok: true, query, hits: HitEntry[] }.
// HitEntry shape from searcher: { alias, snippet, ... } — extended fields are
// opaque so the hit items are typed as unknown for forward-compatibility.

export const SessionsSearchOutput = z.object({
  ok: z.literal(true),
  query: z.string(),
  hits: z.array(z.unknown()),
})
export type SessionsSearchOutputT = z.infer<typeof SessionsSearchOutput>

// ── wechat-cc demo seed --json ────────────────────────────────────────────────
// Emits { ok: true, ...seedDemo() result } where seedDemo returns
// { observations, milestones, events } (all counts as numbers).
// cli.ts: console.log(JSON.stringify({ ok: true, ...result }, null, 2))

export const DemoSeedOutput = z.object({
  ok: z.literal(true),
  observations: z.number(),
  milestones: z.number(),
  events: z.number(),
})
export type DemoSeedOutputT = z.infer<typeof DemoSeedOutput>

// ── wechat-cc demo unseed --json ──────────────────────────────────────────────
// Emits { ok: true, ...unseedDemo() result } where unseedDemo returns
// { removed } (total row count removed across all demo stores). Idempotent —
// removed may be 0 on a second call.

export const DemoUnseedOutput = z.object({
  ok: z.literal(true),
  removed: z.number(),
})
export type DemoUnseedOutputT = z.infer<typeof DemoUnseedOutput>

// ── wechat-cc reply [--to <chat_id>] [text] --json ───────────────────────────
// Success: { ok: true, chat_id, chunks, account }
//   (chat_id from --to / defaultTerminalChatId; chunks/account from sendReplyOnce)
// Error  : { ok: false, error } — emitted on stdout (exit 1) so GUI callers
//          can read structured failure rather than crash on non-zero exit.

export const ReplyOutput = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    chat_id: z.string(),
    chunks: z.number(),
    account: z.string(),
  }),
  z.object({ ok: z.literal(false), error: z.string() }),
])
export type ReplyOutputT = z.infer<typeof ReplyOutput>

// ── wechat-cc update --check --json ──────────────────────────────────────────
// Emits analyzeUpdate() result verbatim: UpdateProbe from src/cli/update.ts.
// ok:true contains git state; ok:false contains reason + message + optional details.
// All non-ok/mode fields are optional because the probe short-circuits on
// early errors before the git state fields are populated.

const UpdateReason = z.enum([
  'dirty_tree',
  'diverged',
  'detached_head',
  'fetch_failed',
  'pull_conflict',
  'install_failed',
  'bun_missing',
  'rebuild_failed',
  'daemon_running_not_service',
  'service_stop_failed',
  'not_a_git_repo',
])

export const UpdateCheckOutput = z.object({
  ok: z.boolean(),
  mode: z.literal('check'),
  currentCommit: z.string().optional(),
  latestCommit: z.string().optional(),
  updateAvailable: z.boolean().optional(),
  behind: z.number().optional(),
  aheadOfRemote: z.number().optional(),
  lockfileWillChange: z.boolean().optional(),
  // 2026-05-08 sentinel-based binary-staleness check (commit 0a94357).
  // Set unconditionally when binary mode is active; absent in dev mode.
  binaryStale: z.boolean().optional(),
  binaryPath: z.string().optional(),
  dirty: z.boolean().optional(),
  dirtyFiles: z.array(z.string()).optional(),
  reason: UpdateReason.optional(),
  message: z.string().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
})
export type UpdateCheckOutputT = z.infer<typeof UpdateCheckOutput>

// ── wechat-cc update --json (apply path) ──────────────────────────────────────
// Discriminated union on `ok` matching UpdateApplied | UpdateRejected.
// Both arms carry mode: 'apply'. The ok:false arm also covers the synthetic
// not_a_git_repo case emitted when running from a compiled desktop bundle.

const DaemonAction = z.enum(['restarted', 'noop', 'restart_failed'])

export const UpdateApplyOutput = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    mode: z.literal('apply'),
    fromCommit: z.string(),
    toCommit: z.string(),
    lockfileChanged: z.boolean(),
    installRan: z.boolean(),
    // 2026-05-08 binary-rebuild step (commit 3707980 + 0a94357 sentinel).
    // True only when binary mode active AND `bun build --compile` ran;
    // dev-mode (bun cli.ts) and unchanged-binary fast-paths leave it false.
    rebuildRan: z.boolean(),
    daemonAction: DaemonAction,
    elapsedMs: z.number(),
  }),
  z.object({
    ok: z.literal(false),
    mode: z.literal('apply'),
    reason: UpdateReason,
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
])
export type UpdateApplyOutputT = z.infer<typeof UpdateApplyOutput>

// ── wechat-cc conversations list --json ───────────────────────────────────────
// Emits { ok: true, conversations: ConversationEntry[] }.
// Per-entry: chat_id, plus nullable identity fields user_id/account_id/user_name
// sourced from conversationStore.getIdentity (v0.6 PR5 Task 22).
// `mode` is the Mode discriminated union from src/core/conversation.ts —
// typed as z.unknown() so that adding new Mode.kind values (P3+) doesn't
// require a schema update; the mode.kind string is validated at runtime
// by the coordinator, not by this consumer-side schema.

const ConversationEntry = z.object({
  chat_id: z.string(),
  user_id: z.string().nullable(),
  account_id: z.string().nullable(),
  user_name: z.string().nullable(),
  mode: z.unknown(),
})

export const ConversationsListOutput = z.object({
  ok: z.literal(true),
  conversations: z.array(ConversationEntry),
})
export type ConversationsListOutputT = z.infer<typeof ConversationsListOutput>

// ── wechat-cc logs [--tail N] --json ─────────────────────────────────────────
// Emits tailLog() result when --json flag is set. Always the ok:true branch
// (the ok:false LogTailError is only printed without --json, as process.exit(1)).
// entries[].raw is the original log line; timestamp/tag/message are parsed fields
// (empty strings when the line doesn't match the daemon's standard format).

const LogEntry = z.object({
  timestamp: z.string(),
  tag: z.string(),
  message: z.string(),
  raw: z.string(),
})

export const LogsOutput = z.object({
  ok: z.literal(true),
  logFile: z.string(),
  totalLines: z.number(),
  entries: z.array(LogEntry),
})
export type LogsOutputT = z.infer<typeof LogsOutput>

// ── wechat-cc guard status --json ─────────────────────────────────────────────
// Live one-shot probe: current external IP + reachability check.
// Output is the `out` object assembled in guardStatusCmd (cli.ts ~L622).
// ip and probe_ms are nullable (null when probe failed or ip fetch errored).

export const GuardStatusOutput = z.object({
  enabled: z.boolean(),
  ip: z.string().nullable(),
  reachable: z.boolean(),
  probe_url: z.string(),
  ip_error: z.string().nullable(),
  probe_error: z.string().nullable(),
  probe_ms: z.number().nullable(),
})
export type GuardStatusOutputT = z.infer<typeof GuardStatusOutput>

// ── wechat-cc guard enable --json ────────────────────────────────────────────
// Emits { ok: true, enabled: true } after writing cfg.enabled = true.

export const GuardEnableOutput = z.object({
  ok: z.literal(true),
  enabled: z.boolean(),
})
export type GuardEnableOutputT = z.infer<typeof GuardEnableOutput>

// ── wechat-cc guard disable --json ───────────────────────────────────────────
// Emits { ok: true, enabled: false } after writing cfg.enabled = false.

export const GuardDisableOutput = z.object({
  ok: z.literal(true),
  enabled: z.boolean(),
})
export type GuardDisableOutputT = z.infer<typeof GuardDisableOutput>

// ── wechat-cc avatar info --json ──────────────────────────────────────────────
// Emits { ok: true, ...avatarInfo() } where avatarInfo returns { exists, path }.
// `exists` is false when no avatar has been stored for the given key.

export const AvatarInfoOutput = z.object({
  ok: z.literal(true),
  exists: z.boolean(),
  path: z.string(),
})
export type AvatarInfoOutputT = z.infer<typeof AvatarInfoOutput>

// ── wechat-cc avatar set --json ───────────────────────────────────────────────
// Success: { ok: true, path } — setAvatar() return value.
// Error  : { ok: false, error } — caught exception re-emitted as JSON (exit 1).

export const AvatarSetOutput = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), path: z.string() }),
  z.object({ ok: z.literal(false), error: z.string() }),
])
export type AvatarSetOutputT = z.infer<typeof AvatarSetOutput>

// ── wechat-cc avatar remove --json ───────────────────────────────────────────
// Always emits { ok: true, path } — removeAvatar() is idempotent (no-op if
// the file is already absent). No error branch: failures in removeAvatar are
// not caught; the process exits without JSON output on fs errors.

export const AvatarRemoveOutput = z.object({
  ok: z.literal(true),
  path: z.string(),
})
export type AvatarRemoveOutputT = z.infer<typeof AvatarRemoveOutput>

// ── wechat-cc log <tag> <msg> [--fields <json>] --json ────────────────────────
// Emits { ok: true } on success.  No error branch: --fields JSON parse
// failures exit non-zero without emitting JSON (process.exit(2) with stderr).

export const LogOutput = z.object({ ok: z.literal(true) })
export type LogOutputT = z.infer<typeof LogOutput>
