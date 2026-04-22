import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeEvalTrigger, type EvalSessionDeps } from './eval-session'
import type { Trigger } from './config'

const fakeQuery = vi.fn()
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (params: unknown) => fakeQuery(params),
}))

const TRIGGER: Trigger = {
  id: 't1',
  project: 'P',
  schedule: '* * * * *',
  task: 'do X',
  personas: [],
  on_failure: 'silent',
  created_at: '2026-04-22T00:00:00Z',
}

const PERSONA = {
  frontmatter: {
    name: 'assistant',
    display_name: '小助手',
    min_push_gap_minutes: 10,
    quiet_hours_local: '',
  },
  body: '# persona body',
  sourcePath: '/x/assistant.md',
} as const

describe('evalTrigger', () => {
  beforeEach(() => {
    fakeQuery.mockClear()
  })

  it('spawns query with bypassPermissions + persona/profile as systemPrompt', async () => {
    async function* gen() {
      yield { type: 'result', session_id: 's', num_turns: 1, total_cost_usd: 0.01, duration_ms: 1000 }
    }
    fakeQuery.mockImplementation(() => gen())

    const evalTrigger = makeEvalTrigger({
      sdkOptionsBase: () => ({ cwd: '/p', mcpServers: { wechat: { type: 'sdk', name: 'wechat' } } as any }),
      log: () => {},
    })

    const result = await evalTrigger(TRIGGER, {
      recent_pushes: [],
      recent_runs: [],
      profile: 'PROFILE_CONTENT',
      persona: PERSONA,
      chat_id: 'c1',
    })

    expect(fakeQuery).toHaveBeenCalledTimes(1)
    const params = fakeQuery.mock.calls[0]![0] as any
    expect(params.options.permissionMode).toBe('bypassPermissions')
    expect(params.options.systemPrompt).toContain('PROFILE_CONTENT')
    expect(params.options.systemPrompt).toContain('# persona body')
    expect(params.options.canUseTool).toBeUndefined()
    expect(params.prompt).toContain('do X')
    expect(params.prompt).toContain('c1')
    expect(result.pushed).toBe(false)
  })

  it('detects pushed=true when assistant message contains reply tool_use', async () => {
    async function* gen() {
      yield {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'reply', input: { chat_id: 'c1', text: 'push-text' } },
          ],
        },
      }
      yield { type: 'result', session_id: 's', num_turns: 1, total_cost_usd: 0.012, duration_ms: 800 }
    }
    fakeQuery.mockImplementation(() => gen())

    const evalTrigger = makeEvalTrigger({ sdkOptionsBase: () => ({}), log: () => {} })
    const result = await evalTrigger(TRIGGER, {
      recent_pushes: [],
      recent_runs: [],
      profile: 'p',
      persona: PERSONA,
      chat_id: 'c1',
    })
    expect(result.pushed).toBe(true)
    expect(result.message).toBe('push-text')
    expect(result.cost_usd).toBe(0.012)
    expect(result.tool_uses_count).toBe(1)
  })

  it('silent completion when no reply tool invoked', async () => {
    async function* gen() {
      yield {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'just thinking' }] },
      }
      yield { type: 'result', session_id: 's', num_turns: 1, total_cost_usd: 0.005, duration_ms: 500 }
    }
    fakeQuery.mockImplementation(() => gen())

    const evalTrigger = makeEvalTrigger({ sdkOptionsBase: () => ({}), log: () => {} })
    const result = await evalTrigger(TRIGGER, {
      recent_pushes: [],
      recent_runs: [],
      profile: 'p',
      persona: PERSONA,
      chat_id: 'c1',
    })
    expect(result.pushed).toBe(false)
    expect(result.message).toBeUndefined()
  })

  it('recent_pushes injected into prompt context', async () => {
    async function* gen() {
      yield { type: 'result', session_id: 's', num_turns: 0, total_cost_usd: 0, duration_ms: 0 }
    }
    fakeQuery.mockImplementation(() => gen())

    const evalTrigger = makeEvalTrigger({ sdkOptionsBase: () => ({}), log: () => {} })
    await evalTrigger(TRIGGER, {
      recent_pushes: [
        { ts: '2026-04-22T09:00:00Z', trigger_id: 'ci', persona: 'assistant', message: 'CI broke', chat_id: 'c', delivery_status: 'ok' },
        { ts: '2026-04-22T09:30:00Z', trigger_id: 'pr', persona: 'assistant', message: 'PR review', chat_id: 'c', delivery_status: 'ok' },
      ],
      recent_runs: [],
      profile: 'p',
      persona: PERSONA,
      chat_id: 'c1',
    })

    const params = fakeQuery.mock.calls[0]![0] as any
    expect(params.prompt).toContain('CI broke')
    expect(params.prompt).toContain('PR review')
  })

  it('on query error, returns pushed=false with error_message', async () => {
    fakeQuery.mockImplementation(() => {
      throw new Error('sdk exploded')
    })

    const evalTrigger = makeEvalTrigger({ sdkOptionsBase: () => ({}), log: () => {} })
    const result = await evalTrigger(TRIGGER, {
      recent_pushes: [], recent_runs: [], profile: 'p', persona: PERSONA, chat_id: 'c1',
    })
    expect(result.pushed).toBe(false)
    expect(result.error_message).toContain('sdk exploded')
  })

  it('counts multiple tool uses, including non-reply tools', async () => {
    async function* gen() {
      yield {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'Bash', input: { cmd: 'gh run list' } },
          ],
        },
      }
      yield {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'reply', input: { chat_id: 'c1', text: 'final' } },
          ],
        },
      }
      yield { type: 'result', session_id: 's', num_turns: 2, total_cost_usd: 0.02, duration_ms: 2000 }
    }
    fakeQuery.mockImplementation(() => gen())

    const evalTrigger = makeEvalTrigger({ sdkOptionsBase: () => ({}), log: () => {} })
    const result = await evalTrigger(TRIGGER, {
      recent_pushes: [], recent_runs: [], profile: 'p', persona: PERSONA, chat_id: 'c1',
    })
    expect(result.pushed).toBe(true)
    expect(result.message).toBe('final')
    expect(result.tool_uses_count).toBe(2)
  })
})
