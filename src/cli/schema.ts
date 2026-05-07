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
