import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeIntrospectAgent, resolveIntrospectChatId } from './introspect-runtime'

describe('makeIntrospectAgent (v0.4 stub)', () => {
  it('always returns write=false with a v0.4.1 follow-up reasoning', async () => {
    const agent = makeIntrospectAgent()
    const result = await agent.runIntrospect()
    expect(result.write).toBe(false)
    expect(result.reasoning).toContain('v0.4.1')
  })
})

describe('resolveIntrospectChatId', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'introspect-rt-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('returns null when no companion config exists', () => {
    expect(resolveIntrospectChatId(dir)).toBeNull()
  })

  it('returns null when default_chat_id is not set', () => {
    const cfgDir = join(dir, 'companion')
    mkdirSync(cfgDir, { recursive: true })
    writeFileSync(join(cfgDir, 'config.json'), JSON.stringify({ enabled: true }))
    expect(resolveIntrospectChatId(dir)).toBeNull()
  })

  it('returns the configured default_chat_id', () => {
    const cfgDir = join(dir, 'companion')
    mkdirSync(cfgDir, { recursive: true })
    writeFileSync(join(cfgDir, 'config.json'), JSON.stringify({ enabled: true, default_chat_id: 'chat_x' }))
    expect(resolveIntrospectChatId(dir)).toBe('chat_x')
  })
})
