import { Cron } from 'croner'
import type { CompanionConfig, Trigger } from './config'
import type { RunEntry, PushEntry } from './logs'

export interface EvalResult {
  pushed: boolean
  message?: string
  cost_usd: number
  tool_uses_count: number
  duration_ms: number
  error_message?: string
}

export interface SchedulerDeps {
  loadConfig: () => CompanionConfig
  runs: { append: (e: RunEntry) => void; rotate: () => void }
  pushes: { append: (e: PushEntry) => void; rotate: () => void }
  evalTrigger: (trigger: Trigger, ctx: { cfg: CompanionConfig }) => Promise<EvalResult>
  now: () => Date
}

const TICK_MS = 60_000

export function startScheduler(
  deps: SchedulerDeps,
  log: (tag: string, line: string) => void,
): () => Promise<void> {
  let stopped = false
  const timer = setInterval(() => {
    if (stopped) return
    tick(deps, log).catch(err => log('SCHED', `tick error: ${err}`))
    // rotation is cheap; run each tick
    deps.runs.rotate()
    deps.pushes.rotate()
  }, TICK_MS)

  return async () => {
    stopped = true
    clearInterval(timer)
  }
}

async function tick(deps: SchedulerDeps, log: (tag: string, line: string) => void): Promise<void> {
  const cfg = deps.loadConfig()
  if (!cfg.enabled) return
  const nowTime = deps.now()
  if (cfg.snooze_until && new Date(cfg.snooze_until).getTime() > nowTime.getTime()) {
    log('SCHED', `snoozed until ${cfg.snooze_until}`)
    return
  }
  for (const trigger of cfg.triggers) {
    try {
      if (trigger.paused_until && new Date(trigger.paused_until).getTime() > nowTime.getTime()) {
        continue
      }
      // Resolve active persona for this trigger's project
      const persona =
        cfg.per_project_persona[trigger.project] ??
        cfg.per_project_persona['_default'] ??
        'assistant'
      // Persona filter
      if (trigger.personas.length > 0 && !trigger.personas.includes(persona)) {
        continue
      }
      // Cron match: nextRun from one minute ago should land in this minute
      const cron = new Cron(trigger.schedule, { timezone: cfg.timezone, paused: true }, () => {})
      const prevMinute = new Date(nowTime.getTime() - 60_000)
      const nextFire = cron.nextRun(prevMinute)
      if (!nextFire) continue
      const floorNow = Math.floor(nowTime.getTime() / 60_000) * 60_000
      const floorFire = Math.floor(nextFire.getTime() / 60_000) * 60_000
      if (floorFire !== floorNow) continue

      const started = Date.now()
      const result = await deps.evalTrigger(trigger, { cfg })
      const duration_ms = Date.now() - started

      deps.runs.append({
        ts: nowTime.toISOString(),
        trigger_id: trigger.id,
        persona,
        duration_ms,
        pushed: result.pushed,
        reason: result.pushed ? 'ok' : 'no_push',
        tool_uses_count: result.tool_uses_count,
        cost_usd: result.cost_usd,
        error_message: result.error_message,
      })

      if (result.pushed && result.message) {
        deps.pushes.append({
          ts: nowTime.toISOString(),
          trigger_id: trigger.id,
          persona,
          message: result.message,
          chat_id: cfg.default_chat_id ?? '',
          delivery_status: 'ok',
        })
      }
    } catch (err) {
      log('SCHED', `trigger ${trigger.id} error: ${err}`)
    }
  }
}
