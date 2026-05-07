import { describe, it, expect, vi } from 'vitest'
import { evaluateRound, type ChatroomEntry } from './chatroom-moderator'

const PARTICIPANTS: ['claude', 'codex'] = ['claude', 'codex']

// Helper: build a history with the latest user msg + optional speaker turns.
function hist(userMsg: string, ...turns: Array<{ speaker: 'claude' | 'codex'; text: string }>): ChatroomEntry[] {
  return [
    { role: 'user' as const, text: userMsg },
    ...turns.map(t => ({ role: 'speaker' as const, speaker: t.speaker, text: t.text })),
  ]
}

describe('evaluateRound', () => {
  it('round 1: parses valid continue decision and returns it as-is', async () => {
    const haikuEval = vi.fn().mockResolvedValue(JSON.stringify({
      action: 'continue', speaker: 'claude', prompt: '先给初步看法', reasoning: '开场',
    }))
    const r = await evaluateRound(
      { history: hist('9-1 等于多少'), round: 1, maxRounds: 4, participants: PARTICIPANTS },
      { haikuEval },
    )
    expect(r).toEqual({ action: 'continue', speaker: 'claude', prompt: '先给初步看法', reasoning: '开场' })
  })

  it('forces alternation when moderator picks repeated speaker', async () => {
    const haikuEval = vi.fn().mockResolvedValue(JSON.stringify({
      action: 'continue', speaker: 'claude', prompt: '继续说', reasoning: '同意',
    }))
    const r = await evaluateRound(
      {
        round: 2, maxRounds: 4, participants: PARTICIPANTS,
        history: hist('q', { speaker: 'claude', text: 'first take' }),
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
        round: 3, maxRounds: 4, participants: PARTICIPANTS,
        history: hist('q', { speaker: 'claude', text: 'a' }, { speaker: 'codex', text: 'b' }),
      },
      { haikuEval },
    )
    expect(r).toEqual({ action: 'end', reasoning: '已收敛' })
  })

  it('forces end (defensive) when round > maxRounds', async () => {
    const haikuEval = vi.fn() // should not be called
    const r = await evaluateRound(
      {
        round: 5, maxRounds: 4, participants: PARTICIPANTS,
        history: hist('q',
          { speaker: 'claude', text: 'a' },
          { speaker: 'codex', text: 'b' },
          { speaker: 'claude', text: 'c' },
          { speaker: 'codex', text: 'd' },
        ),
      },
      { haikuEval },
    )
    expect(r.action).toBe('end')
    expect(haikuEval).not.toHaveBeenCalled()
  })

  it('tolerates JSON wrapped in ```json fences', async () => {
    const haikuEval = vi.fn().mockResolvedValue('```json\n{"action":"continue","speaker":"codex","prompt":"x","reasoning":"y"}\n```')
    const r = await evaluateRound(
      { history: hist('q'), round: 1, maxRounds: 4, participants: PARTICIPANTS },
      { haikuEval },
    )
    expect(r.action).toBe('continue')
    if (r.action === 'continue') expect(r.speaker).toBe('codex')
  })

  it('falls back to alternation when JSON is malformed', async () => {
    const haikuEval = vi.fn().mockResolvedValue('this is not JSON at all')
    const r = await evaluateRound(
      {
        round: 2, maxRounds: 4, participants: PARTICIPANTS,
        history: hist('q', { speaker: 'claude', text: 'a' }),
      },
      { haikuEval },
    )
    expect(r.action).toBe('continue')
    if (r.action === 'continue') {
      expect(r.speaker).toBe('codex')
      expect(r.prompt.length).toBeGreaterThan(0)
      expect(r.reasoning).toMatch(/fallback/)
    }
  })

  it('falls back when haikuEval throws', async () => {
    const haikuEval = vi.fn().mockRejectedValue(new Error('network down'))
    const r = await evaluateRound(
      {
        round: 2, maxRounds: 4, participants: PARTICIPANTS,
        history: hist('q', { speaker: 'claude', text: 'a' }),
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
        round: 2, maxRounds: 4, participants: PARTICIPANTS,
        history: hist('q', { speaker: 'claude', text: 'a' }),
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
        round: 2, maxRounds: 4, participants: PARTICIPANTS,
        history: hist('q', { speaker: 'claude', text: 'a' }),
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
        round: 2, maxRounds: 4, participants: PARTICIPANTS,
        history: hist('q', { speaker: 'claude', text: 'a' }),
      },
      { haikuEval },
    )
    expect(r.action).toBe('continue')
    if (r.action === 'continue') {
      expect(r.prompt.length).toBeGreaterThan(20)
      // Fallback prompt is neutral — does NOT command "must rebut".
      expect(r.prompt).not.toMatch(/必须找弱点|强制反驳|不许.*基本同意/)
    }
  })

  it('history with multiple user msgs: last user msg is the trigger context', async () => {
    const haikuEval = vi.fn().mockResolvedValue(JSON.stringify({
      action: 'continue', speaker: 'codex', reasoning: '继续',
    }))
    await evaluateRound(
      {
        round: 1, maxRounds: 4, participants: PARTICIPANTS,
        history: [
          { role: 'user', text: '第一个问题' },
          { role: 'speaker', speaker: 'claude', text: 'A1' },
          { role: 'speaker', speaker: 'codex', text: 'B1' },
          { role: 'user', text: '追问：然后呢？' },  // ← latest user msg
        ],
      },
      { haikuEval },
    )
    const promptArg = haikuEval.mock.calls[0]?.[0] as string
    expect(promptArg).toContain('追问：然后呢？')
    expect(promptArg).toContain('第一个问题')  // older context still visible
  })

  it('round 1 + moderator returns end → coerced to continue (user must hear from at least one AI)', async () => {
    const haikuEval = vi.fn().mockResolvedValue(JSON.stringify({
      action: 'end', reasoning: '消息太轻飘了不需要回',
    }))
    const r = await evaluateRound(
      {
        round: 1, maxRounds: 4, participants: PARTICIPANTS,
        history: [
          { role: 'user', text: '第一个 Q' },
          { role: 'speaker', speaker: 'claude', text: 'A1' },
          { role: 'speaker', speaker: 'codex', text: 'B1' },
          { role: 'user', text: '哦哦' },  // casual follow-up; moderator might want to skip
        ],
      },
      { haikuEval },
    )
    // Despite moderator saying 'end', the new rule forces continue on round 1.
    expect(r.action).toBe('continue')
    if (r.action === 'continue') {
      expect(r.speaker).toBe('claude')  // alternates from last speaker (codex)
      expect(r.reasoning).toBe('round1_must_continue')
    }
  })

  it('round = maxRounds: moderator decides normally (no auto-end), expected to pick synthesis speaker', async () => {
    const haikuEval = vi.fn().mockResolvedValue(JSON.stringify({
      action: 'continue', speaker: 'codex', prompt: '🎯 综合', reasoning: '终轮综合',
    }))
    const r = await evaluateRound(
      {
        round: 4, maxRounds: 4, participants: PARTICIPANTS,
        history: hist('q',
          { speaker: 'claude', text: 'a' }, { speaker: 'codex', text: 'b' }, { speaker: 'claude', text: 'c' },
        ),
      },
      { haikuEval },
    )
    expect(r.action).toBe('continue')
    if (r.action === 'continue') expect(r.speaker).toBe('codex')
    expect(haikuEval).toHaveBeenCalledTimes(1)
  })
})
