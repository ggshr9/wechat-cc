import { describe, it, expect } from 'vitest'
import { chunk } from './send-reply'

describe('chunk', () => {
  it('returns original text if under limit', () => {
    expect(chunk('hello', 100)).toEqual(['hello'])
    expect(chunk('', 100)).toEqual([''])
  })

  it('splits on paragraph boundary when possible', () => {
    const text = 'first paragraph line\n\nsecond paragraph line'
    const parts = chunk(text, 25)
    expect(parts.length).toBeGreaterThanOrEqual(2)
    expect(parts[0]).toBe('first paragraph line')
  })

  it('splits on line boundary when no paragraph in window', () => {
    const text = 'line one here\nline two here\nline three here'
    const parts = chunk(text, 15)
    // 'line one here' is 13 chars, next newline pushes us over — cut at first newline
    expect(parts[0]).toBe('line one here')
  })

  it('falls back to space boundary', () => {
    const text = 'one two three four five six seven'
    const parts = chunk(text, 10)
    // Cut at space before limit
    expect(parts[0].length).toBeLessThanOrEqual(10)
    expect(parts.every(p => p.length > 0)).toBe(true)
  })

  it('hard-cuts when no good boundary', () => {
    const text = 'aaaaaaaaaaaaaaaaaaaa' // 20 'a's, no whitespace
    const parts = chunk(text, 5)
    expect(parts.length).toBe(4)
    expect(parts.every(p => p.length === 5)).toBe(true)
  })

  it('strips leading newlines from next chunk', () => {
    const text = 'paragraph one\n\nparagraph two'
    const parts = chunk(text, 15)
    // After the split, 'paragraph two' should not start with \n
    expect(parts[1].startsWith('\n')).toBe(false)
  })

  it('preserves non-ASCII (Chinese) text intact', () => {
    const text = '你好世界这是一个测试的消息内容'
    const parts = chunk(text, 6)
    expect(parts.join('')).toBe(text.replace(/\n/g, ''))
  })
})
