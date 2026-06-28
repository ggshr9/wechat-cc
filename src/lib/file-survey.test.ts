// src/lib/file-survey.test.ts
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { surveyFiles, formatFileSurvey, defaultLifeDirs, DEFAULT_SURVEY_LIMITS } from './file-survey'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wcc-survey-'))
  mkdirSync(join(root, '工作'), { recursive: true })
  mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true })
  writeFileSync(join(root, '工作', 'Q3预算.xlsx'), 'a')
  writeFileSync(join(root, '工作', '旧档.txt'), 'b')
  writeFileSync(join(root, '合同.pdf'), 'c')
  writeFileSync(join(root, 'node_modules', 'pkg', 'index.js'), 'd')
  writeFileSync(join(root, '.DS_Store'), '')
  // make Q3预算.xlsx newer than 旧档.txt for recency ordering
  utimesSync(join(root, '工作', '旧档.txt'), new Date(1000), new Date(1000))
  utimesSync(join(root, '工作', 'Q3预算.xlsx'), new Date(9000), new Date(9000))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('surveyFiles', () => {
  it('maps folders with file counts, subdirs, and skips SKIP_DIRS/dotfiles', () => {
    const r = surveyFiles({ roots: [root] })
    const paths = r.folders.map(f => f.path)
    expect(paths).toContain(root)
    expect(paths).toContain(join(root, '工作'))
    expect(paths.some(p => p.includes('node_modules'))).toBe(false)
    const top = r.folders.find(f => f.path === root)!
    expect(top.subdirs).toContain('工作')
    expect(top.subdirs).not.toContain('node_modules')
    expect(top.fileCount).toBe(1) // 合同.pdf only (.DS_Store dotfile skipped)
    expect(top.sample).not.toContain('.DS_Store')
  })

  it('samples filenames most-recent first, capped at samplePerFolder', () => {
    const r = surveyFiles({ roots: [root], limits: { samplePerFolder: 1 } })
    const work = r.folders.find(f => f.path === join(root, '工作'))!
    expect(work.sample).toEqual(['Q3预算.xlsx']) // newer than 旧档.txt, cap 1
  })

  it('truncates at maxFolders', () => {
    const r = surveyFiles({ roots: [root], limits: { maxFolders: 1 } })
    expect(r.truncated).toBe(true)
    expect(r.folders.length).toBe(1)
  })

  it('tolerates a missing root', () => {
    const r = surveyFiles({ roots: [join(root, 'nope'), root] })
    expect(r.folders.length).toBeGreaterThan(0)
  })

  // Fix 2: overlapping roots must not cause a descendant folder to be walked twice
  it('each folder appears at most once when roots overlap (child is also a root)', () => {
    const child = join(root, '工作')
    // root contains '工作/' as a subdir; pass both as roots
    const r = surveyFiles({ roots: [root, child] })
    const childEntries = r.folders.filter(f => f.path === child)
    expect(childEntries.length).toBe(1)
  })
})

describe('formatFileSurvey', () => {
  it('renders home-shortened folder lines and a truncation marker', () => {
    const survey = { folders: [{ path: join(root, '工作'), fileCount: 2, subdirs: [], sample: ['Q3预算.xlsx'] }], truncated: true }
    const out = formatFileSurvey(survey, DEFAULT_SURVEY_LIMITS.totalBytes, root)
    expect(out).toContain('~/工作/ (2 个文件): Q3预算.xlsx')
    expect(out).toContain('截断')
  })
  it('returns empty string for an empty survey', () => {
    expect(formatFileSurvey({ folders: [], truncated: false })).toBe('')
  })
  it('byte-caps the rendered body', () => {
    const folders = Array.from({ length: 50 }, (_, i) => ({ path: `/x/dir${i}`, fileCount: i, subdirs: [], sample: ['a'] }))
    const out = formatFileSurvey({ folders, truncated: false }, 80)
    expect(out.length).toBeLessThanOrEqual(80 + 8) // body cap + short marker
    expect(out).toContain('截断')
  })
})

describe('defaultLifeDirs', () => {
  it('is Desktop/Documents/Downloads under home', () => {
    expect(defaultLifeDirs('/home/me')).toEqual(['/home/me/Desktop', '/home/me/Documents', '/home/me/Downloads'])
  })
})
