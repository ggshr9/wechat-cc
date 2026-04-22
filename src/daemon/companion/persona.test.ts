import { describe, it, expect } from 'vitest'
import { parsePersonaFile, listPersonas, loadPersona } from './persona'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const VALID_FRONT = `---
name: assistant
display_name: 小助手
min_push_gap_minutes: 10
quiet_hours_local: "00:00-08:00"
---

# 系统提示

内容`

describe('parsePersonaFile', () => {
  it('parses valid front-matter + body', () => {
    const p = parsePersonaFile(VALID_FRONT, '/tmp/a.md')
    expect(p).not.toBeNull()
    expect(p!.frontmatter.name).toBe('assistant')
    expect(p!.frontmatter.display_name).toBe('小助手')
    expect(p!.frontmatter.min_push_gap_minutes).toBe(10)
    expect(p!.frontmatter.quiet_hours_local).toBe('00:00-08:00')
    expect(p!.body).toContain('系统提示')
    expect(p!.body).not.toMatch(/^---/)
  })

  it('returns null when front-matter is missing', () => {
    expect(parsePersonaFile('# just body', '/tmp/a.md')).toBeNull()
  })

  it('returns null when front-matter block is unclosed', () => {
    expect(parsePersonaFile('---\nname: x\n\nbody without closer', '/tmp/a.md')).toBeNull()
  })

  it('returns null when name field is missing', () => {
    const missing = `---\ndisplay_name: X\n---\n\nbody`
    expect(parsePersonaFile(missing, '/tmp/a.md')).toBeNull()
  })

  it('returns null when display_name field is missing', () => {
    const missing = `---\nname: x\n---\n\nbody`
    expect(parsePersonaFile(missing, '/tmp/a.md')).toBeNull()
  })

  it('defaults min_push_gap_minutes to 10 when absent', () => {
    const partial = `---\nname: x\ndisplay_name: X\nquiet_hours_local: ""\n---\n\nbody`
    const p = parsePersonaFile(partial, '/tmp/a.md')
    expect(p).not.toBeNull()
    expect(p!.frontmatter.min_push_gap_minutes).toBe(10)
  })

  it('defaults quiet_hours_local to empty string when absent', () => {
    const partial = `---\nname: x\ndisplay_name: X\nmin_push_gap_minutes: 5\n---\n\nbody`
    const p = parsePersonaFile(partial, '/tmp/a.md')
    expect(p).not.toBeNull()
    expect(p!.frontmatter.quiet_hours_local).toBe('')
  })

  it('records sourcePath', () => {
    const p = parsePersonaFile(VALID_FRONT, '/home/user/.claude/channels/wechat/companion/personas/assistant.md')
    expect(p!.sourcePath).toBe('/home/user/.claude/channels/wechat/companion/personas/assistant.md')
  })

  it('tolerates Windows CRLF line endings', () => {
    const crlf = VALID_FRONT.replace(/\n/g, '\r\n')
    const p = parsePersonaFile(crlf, '/tmp/a.md')
    expect(p).not.toBeNull()
    expect(p!.frontmatter.name).toBe('assistant')
  })
})

describe('listPersonas', () => {
  function freshDir(): string {
    const d = mkdtempSync(join(tmpdir(), 'wcc-p-'))
    return d
  }

  it('returns empty list when personas/ dir missing', () => {
    expect(listPersonas(freshDir())).toEqual([])
  })

  it('returns all parseable persona files', () => {
    const state = freshDir()
    const pdir = join(state, 'companion', 'personas')
    mkdirSync(pdir, { recursive: true })
    writeFileSync(join(pdir, 'assistant.md'), VALID_FRONT)
    writeFileSync(join(pdir, 'companion.md'), VALID_FRONT.replace('assistant', 'companion').replace('小助手', '陪伴'))
    const list = listPersonas(state)
    expect(list.map(p => p.frontmatter.name).sort()).toEqual(['assistant', 'companion'])
  })

  it('skips malformed persona files', () => {
    const state = freshDir()
    const pdir = join(state, 'companion', 'personas')
    mkdirSync(pdir, { recursive: true })
    writeFileSync(join(pdir, 'good.md'), VALID_FRONT)
    writeFileSync(join(pdir, 'broken.md'), 'no front-matter at all')
    const list = listPersonas(state)
    expect(list.map(p => p.frontmatter.name)).toEqual(['assistant'])
  })

  it('ignores non-.md files', () => {
    const state = freshDir()
    const pdir = join(state, 'companion', 'personas')
    mkdirSync(pdir, { recursive: true })
    writeFileSync(join(pdir, 'good.md'), VALID_FRONT)
    writeFileSync(join(pdir, 'README.txt'), 'ignored')
    const list = listPersonas(state)
    expect(list).toHaveLength(1)
  })
})

describe('loadPersona', () => {
  it('returns parsed persona when file exists', () => {
    const state = mkdtempSync(join(tmpdir(), 'wcc-p-'))
    const pdir = join(state, 'companion', 'personas')
    mkdirSync(pdir, { recursive: true })
    writeFileSync(join(pdir, 'assistant.md'), VALID_FRONT)
    const p = loadPersona(state, 'assistant')
    expect(p).not.toBeNull()
    expect(p!.frontmatter.name).toBe('assistant')
  })

  it('returns null when file missing', () => {
    const state = mkdtempSync(join(tmpdir(), 'wcc-p-'))
    expect(loadPersona(state, 'nonexistent')).toBeNull()
  })
})
