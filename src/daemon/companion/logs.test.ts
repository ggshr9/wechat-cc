import { describe, it, expect } from 'vitest'
import { makeRunsLogger, makePushLogger, type RunEntry, type PushEntry } from './logs'
import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'wcc-logs-'))
  mkdirSync(join(d, 'companion'), { recursive: true })
  return d
}

describe('makeRunsLogger', () => {
  it('append writes one JSON line per entry', () => {
    const d = freshDir()
    const logger = makeRunsLogger(d)
    logger.append({
      ts: '2026-04-22T00:00:00Z', trigger_id: 't1', persona: 'assistant',
      duration_ms: 100, pushed: false, reason: 'ok', tool_uses_count: 0, cost_usd: 0,
    })
    const content = readFileSync(join(d, 'companion', 'runs.jsonl'), 'utf8')
    const lines = content.trim().split('\n')
    expect(lines).toHaveLength(1)
    const parsed = JSON.parse(lines[0]!)
    expect(parsed.trigger_id).toBe('t1')
    expect(parsed.pushed).toBe(false)
  })

  it('append appends (does not truncate)', () => {
    const d = freshDir()
    const logger = makeRunsLogger(d)
    for (let i = 0; i < 3; i++) {
      logger.append({
        ts: `2026-04-22T00:00:0${i}Z`, trigger_id: `t${i}`, persona: 'assistant',
        duration_ms: 100, pushed: false, reason: 'ok', tool_uses_count: 0, cost_usd: 0,
      })
    }
    const content = readFileSync(join(d, 'companion', 'runs.jsonl'), 'utf8')
    expect(content.trim().split('\n')).toHaveLength(3)
  })

  it('append creates companion dir if missing', () => {
    const d = mkdtempSync(join(tmpdir(), 'wcc-logs-nodir-'))
    const logger = makeRunsLogger(d)
    logger.append({
      ts: '2026-04-22T00:00:00Z', trigger_id: 't', persona: 'a',
      duration_ms: 0, pushed: false, reason: 'ok', tool_uses_count: 0, cost_usd: 0,
    })
    expect(existsSync(join(d, 'companion', 'runs.jsonl'))).toBe(true)
  })

  it('rotate is no-op when file is under 10MB', () => {
    const d = freshDir()
    const logger = makeRunsLogger(d)
    logger.append({
      ts: '2026-04-22T00:00:00Z', trigger_id: 't', persona: 'a',
      duration_ms: 0, pushed: false, reason: 'ok', tool_uses_count: 0, cost_usd: 0,
    })
    logger.rotate()
    expect(existsSync(join(d, 'companion', 'runs.jsonl'))).toBe(true)
    expect(existsSync(join(d, 'companion', 'runs.jsonl.1'))).toBe(false)
  })

  it('rotate moves file to .1 when size >= 10MB', () => {
    const d = freshDir()
    // Create a pre-sized 11MB file directly (faster than appending)
    const path = join(d, 'companion', 'runs.jsonl')
    writeFileSync(path, Buffer.alloc(11 * 1024 * 1024, 'x'))
    const logger = makeRunsLogger(d)
    logger.rotate()
    expect(existsSync(join(d, 'companion', 'runs.jsonl.1'))).toBe(true)
    // primary removed / renamed
    expect(existsSync(path)).toBe(false)
  })
})

describe('makePushLogger', () => {
  it('writes push entries with required fields', () => {
    const d = freshDir()
    const logger = makePushLogger(d)
    logger.append({
      ts: '2026-04-22T00:00:00Z', trigger_id: 't1', persona: 'assistant',
      message: 'hi', chat_id: 'c', delivery_status: 'ok',
    })
    const content = readFileSync(join(d, 'companion', 'push-log.jsonl'), 'utf8')
    const parsed = JSON.parse(content.trim().split('\n')[0]!)
    expect(parsed.message).toBe('hi')
    expect(parsed.chat_id).toBe('c')
    expect(parsed.delivery_status).toBe('ok')
  })

  it('rotate works identically to runs logger', () => {
    const d = freshDir()
    const path = join(d, 'companion', 'push-log.jsonl')
    writeFileSync(path, Buffer.alloc(11 * 1024 * 1024, 'x'))
    makePushLogger(d).rotate()
    expect(existsSync(join(d, 'companion', 'push-log.jsonl.1'))).toBe(true)
  })
})
