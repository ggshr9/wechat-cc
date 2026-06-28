import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openTestDb } from './db'
import { makeObservationsStore } from '../daemon/observations/store'
import { makeMilestonesStore } from '../daemon/milestones/store'
import { makeLifeStoresReader } from '../daemon/life-stores'
import { writeMemoryFile } from './memory'
import {
  discoverProjectMemory,
  formatSynthesisPrompt,
  gatherFileSurvey,
  gatherLifeContext,
  projectDisplayName,
  summarizeProjectMemories,
  synthesizeOverview,
  OVERVIEW_FILENAME,
} from './memory-synthesis'

let projectsRoot: string
let stateDir: string

// Lay down a Claude-style per-project memory dir under projectsRoot.
function seedProject(encodedDir: string, files: Record<string, string>): void {
  const memDir = join(projectsRoot, encodedDir, 'memory')
  mkdirSync(memDir, { recursive: true })
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(memDir, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, content)
  }
}

beforeEach(() => {
  projectsRoot = mkdtempSync(join(tmpdir(), 'wcc-proj-'))
  stateDir = mkdtempSync(join(tmpdir(), 'wcc-state-'))
})
afterEach(() => {
  rmSync(projectsRoot, { recursive: true, force: true })
  rmSync(stateDir, { recursive: true, force: true })
})

describe('projectDisplayName', () => {
  it('strips home prefix + container, keeps hyphenated project names', () => {
    expect(projectDisplayName('-Users-me-Documents-sec-company', '/Users/me')).toBe('sec-company')
    expect(projectDisplayName('-Users-me-Documents-wechat-cc', '/Users/me')).toBe('wechat-cc')
    expect(projectDisplayName('-Users-me-Documents-kawanco-dev', '/Users/me')).toBe('kawanco-dev')
  })
  it('handles underscore-containing home dirs (encoded same as path sep)', () => {
    // /Users/na_me → "-Users-na-me-"; project "my-proj" under Documents
    expect(projectDisplayName('-Users-na-me-Documents-my-proj', '/Users/na_me')).toBe('my-proj')
  })
  it('falls back to the de-prefixed dir when home does not match', () => {
    expect(projectDisplayName('-some-other-path', '/Users/me')).toBe('some-other-path')
  })
})

describe('discoverProjectMemory', () => {
  it('finds projects with a memory dir, splitting MEMORY.md from other files', () => {
    seedProject('-Users-me-Documents-alpha', {
      'MEMORY.md': '- [x](x.md) — hook',
      'x.md': 'fact x',
    })
    seedProject('-Users-me-Documents-beta', { 'note.md': 'fact y' })
    const found = discoverProjectMemory(projectsRoot)
    expect(found.length).toBe(2)
    const alpha = found.find(p => p.encodedDir.endsWith('alpha'))!
    expect(alpha.index).toContain('hook')
    expect(alpha.files.map(f => f.path)).toEqual(['x.md'])
    const beta = found.find(p => p.encodedDir.endsWith('beta'))!
    expect(beta.index).toBeNull()
    expect(beta.files.length).toBe(1)
  })

  it('skips project dirs with no memory dir and empty memory dirs', () => {
    mkdirSync(join(projectsRoot, '-no-memory-here'), { recursive: true })
    mkdirSync(join(projectsRoot, '-empty', 'memory'), { recursive: true })
    seedProject('-real', { 'a.md': 'x' })
    const found = discoverProjectMemory(projectsRoot)
    expect(found.map(p => p.encodedDir)).toEqual(['-real'])
  })

  it('returns [] when projectsRoot does not exist', () => {
    expect(discoverProjectMemory(join(projectsRoot, 'nope'))).toEqual([])
  })
})

describe('summarizeProjectMemories', () => {
  it('returns read-only per-project metadata + content', () => {
    seedProject('-real-alpha', { 'MEMORY.md': 'idx', 'a.md': 'hello' })
    const out = summarizeProjectMemories(projectsRoot)
    expect(out.length).toBe(1)
    expect(out[0]!.index).toBe('idx')
    expect(out[0]!.files).toEqual([{ path: 'a.md', bytes: 5, content: 'hello' }])
    expect(out[0]!.totalBytes).toBeGreaterThan(0)
  })
})

describe('formatSynthesisPrompt', () => {
  it('embeds project names, counts, and content', () => {
    const prompt = formatSynthesisPrompt([
      { encodedDir: '-p-alpha', displayName: 'alpha', index: 'idx', files: [{ path: 'a.md', content: 'detail-a' }], totalBytes: 10 },
    ])
    expect(prompt).toContain('共 1 个项目')
    expect(prompt).toContain('alpha')
    expect(prompt).toContain('detail-a')
    expect(prompt).toContain('项目地图')
  })
})

