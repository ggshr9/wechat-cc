import { describe, expect, it } from 'vitest'
import { parseAddressing, wrapChatroomTurn, maxRoundsSuffix } from './chatroom-protocol'

describe('parseAddressing', () => {
  it('treats plain text (no @ prefix) as a single null-addressee segment', () => {
    expect(parseAddressing('hi user')).toEqual([
      { addressee: null, body: 'hi user' },
    ])
  })

  it('extracts a single @user segment', () => {
    expect(parseAddressing('@user the answer is 42')).toEqual([
      { addressee: 'user', body: 'the answer is 42' },
    ])
  })

  it('extracts a single @claude segment (peer addressing)', () => {
    expect(parseAddressing('@claude what do you think about line 42?')).toEqual([
      { addressee: 'claude', body: 'what do you think about line 42?' },
    ])
  })

  it('splits multiple consecutive @-tagged segments', () => {
    const text = '@codex check src/foo.ts:42\n@user 我把任务交给 codex 了'
    expect(parseAddressing(text)).toEqual([
      { addressee: 'codex', body: 'check src/foo.ts:42' },
      { addressee: 'user', body: '我把任务交给 codex 了' },
    ])
  })

  it('folds continuation lines into the current segment', () => {
    const text = '@codex you should\ncheck this code\nfor an off-by-one'
    expect(parseAddressing(text)).toEqual([
      { addressee: 'codex', body: 'you should\ncheck this code\nfor an off-by-one' },
    ])
  })

  it('handles a preamble before the first @-tag (becomes null-addressee segment)', () => {
    const text = 'looking at this...\n@codex what do you see?'
    expect(parseAddressing(text)).toEqual([
      { addressee: null, body: 'looking at this...' },
      { addressee: 'codex', body: 'what do you see?' },
    ])
  })

  it('skips empty bodies', () => {
    expect(parseAddressing('')).toEqual([])
    expect(parseAddressing('\n\n')).toEqual([])
    expect(parseAddressing('@codex\n')).toEqual([])  // tag with empty body → skipped
  })

  it('strips a single space after @-tag if present', () => {
    expect(parseAddressing('@user hello').at(0)?.body).toBe('hello')
    expect(parseAddressing('@user  hello').at(0)?.body).toBe(' hello')   // 2 spaces → 1 stripped, 1 kept
  })

  it('preserves @-tag case for downstream lookup', () => {
    // Tag tokens are case-sensitive ProviderIds — preserve as-is.
    expect(parseAddressing('@CODEX hi').at(0)?.addressee).toBe('CODEX')
  })

  it('handles tags with hyphens / underscores / digits in providerId', () => {
    expect(parseAddressing('@gemini-experimental hi').at(0)?.addressee).toBe('gemini-experimental')
    expect(parseAddressing('@gpt_4 hi').at(0)?.addressee).toBe('gpt_4')
    expect(parseAddressing('@v2 hi').at(0)?.addressee).toBe('v2')
  })

  it('only counts @ at line start (mid-line @ is part of body)', () => {
    expect(parseAddressing('I will ask @codex about it')).toEqual([
      { addressee: null, body: 'I will ask @codex about it' },
    ])
  })

  it('tolerates leading whitespace before @-tag', () => {
    expect(parseAddressing('  @user hi')).toEqual([
      { addressee: 'user', body: 'hi' },
    ])
  })

  it('flushes a non-empty preamble even without a final @-tag', () => {
    const text = 'analysis paragraph 1\nanalysis paragraph 2'
    expect(parseAddressing(text)).toEqual([
      { addressee: null, body: 'analysis paragraph 1\nanalysis paragraph 2' },
    ])
  })

  it('multi-segment with mixed continuation and re-tag', () => {
    const text = `looking at this
@codex check line 42
specifically the boundary
@user (paused; waiting on codex)`
    expect(parseAddressing(text)).toEqual([
      { addressee: null, body: 'looking at this' },
      { addressee: 'codex', body: 'check line 42\nspecifically the boundary' },
      { addressee: 'user', body: '(paused; waiting on codex)' },
    ])
  })
})

describe('wrapChatroomTurn', () => {
  it('produces an envelope with speaker/peer/round/sender attributes + protocol body', () => {
    const env = wrapChatroomTurn({
      speaker: 'claude', peer: 'codex', round: 1, maxRounds: 4,
      sender: 'user',
      inner: '<wechat chat_id="c1">hi both</wechat>',
    })
    expect(env).toContain('<chatroom_round speaker="claude" peer="codex" round="1" max_rounds="4" sender="user">')
    expect(env).toContain('chatroom 模式')
    expect(env).toContain('@codex')   // hint about peer addressing
    expect(env).toContain('1/4')      // round counter
    expect(env).toContain('[user originated]')
    expect(env).toContain('<wechat chat_id="c1">hi both</wechat>')
    expect(env).toContain('</chatroom_round>')
  })

  it('marks the sender for peer relays', () => {
    const env = wrapChatroomTurn({
      speaker: 'codex', peer: 'claude', round: 2, maxRounds: 4,
      sender: 'claude',
      inner: '@codex you should check line 42',
    })
    expect(env).toContain('sender="claude"')
    expect(env).toContain('[from claude]')
    expect(env).toContain('@codex you should check line 42')
  })

  it('discourages reply tool calls in the inline protocol', () => {
    const env = wrapChatroomTurn({
      speaker: 'claude', peer: 'codex', round: 1, maxRounds: 4,
      sender: 'user', inner: 'x',
    })
    expect(env).toContain('不要调 reply')
  })
})

describe('maxRoundsSuffix', () => {
  it('returns a non-empty string mentioning max_rounds', () => {
    const s = maxRoundsSuffix()
    expect(s.length).toBeGreaterThan(0)
    expect(s).toContain('max_rounds')
  })
})
