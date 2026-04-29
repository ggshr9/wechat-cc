import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveProjectJsonlPath } from './path-resolver'

describe('resolveProjectJsonlPath', () => {
  let home: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'home-'))
    mkdirSync(join(home, '.claude', 'projects'), { recursive: true })
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  it('finds the jsonl file by glob', () => {
    const projDir = join(home, '.claude', 'projects', '-Users-alice-compass')
    mkdirSync(projDir, { recursive: true })
    writeFileSync(join(projDir, 's_abc123.jsonl'), '')
    expect(resolveProjectJsonlPath('compass', 's_abc123', { home }))
      .toBe(join(projDir, 's_abc123.jsonl'))
  })

  it('returns synthesized "_unknown_" path when not found', () => {
    const result = resolveProjectJsonlPath('nope', 's_xxx', { home })
    expect(result).toContain('_unknown_')
  })

  it('returns synthesized path when projects/ does not exist', () => {
    const empty = mkdtempSync(join(tmpdir(), 'no-claude-'))
    try {
      const result = resolveProjectJsonlPath('any', 's_xxx', { home: empty })
      expect(result).toContain('_unknown_')
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })
})