describe('synthesizeOverview', () => {
  it('dry-run discovers without calling eval or writing', async () => {
    seedProject('-alpha', { 'MEMORY.md': 'idx', 'x.md': 'fact' })
    let called = false
    const res = await synthesizeOverview({
      stateDir,
      adminChatId: 'admin@im.wechat',
      projectsRoot,
      dryRun: true,
      sdkEval: async () => { called = true; return 'should not run' },
    })
    expect(called).toBe(false)
    expect(res.projectsFound).toBe(1)
    expect(res.projectNames).toEqual(['alpha'])
    expect(res.filesScanned).toBe(2)
    expect(res.written).toBeUndefined()
  })

  it('writes _overview.md under the admin memory dir on a real run', async () => {
    seedProject('-Users-me-Documents-alpha', { 'MEMORY.md': 'idx', 'x.md': 'fact' })
    const res = await synthesizeOverview({
      stateDir,
      adminChatId: 'admin@im.wechat',
      projectsRoot,
      sdkEval: async (p) => `整理结果(based on ${p.length} chars)`,
    })
    expect(res.written?.path).toBe(OVERVIEW_FILENAME)
    const onDisk = readFileSync(join(stateDir, 'memory', 'admin@im.wechat', OVERVIEW_FILENAME), 'utf8')
    expect(onDisk).toContain('整理结果')
    expect(onDisk).toContain('由 wechat-cc') // provenance stamp
  })

  it('no projects → no eval, no write', async () => {
    let called = false
    const res = await synthesizeOverview({
      stateDir,
      adminChatId: 'admin@im.wechat',
      projectsRoot,
      sdkEval: async () => { called = true; return 'x' },
    })
    expect(called).toBe(false)
    expect(res.projectsFound).toBe(0)
    expect(res.written).toBeUndefined()
  })

  it('empty eval result is not written', async () => {
    seedProject('-p', { 'a.md': 'x' })
    const res = await synthesizeOverview({
      stateDir,
      adminChatId: 'admin@im.wechat',
      projectsRoot,
      sdkEval: async () => '   ',
    })
    expect(res.written).toBeUndefined()
  })

  it('folds the life side (observations / milestones / admin notes) into the prompt', async () => {
    seedProject('-real-work', { 'MEMORY.md': 'idx', 'a.md': 'wrote code' })
    const db = openTestDb()
    const adminChatId = 'admin@im.wechat'
    await makeObservationsStore(db, adminChatId, {}).append({ body: '他最近在准备搬家' })
    await makeMilestonesStore(db, adminChatId, {}).fire({ id: 'ms_test', body: '第一次用语音功能' })
    writeMemoryFile(stateDir, adminChatId, 'profile.md', '喜欢猫')

    let prompt = ''
    const res = await synthesizeOverview({
      stateDir, adminChatId, projectsRoot, lifeStores: makeLifeStoresReader(db, stateDir),
      sdkEval: async (p) => { prompt = p; return '整理结果' },
    })
    db.close()
    expect(res.observationsFound).toBe(1)
    expect(res.milestonesFound).toBe(1)
    expect(res.memoryNotesFound).toBe(1)
    expect(prompt).toContain('搬家')
    expect(prompt).toContain('语音')
    expect(prompt).toContain('喜欢猫')
    expect(prompt).toContain('生活侧')
    expect(res.written).toBeDefined()
  })

  it('gatherLifeContext keeps the MOST RECENT observations (last 20), not the oldest', async () => {
    const db = openTestDb()
    const adminChatId = 'admin@im.wechat'
    const { makeObservationsStore } = await import('../daemon/observations/store')
    const store = makeObservationsStore(db, adminChatId, {})
    for (let i = 1; i <= 25; i++) await store.append({ body: `obs-${i}` })
    const life = await gatherLifeContext({ stores: makeLifeStoresReader(db, stateDir), stateDir, adminChatId })
    db.close()
    expect(life.observations.length).toBe(20)
    expect(life.observations).toContain('obs-25')  // newest kept
    expect(life.observations).not.toContain('obs-1')  // oldest dropped
  })

  it('synthesizes from life alone when there are zero projects', async () => {
    const db = openTestDb()
    const adminChatId = 'admin@im.wechat'
    await makeObservationsStore(db, adminChatId, {}).append({ body: '生活观察一条' })
    let called = false
    const res = await synthesizeOverview({
      stateDir, adminChatId, projectsRoot, lifeStores: makeLifeStoresReader(db, stateDir),  // projectsRoot empty → 0 projects
      sdkEval: async () => { called = true; return 'ok' },
    })
    db.close()
    expect(res.projectsFound).toBe(0)
    expect(res.observationsFound).toBe(1)
    expect(called).toBe(true)
    expect(res.written).toBeDefined()
  })
})

