import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  addProject,
  listProjects,
  setCurrent,
  removeProject,
  resolveProject,
  ALIAS_REGEX,
  type ProjectRegistry,
} from './project-registry'

let tmpDir: string
let registryFile: string
let realDir1: string
let realDir2: string

const tmpDirs: string[] = []

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'wechat-cc-registry-'))
  tmpDirs.push(tmpDir)
  registryFile = join(tmpDir, 'projects.json')
  realDir1 = join(tmpDir, 'project-a')
  realDir2 = join(tmpDir, 'project-b')
  mkdirSync(realDir1)
  mkdirSync(realDir2)
})

afterAll(() => {
  for (const d of tmpDirs) {
    try { rmSync(d, { recursive: true, force: true }) } catch {}
  }
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

describe('listProjects', () => {
  it('returns [] when registry file is missing', () => {
    expect(listProjects(registryFile)).toEqual([])
  })

  it('returns all registered projects with is_current flag', () => {
    addProject(registryFile, 'alpha', realDir1)
    addProject(registryFile, 'beta', realDir2)
    setCurrent(registryFile, 'beta')
    const out = listProjects(registryFile)
    expect(out).toHaveLength(2)
    const beta = out.find(p => p.alias === 'beta')!
    const alpha = out.find(p => p.alias === 'alpha')!
    expect(beta.is_current).toBe(true)
    expect(alpha.is_current).toBe(false)
  })

  it('sorts by last_active descending', async () => {
    addProject(registryFile, 'alpha', realDir1)
    await new Promise(r => setTimeout(r, 10))
    addProject(registryFile, 'beta', realDir2)
    await new Promise(r => setTimeout(r, 10))
    setCurrent(registryFile, 'alpha')  // bumps alpha
    const out = listProjects(registryFile)
    // alpha was just bumped, so it's most recent
    expect(out[0]!.alias).toBe('alpha')
    expect(out[1]!.alias).toBe('beta')
  })
})

describe('setCurrent', () => {
  it('sets current and bumps target last_active', async () => {
    addProject(registryFile, 'alpha', realDir1)
    addProject(registryFile, 'beta', realDir2)
    const before = JSON.parse(readFileSync(registryFile, 'utf8')) as ProjectRegistry
    const alphaBefore = before.projects.alpha!.last_active

    await new Promise(r => setTimeout(r, 20))
    setCurrent(registryFile, 'alpha')

    const after = JSON.parse(readFileSync(registryFile, 'utf8')) as ProjectRegistry
    expect(after.current).toBe('alpha')
    expect(after.projects.alpha!.last_active).not.toBe(alphaBefore)
    expect(Date.parse(after.projects.alpha!.last_active)).toBeGreaterThan(Date.parse(alphaBefore))
  })

  it('does not bump previously-current on switch out', async () => {
    addProject(registryFile, 'alpha', realDir1)
    addProject(registryFile, 'beta', realDir2)
    setCurrent(registryFile, 'alpha')
    const midState = JSON.parse(readFileSync(registryFile, 'utf8')) as ProjectRegistry
    const alphaAt = midState.projects.alpha!.last_active

    await new Promise(r => setTimeout(r, 20))
    setCurrent(registryFile, 'beta')

    const final = JSON.parse(readFileSync(registryFile, 'utf8')) as ProjectRegistry
    expect(final.current).toBe('beta')
    expect(final.projects.alpha!.last_active).toBe(alphaAt)  // unchanged
    expect(Date.parse(final.projects.beta!.last_active)).toBeGreaterThan(Date.parse(alphaAt))
  })

  it('throws if alias not registered', () => {
    expect(() => setCurrent(registryFile, 'ghost')).toThrow(/not registered/i)
  })
})

describe('removeProject', () => {
  it('removes a registered non-current project', () => {
    addProject(registryFile, 'alpha', realDir1)
    addProject(registryFile, 'beta', realDir2)
    setCurrent(registryFile, 'alpha')
    removeProject(registryFile, 'beta')
    const reg = JSON.parse(readFileSync(registryFile, 'utf8')) as ProjectRegistry
    expect(reg.projects.beta).toBeUndefined()
    expect(reg.projects.alpha).toBeDefined()
    expect(reg.current).toBe('alpha')
  })

  it('rejects removing the current project', () => {
    addProject(registryFile, 'alpha', realDir1)
    setCurrent(registryFile, 'alpha')
    expect(() => removeProject(registryFile, 'alpha')).toThrow(/current/i)
  })

  it('throws if alias not registered', () => {
    expect(() => removeProject(registryFile, 'ghost')).toThrow(/not registered/i)
  })
})

describe('resolveProject', () => {
  it('returns entry for a registered alias', () => {
    addProject(registryFile, 'alpha', realDir1)
    const entry = resolveProject(registryFile, 'alpha')
    expect(entry?.path).toBe(realDir1)
  })

  it('returns null for unknown alias', () => {
    expect(resolveProject(registryFile, 'ghost')).toBe(null)
  })

  it('returns null for missing registry file', () => {
    expect(resolveProject(registryFile, 'alpha')).toBe(null)
  })
})

describe('corruption fallback', () => {
  it('listProjects returns [] on corrupted JSON (does not throw)', () => {
    writeFileSync(registryFile, 'this is not valid json {')
    expect(listProjects(registryFile)).toEqual([])
  })

  it('resolveProject returns null on corrupted JSON', () => {
    writeFileSync(registryFile, '{{{malformed')
    expect(resolveProject(registryFile, 'anything')).toBe(null)
  })

  it('addProject recovers by overwriting corrupted file', () => {
    writeFileSync(registryFile, 'garbage')
    addProject(registryFile, 'alpha', realDir1)
    const reg = JSON.parse(readFileSync(registryFile, 'utf8')) as ProjectRegistry
    expect(reg.projects.alpha).toBeDefined()
  })
})
