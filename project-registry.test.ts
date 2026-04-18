import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  addProject,
  ALIAS_REGEX,
  type ProjectRegistry,
} from './project-registry'

let tmpDir: string
let registryFile: string
let realDir1: string
let realDir2: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'wechat-cc-registry-'))
  registryFile = join(tmpDir, 'projects.json')
  realDir1 = join(tmpDir, 'project-a')
  realDir2 = join(tmpDir, 'project-b')
  mkdirSync(realDir1)
  mkdirSync(realDir2)
})

afterAll(() => {
  // beforeEach creates fresh tmpDirs; don't need to clean each, but catch the last
  try { rmSync(tmpDir, { recursive: true, force: true }) } catch {}
})

describe('ALIAS_REGEX', () => {
  it('accepts valid aliases', () => {
    for (const ok of ['a1', 'compass', 'comp-ass', 'comp_ass', 'a1b2c3']) {
      expect(ALIAS_REGEX.test(ok)).toBe(true)
    }
  })

  it('rejects invalid aliases', () => {
    for (const bad of ['', 'A', 'a', '-a', '_a', 'a b', 'a.b', 'a/b', '你好', 'a'.repeat(21)]) {
      expect(ALIAS_REGEX.test(bad)).toBe(false)
    }
  })
})

describe('addProject', () => {
  it('adds a valid project to an empty registry file', () => {
    addProject(registryFile, 'alpha', realDir1)
    const reg = JSON.parse(readFileSync(registryFile, 'utf8')) as ProjectRegistry
    expect(reg.projects.alpha).toBeDefined()
    expect(reg.projects.alpha!.path).toBe(realDir1)
    expect(reg.projects.alpha!.last_active).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(reg.current).toBe(null)
  })

  it('rejects alias that fails regex', () => {
    expect(() => addProject(registryFile, 'Bad Alias', realDir1)).toThrow(/alias/i)
  })

  it('rejects non-absolute path', () => {
    expect(() => addProject(registryFile, 'alpha', './rel/path')).toThrow(/absolute/i)
  })

  it('rejects path that does not exist', () => {
    expect(() => addProject(registryFile, 'alpha', join(tmpDir, 'nonexistent'))).toThrow(/not a directory/i)
  })

  it('rejects path that is a file, not a directory', () => {
    const filePath = join(tmpDir, 'file.txt')
    writeFileSync(filePath, 'x')
    expect(() => addProject(registryFile, 'alpha', filePath)).toThrow(/not a directory/i)
  })

  it('rejects duplicate alias', () => {
    addProject(registryFile, 'alpha', realDir1)
    expect(() => addProject(registryFile, 'alpha', realDir2)).toThrow(/already/i)
  })

  it('persists multiple projects in insertion order', () => {
    addProject(registryFile, 'alpha', realDir1)
    addProject(registryFile, 'beta', realDir2)
    const reg = JSON.parse(readFileSync(registryFile, 'utf8')) as ProjectRegistry
    expect(Object.keys(reg.projects)).toEqual(['alpha', 'beta'])
  })
})
