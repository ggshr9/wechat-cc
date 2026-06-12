import { describe, it, expect } from 'vitest'
import { buildExtractPrompt, parseExtractResponse } from './extract-prompt'

describe('extract prompt', () => {
  it('prompt embeds new messages, existing threads and tag vocabulary', () => {
    const p = buildExtractPrompt({
      newMessages: [{ ts: '2026-06-11T00:00:00Z', direction: 'in', text: '排产又要改' }],
      existingThreads: [{ id: 'thr_1', title: 'compass 排产', facets: ['task'], tags: ['compass'], summary: '' }],
      tagVocabulary: ['compass', '股票'],
    })
    expect(p).toContain('排产又要改')
    expect(p).toContain('thr_1')
    expect(p).toContain('compass')
    expect(p).toMatch(/反复出现|第二次/)
    expect(p).toMatch(/复用|已有 tag/)
  })

  it('parses ops from a fenced json response', () => {
    const ops = parseExtractResponse('```json\n{"ops":[{"op":"create","title":"股票观察","facets":["life"],"tags":["股票"],"private":false,"summary":"s","episode":{"from_ts":"2026-06-11T01:00:00Z","to_ts":"2026-06-11T01:01:00Z"}}]}\n```')
    expect(ops).toEqual([expect.objectContaining({ op: 'create', title: '股票观察' })])
  })

  it('rejects malformed responses with null (never throws)', () => {
    expect(parseExtractResponse('not json at all')).toBeNull()
    expect(parseExtractResponse('{"ops": "nope"}')).toBeNull()
    expect(parseExtractResponse('{"ops":[{"op":"create","title":"x","facets":["mood"]}]}')).toBeNull()
  })

  it('accepts update/touch ops referencing existing ids', () => {
    const ops = parseExtractResponse('{"ops":[{"op":"touch","id":"thr_1","episode":{"from_ts":"2026-06-11T01:00:00Z","to_ts":"2026-06-11T01:01:00Z"}},{"op":"update","id":"thr_1","status":"done"}]}')
    expect(ops?.length).toBe(2)
  })

  // ── Edge-case tests (Part A follow-ups) ───────────────────────────────────

  it('brace fallback: parses valid JSON object with prose before and after', () => {
    const raw = 'Sure, here you go: {"ops":[{"op":"create","title":"测试","summary":"s","facets":["task"],"tags":[],"private":false,"episode":{"from_ts":"2026-06-11T00:00:00Z","to_ts":"2026-06-11T00:01:00Z"}}]} Hope that helps!'
    const ops = parseExtractResponse(raw)
    expect(ops).not.toBeNull()
    expect(ops?.length).toBe(1)
    expect(ops?.[0]).toMatchObject({ op: 'create', title: '测试' })
  })

  it('create with empty facets array → null (schema enforces min(1))', () => {
    const raw = '{"ops":[{"op":"create","title":"无 facet","summary":"s","facets":[],"tags":[],"private":false,"episode":{"from_ts":"2026-06-11T00:00:00Z","to_ts":"2026-06-11T00:01:00Z"}}]}'
    expect(parseExtractResponse(raw)).toBeNull()
  })

  it('extra unknown keys are stripped from the parsed op (not present in result)', () => {
    const raw = '{"ops":[{"op":"touch","id":"thr_1","episode":{"from_ts":"2026-06-11T00:00:00Z","to_ts":"2026-06-11T00:01:00Z"},"unknownField":"should-be-gone"}]}'
    const ops = parseExtractResponse(raw)
    expect(ops).not.toBeNull()
    expect(ops?.[0]).not.toHaveProperty('unknownField')
  })

  it('update with only id is parsed (documents the no-op contract)', () => {
    const raw = '{"ops":[{"op":"update","id":"thr_abc"}]}'
    const ops = parseExtractResponse(raw)
    expect(ops).not.toBeNull()
    expect(ops?.length).toBe(1)
    expect(ops?.[0]).toMatchObject({ op: 'update', id: 'thr_abc' })
  })

  // A4 — episode ts must be UTC Z-suffix ISO
  it('A4: episode with +08:00 offset ts → entire batch rejected (returns null)', () => {
    const raw = '{"ops":[{"op":"create","title":"t","summary":"s","facets":["task"],"tags":[],"private":false,"episode":{"from_ts":"2026-06-11T09:00:00+08:00","to_ts":"2026-06-11T09:01:00+08:00"}}]}'
    expect(parseExtractResponse(raw)).toBeNull()
  })

  it('A4: valid Z-suffix ts passes schema', () => {
    const raw = '{"ops":[{"op":"create","title":"t","summary":"s","facets":["task"],"tags":[],"private":false,"episode":{"from_ts":"2026-06-11T01:00:00Z","to_ts":"2026-06-11T01:01:00Z"}}]}'
    const ops = parseExtractResponse(raw)
    expect(ops).not.toBeNull()
    expect(ops?.length).toBe(1)
  })

  it('A4: ts with milliseconds and Z suffix passes schema', () => {
    const raw = '{"ops":[{"op":"touch","id":"thr_1","episode":{"from_ts":"2026-06-11T01:00:00.123Z","to_ts":"2026-06-11T01:01:00.456Z"}}]}'
    const ops = parseExtractResponse(raw)
    expect(ops).not.toBeNull()
  })

  it('A4: prompt contains the UTC timestamp rule', () => {
    const p = buildExtractPrompt({ newMessages: [], existingThreads: [], tagVocabulary: [] })
    expect(p).toContain('时间戳必须原样复制')
    expect(p).toContain('UTC')
    expect(p).toContain('Z 结尾')
  })

  it('contextTail appears in prompt under the reappearance header', () => {
    const p = buildExtractPrompt({
      newMessages: [{ ts: '2026-06-11T02:00:00Z', direction: 'in', text: '排产又提了一次' }],
      existingThreads: [],
      tagVocabulary: [],
      contextTail: [
        { ts: '2026-06-10T20:00:00Z', direction: 'in', text: '上次说的排产问题' },
        { ts: '2026-06-10T20:01:00Z', direction: 'out', text: '好的我记下了' },
      ],
    })
    expect(p).toContain('近期历史(仅供判断话题是否"再次出现"')
    expect(p).toContain('上次说的排产问题')
    expect(p).toContain('好的我记下了')
    // contextTail section must appear BEFORE 新增对话片段 section header
    const tailPos = p.indexOf('近期历史')
    const newMsgPos = p.indexOf('=== 新增对话片段 ===')
    expect(tailPos).toBeGreaterThan(-1)
    expect(tailPos).toBeLessThan(newMsgPos)
  })
})
