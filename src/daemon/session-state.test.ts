import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { makeSessionStateStore } from './session-state'

describe('SessionStateStore', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'session-state-'))
    file = join(dir, 'session-state.json')
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('starts empty', () => {
    const s = makeSessionStateStore(file, { debounceMs: 0 })
    expect(s.isExpired('bot-a')).toBe(false)
    expect(s.listExpired()).toEqual([])
  })

  it('markExpired transitions once', () => {
    const s = makeSessionStateStore(file, { debounceMs: 0 })
    expect(s.markExpired('bot-a', 'test')).toBe(true)
    expect(s.markExpired('bot-a', 'test2')).toBe(false) // idempotent
    expect(s.isExpired('bot-a')).toBe(true)
  })

  it('listExpired sorts oldest first', async () => {
    const s = makeSessionStateStore(file, { debounceMs: 0 })
    s.markExpired('bot-a', 'reason-a')
    await new Promise(r => setTimeout(r, 10))
    s.markExpired('bot-b', 'reason-b')
    const list = s.listExpired()
    expect(list.map(e => e.id)).toEqual(['bot-a', 'bot-b'])
    expect(list[0].last_reason).toBe('reason-a')
  })

  it('clear removes entry', () => {
    const s = makeSessionStateStore(file, { debounceMs: 0 })
    s.markExpired('bot-a')
    s.clear('bot-a')
    expect(s.isExpired('bot-a')).toBe(false)
    expect(s.listExpired()).toEqual([])
  })

  it('persists across instances', async () => {
    const s1 = makeSessionStateStore(file, { debounceMs: 0 })
    s1.markExpired('bot-a', 'boom')
    await s1.flush()
    const s2 = makeSessionStateStore(file, { debounceMs: 0 })
    expect(s2.isExpired('bot-a')).toBe(true)
    expect(s2.listExpired()[0].last_reason).toBe('boom')
  })

  it('survives corrupt JSON', () => {
    require('node:fs').writeFileSync(file, '{not valid json')
    const s = makeSessionStateStore(file, { debounceMs: 0 })
    expect(s.listExpired()).toEqual([])
    s.markExpired('bot-a')
    expect(s.isExpired('bot-a')).toBe(true)
  })
})
