import { describe, it, expect } from 'vitest'
import { codexLineToClaudeTurn } from './codex-jsonl'

describe('codexLineToClaudeTurn', () => {
  it('skips session_meta', () => {
    expect(codexLineToClaudeTurn({ type: 'session_meta', payload: { id: 'x' } })).toBeNull()
  })

  it('skips reasoning items (encrypted summary)', () => {
    expect(codexLineToClaudeTurn({
      type: 'response_item',
      payload: { type: 'reasoning', encrypted_content: 'gAAAA...', summary: [] },
    })).toBeNull()
  })

  it('skips event_msg (duplicates the response_item we already converted)', () => {
    expect(codexLineToClaudeTurn({
      type: 'event_msg',
      payload: { type: 'agent_message', message: 'hi', phase: 'final_answer' },
    })).toBeNull()
  })

  it('user message with input_text → claude-shape user turn', () => {
    const r = codexLineToClaudeTurn({
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
    })
    expect(r).toEqual({
      type: 'user',
      message: { content: [{ type: 'text', text: 'hello' }] },
    })
  })

  it('assistant message with output_text → claude-shape assistant turn', () => {
    const r = codexLineToClaudeTurn({
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '我会选墨绿' }] },
    })
    expect(r).toEqual({
      type: 'assistant',
      message: { content: [{ type: 'text', text: '我会选墨绿' }] },
    })
  })

  it('multiple text blocks coalesce into one turn with N content entries', () => {
    const r = codexLineToClaudeTurn({
      type: 'response_item',
      payload: {
        type: 'message', role: 'assistant',
        content: [
          { type: 'output_text', text: 'first' },
          { type: 'output_text', text: 'second' },
        ],
      },
    })
    expect(r?.message.content).toEqual([
      { type: 'text', text: 'first' },
      { type: 'text', text: 'second' },
    ])
  })

  it('skips when role is neither user nor assistant (e.g., developer)', () => {
    expect(codexLineToClaudeTurn({
      type: 'response_item',
      payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'sys' }] },
    })).toBeNull()
  })

  it('skips when content has no text-bearing blocks', () => {
    expect(codexLineToClaudeTurn({
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'image', url: 'x' }] },
    })).toBeNull()
  })

  it('skips malformed JSON shapes gracefully', () => {
    expect(codexLineToClaudeTurn(null)).toBeNull()
    expect(codexLineToClaudeTurn('a string')).toBeNull()
    expect(codexLineToClaudeTurn({ type: 'response_item' })).toBeNull()  // no payload
    expect(codexLineToClaudeTurn({ type: 'response_item', payload: { type: 'message' } })).toBeNull()  // no role
  })

  it('threads envelope timestamp into turn.ts when present', () => {
    const r = codexLineToClaudeTurn({
      timestamp: '2025-11-25T02:41:55.984Z',
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
    })
    expect(r?.ts).toBe('2025-11-25T02:41:55.984Z')
  })

  it('does not set turn.ts when envelope has no timestamp', () => {
    const r = codexLineToClaudeTurn({
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] },
    })
    expect(r).not.toBeNull()
    expect(r?.ts).toBeUndefined()
  })

  it('ignores a garbage (non-date) envelope timestamp — keeps the turn, ts undefined', () => {
    // A garbage ts stored verbatim would corrupt the messages-store ordering;
    // invalid → undefined so the backfill falls back to the filename anchor.
    const r = codexLineToClaudeTurn({
      timestamp: 'not-a-date',
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
    })
    expect(r).not.toBeNull()
    expect(r?.ts).toBeUndefined()
  })
})
