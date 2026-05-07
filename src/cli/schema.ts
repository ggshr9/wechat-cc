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
})

const ServiceKind = z.enum(['launchagent', 'scheduled-task', 'systemd-user'])

const ServiceSnapshot = z.object({
  installed: z.boolean(),
  kind: ServiceKind,
})

const AgentProviderKind = z.enum(['claude', 'codex'])

const DmPolicy = z.enum(['allowlist', 'disabled'])

const AccessSnapshot = z.object({
  dmPolicy: DmPolicy,
  allowFrom: z.array(z.string()),
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
    accounts: DoctorCheckBase.extend({
      count: z.number(),
      items: z.array(BoundAccount),
    }),
    access: DoctorCheckBase.extend({
      dmPolicy: DmPolicy,
      allowFromCount: z.number(),
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
  dangerouslySkipPermissions: z.boolean(),
  autoStart: z.boolean(),
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
