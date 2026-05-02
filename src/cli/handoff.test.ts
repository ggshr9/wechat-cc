import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { writeHandoff, type HandoffInput } from './handoff'

let tmpDir: string
let targetDir: string

const tmpDirs: string[] = []

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'wechat-cc-handoff-'))
  tmpDirs.push(tmpDir)
  targetDir = join(tmpDir, 'target-project')
  mkdirSync(targetDir)
})

afterAll(() => {
  for (const d of tmpDirs) {
    try { rmSync(d, { recursive: true, force: true }) } catch {}
  }
})

function baseInput(): HandoffInput {
  return {
    targetDir,
    sourceAlias: 'compass',
    sourcePath: '/home/u/Documents/compass',
    sourceJsonl: '/home/u/.claude/projects/-home-u-Documents-compass/abc.jsonl',
    timestamp: '2026-04-18T10:00:00.000Z',
    note: null,
  }
}

describe('writeHandoff', () => {
  it('creates memory/ directory when missing', () => {
    expect(existsSync(join(targetDir, 'memory'))).toBe(false)
    writeHandoff(baseInput())
    expect(existsSync(join(targetDir, 'memory'))).toBe(true)
  })

  it('writes _handoff.md with YAML frontmatter and expected fields', () => {
    writeHandoff(baseInput())
    const body = readFileSync(join(targetDir, 'memory', '_handoff.md'), 'utf8')
    expect(body).toMatch(/^---\n/)
    expect(body).toContain('type: reference')
    expect(body).toContain('来源项目: compass (/home/u/Documents/compass)')
    expect(body).toContain('切换时间: 2026-04-18T10:00:00.000Z')
    expect(body).toContain('/home/u/.claude/projects/-home-u-Documents-compass/abc.jsonl')
    expect(body).toContain('用户备注: 无')
  })

  it('includes note when provided', () => {
    writeHandoff({ ...baseInput(), note: '继续搞 wechat-cc 切换' })
    const body = readFileSync(join(targetDir, 'memory', '_handoff.md'), 'utf8')
    expect(body).toContain('用户备注: 继续搞 wechat-cc 切换')
  })

  it('overwrites existing _handoff.md (single-file policy)', () => {
    writeHandoff({ ...baseInput(), note: 'first' })
    writeHandoff({ ...baseInput(), note: 'second' })
    const body = readFileSync(join(targetDir, 'memory', '_handoff.md'), 'utf8')
    expect(body).toContain('用户备注: second')
    expect(body).not.toContain('用户备注: first')
  })

  it('writes atomically (no .tmp file left behind)', () => {
    writeHandoff(baseInput())
    expect(existsSync(join(targetDir, 'memory', '_handoff.md.tmp'))).toBe(false)
  })
})

describe('MEMORY.md index maintenance', () => {
  it('creates MEMORY.md with index line when missing', () => {
    writeHandoff(baseInput())
    const mem = readFileSync(join(targetDir, 'memory', 'MEMORY.md'), 'utf8')
    expect(mem).toContain('](_handoff.md)')
    expect(mem).toContain('compass')
  })

  it('appends to existing MEMORY.md without touching other lines', () => {
    mkdirSync(join(targetDir, 'memory'))
    writeFileSync(join(targetDir, 'memory', 'MEMORY.md'), [
      '# Memory',
      '',
      '- [Some note](note.md) — existing',
      '',
    ].join('\n'))
    writeHandoff(baseInput())
    const mem = readFileSync(join(targetDir, 'memory', 'MEMORY.md'), 'utf8')
    expect(mem).toContain('[Some note](note.md)')
    expect(mem).toContain('](_handoff.md)')
  })

  it('replaces existing _handoff.md index line (does not duplicate)', () => {
    mkdirSync(join(targetDir, 'memory'))
    writeFileSync(join(targetDir, 'memory', 'MEMORY.md'), [
      '# Memory',
      '- [Cross-project handoff](_handoff.md) — from OLD at 2025-01-01',
      '',
    ].join('\n'))
    writeHandoff(baseInput())
    const mem = readFileSync(join(targetDir, 'memory', 'MEMORY.md'), 'utf8')
    const handoffLines = mem.split('\n').filter(l => l.includes('](_handoff.md)'))
    expect(handoffLines).toHaveLength(1)
    expect(handoffLines[0]).toContain('compass')
    expect(handoffLines[0]).not.toContain('OLD')
  })
})
