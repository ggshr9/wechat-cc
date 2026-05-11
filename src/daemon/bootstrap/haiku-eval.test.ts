import { describe, expect, it, vi } from 'vitest'
import { makeHaikuEval } from './haiku-eval'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'

function fakeAssistantStream(chunks: string[]) {
  return () => {
    async function* gen(): AsyncGenerator<SDKMessage, void> {
      for (const text of chunks) {
        yield { type: 'assistant', message: { content: [{ type: 'text', text }] } } as unknown as SDKMessage
      }
    }
    return gen() as never
  }
}

describe('makeHaikuEval', () => {
  it('concatenates assistant text chunks into a single string', async () => {
    const haiku = makeHaikuEval({
      log: () => {},
      queryImpl: fakeAssistantStream(['{"action":', '"end"}']) as never,
    })
    await expect(haiku('any prompt')).resolves.toBe('{"action":"end"}')
  })

  it('throws auth_failed and logs [AUTH_FAILED] when the model surfaces the "Please run /login" sentinel', async () => {
    // Without this, a stale-credential moderator silently degrades to
    // alternation fallback (evaluateRound's parse_failed branch) and
    // operators get no signal that the moderator went dumb.
    const log = vi.fn()
    const haiku = makeHaikuEval({
      log,
      queryImpl: fakeAssistantStream(['Not logged in · Please run /login']) as never,
    })
    await expect(haiku('any prompt')).rejects.toThrow(/auth_failed/)
    expect(log).toHaveBeenCalledWith('AUTH_FAILED', expect.stringContaining('haiku moderator'))
  })

  it('also catches the partial "Not logged in" chunk on its own (split delivery)', async () => {
    const log = vi.fn()
    const haiku = makeHaikuEval({
      log,
      queryImpl: fakeAssistantStream(['Not logged in']) as never,
    })
    await expect(haiku('any prompt')).rejects.toThrow(/auth_failed/)
  })

  it('passes the claudeBin override into the SDK options when present', async () => {
    const calls: Array<unknown> = []
    const queryImpl = ((args: unknown) => {
      calls.push(args)
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        yield { type: 'assistant', message: { content: [{ type: 'text', text: '{}' }] } } as unknown as SDKMessage
      }
      return gen() as never
    }) as never
    const haiku = makeHaikuEval({ log: () => {}, queryImpl, claudeBin: '/custom/path/claude' })
    await haiku('p')
    const arg = calls[0] as { options?: { pathToClaudeCodeExecutable?: string; model?: string; maxTurns?: number } }
    expect(arg.options?.pathToClaudeCodeExecutable).toBe('/custom/path/claude')
    expect(arg.options?.model).toBe('claude-haiku-4-5')
    expect(arg.options?.maxTurns).toBe(1)
  })
})
