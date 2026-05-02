import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listAllMemory, readMemoryFile, writeMemoryFile } from './memory'

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

describe('writeMemoryFile', () => {
  const USER = 'o9cq800sObd3lbrHBgiItB1pooDQ@im.wechat'

  it('writes a new file and reports created=true', () => {
    const result = writeMemoryFile(stateDir, USER, 'fresh.md', '# 新笔记\n')
    expect(result.created).toBe(true)
    expect(result.bytesWritten).toBe(Buffer.byteLength('# 新笔记\n', 'utf8'))
    expect(readMemoryFile(stateDir, USER, 'fresh.md')).toBe('# 新笔记\n')
  })

  it('overwrites existing file with created=false', () => {
    const result = writeMemoryFile(stateDir, USER, 'profile.md', '# 顾时瑞 (edited)\n')
    expect(result.created).toBe(false)
    expect(readMemoryFile(stateDir, USER, 'profile.md')).toBe('# 顾时瑞 (edited)\n')
  })

  it('auto-creates nested parent directories', () => {
    writeMemoryFile(stateDir, USER, 'patterns/work/style.md', 'concise replies')
    expect(readMemoryFile(stateDir, USER, 'patterns/work/style.md')).toBe('concise replies')
  })

  it('uses atomic rename — partial state never visible', () => {
    writeMemoryFile(stateDir, USER, 'profile.md', 'final content')
    // No .tmp- artifacts left behind
    const userDir = join(stateDir, 'memory', USER)
    const tmpFiles = readdirSync(userDir).filter(n => n.includes('.tmp-'))
    expect(tmpFiles).toEqual([])
  })

  it('refuses bodies larger than 100KB', () => {
    const tooBig = 'x'.repeat(101 * 1024)
    expect(() => writeMemoryFile(stateDir, USER, 'huge.md', tooBig)).toThrow(/too large/)
    // Failed write must not leave a partial file behind
    expect(existsSync(join(stateDir, 'memory', USER, 'huge.md'))).toBe(false)
  })

  it('refuses non-.md extensions', () => {
    expect(() => writeMemoryFile(stateDir, USER, 'note.txt', 'x')).toThrow(/only \.md files/)
  })

  it('refuses path traversal', () => {
    expect(() => writeMemoryFile(stateDir, USER, '../../escape.md', 'x')).toThrow(/escapes/)
  })

  it('refuses null bytes', () => {
    expect(() => writeMemoryFile(stateDir, USER, 'evil\0.md', 'x')).toThrow(/invalid path/)
  })

  it('refuses oversized paths', () => {
    expect(() => writeMemoryFile(stateDir, USER, 'a'.repeat(501) + '.md', 'x')).toThrow(/invalid path/)
  })

  it('refuses unsafe user ids', () => {
    expect(() => writeMemoryFile(stateDir, '../etc', 'note.md', 'x')).toThrow(/invalid user id/)
  })

  it('roundtrips UTF-8 multibyte content faithfully', () => {
    const body = '# 你好世界 🍣\n\n表情符号 + 中文应该原样保留'
    writeMemoryFile(stateDir, USER, 'i18n.md', body)
    const stored = readFileSync(join(stateDir, 'memory', USER, 'i18n.md'), 'utf8')
    expect(stored).toBe(body)
  })
})
