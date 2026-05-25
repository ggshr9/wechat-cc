import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
// zod v4: `import { z } from 'zod'` resolves to undefined under vitest's
// bundler; use the default export instead (both forms are equivalent at
// runtime — this is a build-tool interop quirk, not a zod API difference).
import z from 'zod'

export type AgentProviderKind = 'claude' | 'codex' | 'cursor'

export interface AgentConfig {
  provider: AgentProviderKind
  model?: string
  // Cursor-specific model id (e.g. 'composer-2'). Mirrors `model?`'s
  // optional-string shape so an operator can persist a Cursor model
  // alongside the Claude one without overloading a single field.
  cursorModel?: string
  // When true, the daemon spawned by `service install` runs with
  // `cli.ts run --dangerously` (Claude SDK permissionMode=bypassPermissions).
  // Wizard-installed daemons need this on by default — there is no human
  // to answer permission prompts triggered by inbound WeChat messages.
  dangerouslySkipPermissions: boolean
  // When true, `service install` registers the unit for auto-start at
  // login/boot (macOS RunAtLoad, systemd `enable`, schtasks ONLOGON).
  // v0.6 default: true — first-time GUI users expect the daemon to
  // survive reboot without an extra step.
  autoStart: boolean
  // When true, closing the desktop window terminates the daemon. Default
  // false (advanced setting): the GUI is the daemon's launcher, not its
  // host — closing the window should not stop inbound message handling.
  closeStopsDaemon: boolean
  // Admin-chosen self-name. Null/undefined → fall back to botNameForMode(mode).
  // Constrained to NICKNAME_RE (1-24 chars, CJK/Latin/digits/space/_/-).
  // Set via the daemon's onboarding flow (first admin scan) or `/name` command.
  bot_name?: string | null
  // A2A: optional listener and registered peer agent records.
  a2a_listen?: A2AListen
  a2a_agents?: A2AAgentRecord[]
}

// ── A2A sub-schemas ──────────────────────────────────────────────────────────

export const A2AAgentRecord = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'agent id must match ^[a-z0-9][a-z0-9-]{0,63}$ (lowercase slug)'),
  name: z.string().min(1).max(128),
  url: z.string().url(),
  inbound_api_key: z.string().min(16),
  outbound_api_key: z.string().min(1),
  capabilities: z.array(z.string()),
  paused: z.boolean().default(false),
})

export const A2AListen = z.object({
  host: z.string().default('127.0.0.1'),
  port: z.number().int().min(1).max(65535),
})

export type A2AAgentRecord = z.infer<typeof A2AAgentRecord>
export type A2AListen = z.infer<typeof A2AListen>

const AgentConfigSchema = z.object({
  provider: z.enum(['claude', 'codex', 'cursor']).default('claude'),
  model: z.string().optional(),
  cursorModel: z.string().optional(),
  dangerouslySkipPermissions: z.boolean().default(true),
  autoStart: z.boolean().default(true),
  closeStopsDaemon: z.boolean().default(false),
  a2a_listen: A2AListen.optional(),
  a2a_agents: z.array(A2AAgentRecord).optional()
    .superRefine((arr, ctx) => {
      const ids = new Set<string>()
      for (const a of arr ?? []) {
        if (ids.has(a.id)) ctx.addIssue({ code: 'custom', message: `duplicate a2a agent id: ${a.id}` })
        ids.add(a.id)
      }
    }),
  bot_name: z.string().nullable().optional(),
})

/**
 * Parse and validate an agent config object using the Zod schema.
 * Throws a ZodError (with descriptive messages) on invalid input.
 * Use this when you have a raw/untrusted object (e.g. loaded from disk
 * by a caller that wants strict validation).
 */
export function parseAgentConfig(raw: unknown): AgentConfig {
  return AgentConfigSchema.parse(raw) as AgentConfig
}

const CONFIG_FILE = 'agent-config.json'

export function loadAgentConfig(stateDir: string): AgentConfig {
  try {
    const raw = readFileSync(join(stateDir, CONFIG_FILE), 'utf8')
    const parsed = JSON.parse(raw) as Partial<AgentConfig> & { keepAlive?: boolean }
    const dangerouslySkipPermissions = parsed.dangerouslySkipPermissions ?? true
    const autoStart = parsed.autoStart ?? true
    const closeStopsDaemon = parsed.closeStopsDaemon ?? false
    const provider: AgentProviderKind =
      parsed.provider === 'codex' ? 'codex'
      : parsed.provider === 'cursor' ? 'cursor'
      : 'claude'
    // Preserve `model` for both providers. Pre-2026-05-08 only codex
    // honored it; claude inherited the spawned CLI's default which read
    // `~/.claude/.claude.json` and broke daemons whenever the user's
    // interactive alias was something the SDK subprocess couldn't resolve
    // (e.g. fast-mode `opus[1m]` returning 404 from 2.1.133).
    // Parse a2a fields through the sub-schemas so we get validated types.
    // safeParse: if the sub-field is malformed we silently drop it rather
    // than crashing the entire config load (same lenient posture as the
    // rest of this function).
    const a2aListen = parsed.a2a_listen != null
      ? A2AListen.safeParse(parsed.a2a_listen).data
      : undefined
    const a2aAgentsRaw = Array.isArray(parsed.a2a_agents) ? parsed.a2a_agents : undefined
    const a2aAgents = a2aAgentsRaw != null
      ? a2aAgentsRaw.flatMap(r => {
          const result = A2AAgentRecord.safeParse(r)
          return result.success ? [result.data] : []
        })
      : undefined

    return {
      provider,
      ...(typeof parsed.model === 'string' ? { model: parsed.model } : {}),
      ...(typeof parsed.cursorModel === 'string' ? { cursorModel: parsed.cursorModel } : {}),
      dangerouslySkipPermissions,
      autoStart,
      closeStopsDaemon,
      ...(a2aListen ? { a2a_listen: a2aListen } : {}),
      ...(a2aAgents && a2aAgents.length > 0 ? { a2a_agents: a2aAgents } : {}),
      ...(parsed.bot_name === null ? { bot_name: null } : {}),
      ...(typeof parsed.bot_name === 'string' ? { bot_name: parsed.bot_name } : {}),
    }
  } catch {
    return { provider: 'claude', dangerouslySkipPermissions: true, autoStart: true, closeStopsDaemon: false }
  }
}

export function saveAgentConfig(stateDir: string, config: AgentConfig): void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const file = join(stateDir, CONFIG_FILE)
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, file)
}
