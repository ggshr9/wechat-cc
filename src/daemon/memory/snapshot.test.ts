import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildMemorySnapshot } from './snapshot'

describe('buildMemorySnapshot', () => {
  let stateDir: string
  beforeEach(() => { stateDir = mkdtempSync(join(tmpdir(), 'snap-')) })
  afterEach(() => rmSync(stateDir, { recursive: true, force: true }))

  it('returns empty string when chat dir does not exist', async () => {
    expect(await buildMemorySnapshot(stateDir, 'nope')).toBe('')
  })

  it('returns empty string when chat dir has no .md files', async () => {
    mkdirSync(join(stateDir, 'memory', 'chat_x'), { recursive: true })
    writeFileSync(join(stateDir, 'memory', 'chat_x', 'observations.jsonl'), 'jsonl')
    expect(await buildMemorySnapshot(stateDir, 'chat_x')).toBe('')
  })

  it('concatenates all .md files with filename headers', async () => {
    const dir = join(stateDir, 'memory', 'chat_x')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'profile.md'), '叫小明')
    writeFileSync(join(dir, 'preferences.md'), '总结请像朋友说话')
    const snap = await buildMemorySnapshot(stateDir, 'chat_x')
    expect(snap).toContain('# profile.md')
    expect(snap).toContain('叫小明')
    expect(snap).toContain('# preferences.md')
    expect(snap).toContain('总结请像朋友说话')
  })

  it('skips non-md files in the same dir', async () => {
    const dir = join(stateDir, 'memory', 'chat_x')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'profile.md'), 'real-md')
    writeFileSync(join(dir, 'observations.jsonl'), 'not-md')
    writeFileSync(join(dir, 'archive.txt'), 'not-md')
    const snap = await buildMemorySnapshot(stateDir, 'chat_x')
    expect(snap).toContain('real-md')
    expect(snap).not.toContain('not-md')
  })
})
