/**
 * Introspect tick — Claude reviews recent activity + memory + own past
 * observations, decides whether to write a new observation. Critically:
 * NEVER pushes to the user. The output goes only to observations.jsonl;
 * surprise comes from the user opening the memory pane and finding something
 * new.
 *
 * The agent abstraction (runIntrospect) is injected: in production it spawns
 * an isolated SDK session with a tightly scoped prompt; in tests it's a
 * deterministic stub.
 */
import type { EventsStore } from '../events/store'
import type { ObservationsStore, ObservationTone } from '../observations/store'

export interface IntrospectAgent {
  runIntrospect(): Promise<{
    write: boolean
    body?: string
    tone?: ObservationTone
    reasoning: string
  }>
}

export interface IntrospectDeps {
  events: EventsStore
  observations: ObservationsStore
  agent: IntrospectAgent
  chatId: string
  log: (tag: string, msg: string) => void
}

export async function runIntrospectTick(deps: IntrospectDeps): Promise<void> {
  let result
  try {
    result = await deps.agent.runIntrospect()
  } catch (err) {
    deps.log('INTROSPECT', `agent failed: ${err instanceof Error ? err.message : String(err)}`)
    return
  }

  if (!result.write || !result.body) {
    await deps.events.append({
      kind: 'cron_eval_skipped',
      trigger: 'introspect',
      reasoning: result.reasoning,
    })
    return
  }

  const obsId = await deps.observations.append({
    body: result.body,
    ...(result.tone ? { tone: result.tone } : {}),
  })
  await deps.events.append({
    kind: 'observation_written',
    trigger: 'introspect',
    reasoning: result.reasoning,
    observation_id: obsId,
  })
}
