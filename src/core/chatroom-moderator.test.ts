import { describe, it, expect, vi } from 'vitest'
import { evaluateRound } from './chatroom-moderator'

const PARTICIPANTS: ['claude', 'codex'] = ['claude', 'codex']

describe('evaluateRound', () => {
  it('round 1: parses valid continue decision and returns it as-is', async () => {
    const haikuEval = vi.fn().mockResolvedValue(JSON.stringify({
      action: 'continue', speaker: 'claude', prompt: '先给初步看法', reasoning: '开场',
    }))
    const r = await evaluateRound(
      { userMessage: '9-1 等于多少', history: [], round: 1, maxRounds: 4, participants: PARTICIPANTS },
      { haikuEval },
    )
    expect(r).toEqual({ action: 'continue', speaker: 'claude', prompt: '先给初步看法', reasoning: '开场' })
  })

  it('round 2: forces alternation when moderator picks repeated speaker', async () => {
    const haikuEval = vi.fn().mockResolvedValue(JSON.stringify({
      action: 'continue', speaker: 'claude', prompt: '继续说', reasoning: '同意',
    }))
    const r = await evaluateRound(
      {
        userMessage: 'q', round: 2, maxRounds: 4, participants: PARTICIPANTS,
        history: [{ speaker: 'claude', text: 'first take' }],
      },
      { haikuEval },
    )
    expect(r.action).toBe('continue')
    if (r.action === 'continue') expect(r.speaker).toBe('codex') // coerced
  })

  it('parses end decision', async () => {
    const haikuEval = vi.fn().mockResolvedValue(JSON.stringify({
      action: 'end', reasoning: '已收敛',
    }))
    const r = await evaluateRound(
      {
        userMessage: 'q', round: 3, maxRounds: 4, participants: PARTICIPANTS,
        history: [{ speaker: 'claude', text: 'a' }, { speaker: 'codex', text: 'b' }],
      },
      { haikuEval },
    )
    expect(r).toEqual({ action: 'end', reasoning: '已收敛' })
  })

  it('forces end (defensive) when round > maxRounds', async () => {
    // Normal loop bounds round to <= maxRounds, so this is defense-in-depth
    // for callers that miscount. round = maxRounds itself goes through
    // haiku normally (last allowed turn = synthesis turn).
    const haikuEval = vi.fn() // should not be called
    const r = await evaluateRound(
      {
        userMessage: 'q', round: 5, maxRounds: 4, participants: PARTICIPANTS,
        history: [{ speaker: 'claude', text: 'a' }, { speaker: 'codex', text: 'b' }, { speaker: 'claude', text: 'c' }, { speaker: 'codex', text: 'd' }],
      },
      { haikuEval },
    )
    expect(r.action).toBe('end')
    expect(haikuEval).not.toHaveBeenCalled()
  })

  it('tolerates JSON wrapped in ```json fences', async () => {
    const haikuEval = vi.fn().mockResolvedValue('```json\n{"action":"continue","speaker":"codex","prompt":"x","reasoning":"y"}\n```')
    const r = await evaluateRound(
      { userMessage: 'q', round: 1, maxRounds: 4, participants: PARTICIPANTS, history: [] },
      { haikuEval },
    )
    expect(r.action).toBe('continue')
    if (r.action === 'continue') expect(r.speaker).toBe('codex')
  })

  it('falls back to alternation when JSON is malformed', async () => {
    const haikuEval = vi.fn().mockResolvedValue('this is not JSON at all')
    const r = await evaluateRound(
      {
        userMessage: 'q', round: 2, maxRounds: 4, participants: PARTICIPANTS,
        history: [{ speaker: 'claude', text: 'a' }],
      },
      { haikuEval },
    )
    expect(r.action).toBe('continue')
    if (r.action === 'continue') {
      expect(r.speaker).toBe('codex') // forced alternation
      expect(r.prompt.length).toBeGreaterThan(0) // generic prompt
      expect(r.reasoning).toMatch(/fallback/)
    }
  })

  it('falls back when haikuEval throws', async () => {
    const haikuEval = vi.fn().mockRejectedValue(new Error('network down'))
    const r = await evaluateRound(
      {
        userMessage: 'q', round: 2, maxRounds: 4, participants: PARTICIPANTS,
        history: [{ speaker: 'claude', text: 'a' }],
      },
      { haikuEval },
    )
    expect(r.action).toBe('continue')
    if (r.action === 'continue') {
      expect(r.speaker).toBe('codex')
      expect(r.reasoning).toMatch(/fallback:haiku_threw/)
    }
  })

  it('coerces unknown speaker to peer', async () => {
    const haikuEval = vi.fn().mockResolvedValue(JSON.stringify({
      action: 'continue', speaker: 'cursor', prompt: 'x', reasoning: 'y',
    }))
    const r = await evaluateRound(
      {
        userMessage: 'q', round: 2, maxRounds: 4, participants: PARTICIPANTS,
        history: [{ speaker: 'claude', text: 'a' }],
      },
      { haikuEval },
    )
    expect(r.action).toBe('continue')
    if (r.action === 'continue') expect(r.speaker).toBe('codex')
  })

  it('falls back when action is unknown', async () => {
    const haikuEval = vi.fn().mockResolvedValue(JSON.stringify({
      action: 'meditate', speaker: 'codex',
    }))
    const r = await evaluateRound(
      {
        userMessage: 'q', round: 2, maxRounds: 4, participants: PARTICIPANTS,
        history: [{ speaker: 'claude', text: 'a' }],
      },
      { haikuEval },
    )
    expect(r.action).toBe('continue')
    if (r.action === 'continue') expect(r.reasoning).toMatch(/fallback:bad_action/)
  })

  it('uses generic prompt when moderator omits prompt field', async () => {
    const haikuEval = vi.fn().mockResolvedValue(JSON.stringify({
      action: 'continue', speaker: 'codex', reasoning: 'y',
    }))
    const r = await evaluateRound(
      {
        userMessage: 'q', round: 2, maxRounds: 4, participants: PARTICIPANTS,
        history: [{ speaker: 'claude', text: 'a' }],
      },
      { haikuEval },
    )
    expect(r.action).toBe('continue')
    if (r.action === 'continue') expect(r.prompt.length).toBeGreaterThan(20)
  })
})
