import { query, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { Trigger } from './config'
import type { Persona } from './persona'
import type { RunEntry, PushEntry } from './logs'
import type { EvalResult } from './scheduler'

export interface EvalContext {
  recent_pushes: PushEntry[]
  recent_runs: RunEntry[]
  profile: string
  persona: Persona
  chat_id: string
}

export interface EvalSessionDeps {
  sdkOptionsBase: () => Partial<Options>
  log: (tag: string, line: string) => void
}

export function makeEvalTrigger(
  deps: EvalSessionDeps,
): (trigger: Trigger, ctx: EvalContext) => Promise<EvalResult> {
  return async (trigger, ctx) => {
    const started = Date.now()
    let pushed = false
    let message: string | undefined
    let toolUses = 0
    let cost = 0
    let duration = 0

    const systemPrompt = [ctx.profile, '---', ctx.persona.body].join('\n\n')
    const base = deps.sdkOptionsBase()
    const options: Options = {
      ...base,
      permissionMode: 'bypassPermissions',
      systemPrompt,
      settingSources: ['user', 'project', 'local'],
    }
    // Ensure canUseTool is never inherited from base — isolated eval is bypass.
    delete (options as any).canUseTool

    const prompt = buildTaskPrompt(trigger, ctx)

    try {
      const q = query({ prompt, options })
      for await (const msg of q as AsyncIterable<SDKMessage>) {
        const m = msg as any
        if (m.type === 'assistant') {
          const content = m.message?.content
          if (Array.isArray(content)) {
            for (const b of content) {
              if (b?.type === 'tool_use') {
                toolUses++
                if (b.name === 'reply') {
                  pushed = true
                  const text = b.input?.text
                  if (typeof text === 'string') message = text
                }
              }
            }
          }
        } else if (m.type === 'result') {
          cost = Number(m.total_cost_usd ?? 0) || 0
          duration = Number(m.duration_ms ?? 0) || 0
        }
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      deps.log('EVAL', `trigger ${trigger.id} error: ${detail}`)
      return {
        pushed: false,
        cost_usd: 0,
        tool_uses_count: 0,
        duration_ms: Date.now() - started,
        error_message: detail,
      }
    }

    return {
      pushed,
      message,
      cost_usd: cost,
      tool_uses_count: toolUses,
      duration_ms: duration || (Date.now() - started),
    }
  }
}

function buildTaskPrompt(trigger: Trigger, ctx: EvalContext): string {
  const recent = ctx.recent_pushes.slice(-5).map(p =>
    `  - ${p.ts} [${p.trigger_id}] "${p.message.slice(0, 80)}"`,
  ).join('\n') || '  (none)'

  return `<eval_context>
  <trigger id="${trigger.id}" project="${trigger.project}" />
  <now iso="${new Date().toISOString()}" />
  <recent_pushes count="${ctx.recent_pushes.length}">
${recent}
  </recent_pushes>
  <min_push_gap_minutes>${ctx.persona.frontmatter.min_push_gap_minutes}</min_push_gap_minutes>
  <chat_id>${ctx.chat_id}</chat_id>
</eval_context>

任务：
${trigger.task}

若决定推送：调用 reply(chat_id="${ctx.chat_id}", text=...) 工具。
若决定不推送：什么都不做，让这轮安静结束，不要解释理由。`
}
