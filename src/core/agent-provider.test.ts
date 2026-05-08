import { describe, it, expect } from 'vitest'
import {
  collectTurn,
  isReplyToolCall,
  type AgentEvent,
} from './agent-provider'

async function* events(...e: AgentEvent[]): AsyncIterable<AgentEvent> {
  for (const ev of e) yield ev
}

describe('isReplyToolCall', () => {
  it('matches wechat reply tools', () => {
    expect(isReplyToolCall({ kind: 'tool_call', server: 'wechat', tool: 'reply' })).toBe(true)
    expect(isReplyToolCall({ kind: 'tool_call', server: 'wechat', tool: 'reply_voice' })).toBe(true)
    expect(isReplyToolCall({ kind: 'tool_call', server: 'wechat', tool: 'send_file' })).toBe(true)
    expect(isReplyToolCall({ kind: 'tool_call', server: 'wechat', tool: 'edit_message' })).toBe(true)
    expect(isReplyToolCall({ kind: 'tool_call', server: 'wechat', tool: 'broadcast' })).toBe(true)
  })
  it('rejects non-wechat servers', () => {
    expect(isReplyToolCall({ kind: 'tool_call', server: 'other', tool: 'reply' })).toBe(false)
  })
  it('rejects non-reply tools on wechat server', () => {
    expect(isReplyToolCall({ kind: 'tool_call', server: 'wechat', tool: 'memory_read' })).toBe(false)
  })
  it('rejects events with no server field (built-in tools)', () => {
    expect(isReplyToolCall({ kind: 'tool_call', tool: 'Read' })).toBe(false)
  })
  it('returns false for non-tool-call events', () => {
    expect(isReplyToolCall({ kind: 'text', text: 'hi' })).toBe(false)
    expect(isReplyToolCall({ kind: 'init', sessionId: 's1' })).toBe(false)
    expect(isReplyToolCall({ kind: 'result', sessionId: 's1', numTurns: 1, durationMs: 100 })).toBe(false)
    expect(isReplyToolCall({ kind: 'error', message: 'boom' })).toBe(false)
  })
})

describe('collectTurn', () => {
  it('accumulates text events', async () => {
    const summary = await collectTurn(events(
      { kind: 'text', text: 'hello' },
      { kind: 'text', text: 'world' },
    ))
    expect(summary.assistantText).toEqual(['hello', 'world'])
    expect(summary.replyToolCalled).toBe(false)
    expect(summary.result).toBeUndefined()
    expect(summary.error).toBeUndefined()
  })

  it('flags reply tool calls', async () => {
    const summary = await collectTurn(events(
      { kind: 'tool_call', server: 'wechat', tool: 'reply' },
    ))
    expect(summary.replyToolCalled).toBe(true)
  })

  it('does not flag non-reply tool calls', async () => {
    const summary = await collectTurn(events(
      { kind: 'tool_call', server: 'wechat', tool: 'memory_read' },
      { kind: 'tool_call', tool: 'Read' },
    ))
    expect(summary.replyToolCalled).toBe(false)
  })

  it('captures result event', async () => {
    const summary = await collectTurn(events(
      { kind: 'init', sessionId: 's1' },
      { kind: 'text', text: 'hi' },
      { kind: 'result', sessionId: 's1', numTurns: 1, durationMs: 250 },
    ))
    expect(summary.result).toEqual({ sessionId: 's1', numTurns: 1, durationMs: 250 })
    expect(summary.assistantText).toEqual(['hi'])
  })

  it('captures error events', async () => {
    const summary = await collectTurn(events(
      { kind: 'text', text: 'partial' },
      { kind: 'error', message: 'turn failed' },
    ))
    expect(summary.error).toBe('turn failed')
    expect(summary.assistantText).toEqual(['partial'])
  })

  it('handles empty iterable', async () => {
    const summary = await collectTurn(events())
    expect(summary).toEqual({ assistantText: [], replyToolCalled: false, result: undefined, error: undefined })
  })
})
