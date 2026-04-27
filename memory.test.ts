import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listAllMemory, readMemoryFile } from './memory'

let stateDir: string

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'wechat-cc-mem-'))
  const u1 = join(stateDir, 'memory', 'o9cq800sObd3lbrHBgiItB1pooDQ@im.wechat')
  mkdirSync(u1, { recursive: true })
  writeFileSync(join(u1, 'profile.md'), '# 顾时瑞\n\nhi')
  writeFileSync(join(u1, 'project-hearth.md'), '# Hearth\n')
  mkdirSync(join(u1, 'sub'), { recursive: true })
  writeFileSync(join(u1, 'sub', 'note.md'), 'nested')
  writeFileSync(join(u1, 'binary.bin'), 'should be skipped')
  writeFileSync(join(u1, '.hidden.md'), 'should be skipped')
})

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true })
})

describe('listAllMemory', () => {
  it('lists each user directory with .md files (and skips non-md / hidden / binary)', () => {
    const users = listAllMemory(stateDir)
    expect(users).toHaveLength(1)
    expect(users[0]!.userId).toBe('o9cq800sObd3lbrHBgiItB1pooDQ@im.wechat')
    expect(users[0]!.files.map(f => f.path)).toEqual(['profile.md', 'project-hearth.md', 'sub/note.md'])
    expect(users[0]!.fileCount).toBe(3)
    expect(users[0]!.totalBytes).toBeGreaterThan(0)
  })

  it('returns empty when memory dir does not exist (fresh install)', () => {
    rmSync(join(stateDir, 'memory'), { recursive: true })
    expect(listAllMemory(stateDir)).toEqual([])
  })

  it('skips directories whose names look unsafe (path traversal guard)', () => {
    mkdirSync(join(stateDir, 'memory', '..'), { recursive: true })  // not actually creatable, defensive
    mkdirSync(join(stateDir, 'memory', 'has spaces'), { recursive: true })
    const users = listAllMemory(stateDir)
    expect(users.find(u => u.userId === 'has spaces')).toBeUndefined()
  })
})

describe('readMemoryFile', () => {
  it('returns content for a valid file', () => {
    const content = readMemoryFile(stateDir, 'o9cq800sObd3lbrHBgiItB1pooDQ@im.wechat', 'profile.md')
    expect(content).toContain('顾时瑞')
  })

  it('reads nested files', () => {
    const content = readMemoryFile(stateDir, 'o9cq800sObd3lbrHBgiItB1pooDQ@im.wechat', 'sub/note.md')
    expect(content).toBe('nested')
  })

  it('refuses path traversal escapes', () => {
    expect(() => readMemoryFile(stateDir, 'o9cq800sObd3lbrHBgiItB1pooDQ@im.wechat', '../../etc/passwd.md'))
      .toThrow(/escapes/)
  })

  it('refuses non-md extensions', () => {
    expect(() => readMemoryFile(stateDir, 'o9cq800sObd3lbrHBgiItB1pooDQ@im.wechat', 'binary.bin'))
      .toThrow(/only \.md files/)
  })

  it('refuses unsafe user ids', () => {
    expect(() => readMemoryFile(stateDir, '../etc', 'profile.md')).toThrow(/invalid user id/)
  })

  it('throws when file is missing', () => {
    expect(() => readMemoryFile(stateDir, 'o9cq800sObd3lbrHBgiItB1pooDQ@im.wechat', 'absent.md'))
      .toThrow(/not found/)
  })
})