describe('file survey in synthesis', () => {
  it('formatSynthesisPrompt includes the 文件侧 block when survey non-empty, omits when empty', () => {
    const survey = { folders: [{ path: '/home/me/工作', fileCount: 3, subdirs: [], sample: ['Q3预算.xlsx'] }], truncated: false }
    const withSurvey = formatSynthesisPrompt([], null, survey)
    expect(withSurvey).toContain('文件侧')
    expect(withSurvey).toContain('Q3预算.xlsx')
    const without = formatSynthesisPrompt([], null, { folders: [], truncated: false })
    expect(without).not.toContain('文件侧(本机文件概览)')
  })

  it('synthesizeOverview synthesizes from a survey alone (no projects/life)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wcc-syn-survey-'))
    const fileRoot = mkdtempSync(join(tmpdir(), 'wcc-syn-files-'))
    mkdirSync(join(fileRoot, '工作'), { recursive: true })
    writeFileSync(join(fileRoot, '工作', 'Q3预算.xlsx'), 'x')
    let prompt = ''
    const res = await synthesizeOverview({
      stateDir: dir,
      adminChatId: 'admin@im.wechat',
      projectsRoot: join(dir, 'no-projects'),
      includeFileSurvey: true,
      surveyRoots: [fileRoot],
      sdkEval: async (p) => { prompt = p; return '整理结果' },
    })
    expect(res.foldersScanned).toBeGreaterThan(0)
    expect(prompt).toContain('Q3预算.xlsx')
    expect(res.overview).toBe('整理结果')
    rmSync(dir, { recursive: true, force: true }); rmSync(fileRoot, { recursive: true, force: true })
  })

  it('gatherFileSurvey includes dirs parsed from locations.md', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wcc-loc-'))
    const fileRoot = mkdtempSync(join(tmpdir(), 'wcc-loc-files-'))
    writeFileSync(join(fileRoot, '报告.docx'), 'x')
    mkdirSync(join(dir, 'memory', 'admin@im.wechat'), { recursive: true })
    writeFileSync(join(dir, 'memory', 'admin@im.wechat', 'locations.md'), `- 报告 → ${join(fileRoot, '报告.docx')}\n`)
    const survey = gatherFileSurvey({ stateDir: dir, adminChatId: 'admin@im.wechat' })
    // fileRoot (dirname of the mapped file) is surveyed → its file appears
    expect(survey.folders.some(f => f.sample.includes('报告.docx'))).toBe(true)
    rmSync(dir, { recursive: true, force: true }); rmSync(fileRoot, { recursive: true, force: true })
  })

  // Fix 1: paths with spaces in locations.md must not be truncated at the space
  it('gatherFileSurvey includes dirs when the mapped path contains a space', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wcc-loc-sp-'))
    const outerRoot = mkdtempSync(join(tmpdir(), 'wcc-loc-sp-files-'))
    const spacedDir = join(outerRoot, 'My Files')
    mkdirSync(spacedDir)
    writeFileSync(join(spacedDir, '报告.docx'), 'x')
    mkdirSync(join(dir, 'memory', 'admin@im.wechat'), { recursive: true })
    writeFileSync(
      join(dir, 'memory', 'admin@im.wechat', 'locations.md'),
      `- 工作报告 → ${join(spacedDir, '报告.docx')}\n`,
    )
    const survey = gatherFileSurvey({ stateDir: dir, adminChatId: 'admin@im.wechat' })
    // spacedDir (dirname of the file with a space in its path) must be surveyed
    expect(survey.folders.some(f => f.sample.includes('报告.docx'))).toBe(true)
    rmSync(dir, { recursive: true, force: true }); rmSync(outerRoot, { recursive: true, force: true })
  })

  // Fix 3: survey intro line is conditional on hasSurvey
  it('formatSynthesisPrompt uses survey-aware intro line (电脑里在忙的东西 only when survey present)', () => {
    const filledSurvey = { folders: [{ path: '/x', fileCount: 1, subdirs: [], sample: [] }], truncated: false }
    const withSurvey = formatSynthesisPrompt([], null, filledSurvey)
    expect(withSurvey).toContain('电脑里在忙的东西')

    const emptySurvey = { folders: [], truncated: false }
    const withoutSurvey = formatSynthesisPrompt([], null, emptySurvey)
    expect(withoutSurvey).not.toContain('电脑里在忙的东西')
    expect(withoutSurvey).toContain('工作和生活不要分开看')
  })
})
