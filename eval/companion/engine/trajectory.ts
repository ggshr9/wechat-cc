import { readFileSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'
// zod v4: named-import `{ z }` resolves to undefined under vitest's bundler;
// use the default export. Same pattern as src/cli/schema.ts.
import z from 'zod'

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
