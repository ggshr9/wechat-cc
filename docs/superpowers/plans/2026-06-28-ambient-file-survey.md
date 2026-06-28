# Ambient file survey in `_overview` synthesis — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fold a cheap, scripted directory-map survey of the admin's files into the existing `_overview` synthesis LLM pass so the distilled overview reflects what's on their computer — without reading file contents, adding an index, or growing per-turn context.

**Architecture:** A new pure lib module `file-survey.ts` does a bounded shallow directory walk (`surveyFiles`) and renders it (`formatFileSurvey`); it also becomes the new home of `defaultLifeDirs` (moved out of the daemon route so the lib synthesis can use it without a `lib→daemon` import). `memory-synthesis.ts` gains a `gatherFileSurvey` (roots = life dirs + dirs parsed from sub-project 1's `locations.md`) and folds the rendered survey into `formatSynthesisPrompt` as a third "文件侧" section of the single synthesis pass. The two production call sites opt in via `includeFileSurvey: true`.

**Tech Stack:** TypeScript, Node `node:fs`/`node:os`/`node:path`, Vitest (`bun --bun vitest run`).

**Spec:** `docs/superpowers/specs/2026-06-28-ambient-file-survey-design.md`

## Global Constraints

- **No file contents, no embeddings, no background index/timer.** The survey is a scripted directory map (folders, counts, filename samples) gathered only when synthesis already runs.
- **Raw map never enters per-turn context.** Only the distilled `_overview.md` is fed per turn (existing behavior); `buildMemorySnapshot` is untouched.
- **Layering:** `file-survey.ts` and `memory-synthesis.ts` live in `src/lib/` and must NOT import from `src/daemon/`. `daemon → lib` is allowed (the route imports `defaultLifeDirs` from lib).
- **`defaultLifeDirs` single source of truth:** moves to `src/lib/file-survey.ts`; `routes-files.ts` imports it from there. Value unchanged: `~/Desktop`, `~/Documents`, `~/Downloads` via `os.homedir()`.
- **Survey bounds (DEFAULT_SURVEY_LIMITS):** `maxDepth 3`, `maxFolders 200`, `samplePerFolder 8`, `totalBytes 12000`. Filename samples are most-recently-modified first. Skip set reused from `locate-files.ts`: `node_modules`, `.git`, `Library`, `.Trash`, `.cache`, and dotfiles/dotdirs.
- **Opt-in:** synthesis surveys only when `deps.includeFileSurvey === true` (so existing tests/callers are unaffected); production call sites set it true. `deps.surveyRoots?: string[]` overrides roots (for deterministic tests).
- **Best-effort:** every side (work/life/survey) is independently guarded; a missing dir / unreadable `locations.md` degrades that side to empty, never throws.
- **Test runner:** single file → `bun --bun vitest run <path>`. Typecheck → `npm run typecheck`. Commit after each task.

---

## File structure

- Create `src/lib/file-survey.ts` — `surveyFiles`, `formatFileSurvey`, `defaultLifeDirs` (moved), types, `DEFAULT_SURVEY_LIMITS`.
- Create `src/lib/file-survey.test.ts`.
- Modify `src/lib/locate-files.ts:51` — `export` the `SKIP_DIRS` set.
- Modify `src/daemon/internal-api/routes-files.ts` — remove local `defaultLifeDirs`, import it from `../../lib/file-survey`.
- Modify `src/daemon/internal-api/routes-files.test.ts` — import `defaultLifeDirs` from `../../lib/file-survey`.
- Modify `src/lib/memory-synthesis.ts` — `gatherFileSurvey` + `parseLocationRoots`, `formatSynthesisPrompt` survey param + 文件侧 block + header, `synthesizeOverview` wiring, `SynthesizeDeps`/`SynthesizeResult` fields.
- Modify `src/lib/memory-synthesis.test.ts` — survey-side tests.
- Modify `src/daemon/wiring/pipeline-deps.ts:148` and `src/daemon/wiring/tick-bodies.ts:236` — add `includeFileSurvey: true`.

---

### Task 1: `file-survey.ts` lib + relocate `defaultLifeDirs`

**Files:**
- Create: `src/lib/file-survey.ts`
- Test: `src/lib/file-survey.test.ts`
- Modify: `src/lib/locate-files.ts:51` (export SKIP_DIRS)
- Modify: `src/daemon/internal-api/routes-files.ts` (import defaultLifeDirs from lib)
- Modify: `src/daemon/internal-api/routes-files.test.ts` (import path)

**Interfaces:**
- Consumes: `SKIP_DIRS` from `./locate-files` (after exporting it).
- Produces:
  - `function defaultLifeDirs(home?: string): string[]`
  - `interface FolderSummary { path: string; fileCount: number; subdirs: string[]; sample: string[] }`
  - `interface SurveyLimits { maxDepth; maxFolders; samplePerFolder; totalBytes }` (all `number`)
  - `const DEFAULT_SURVEY_LIMITS: SurveyLimits`
  - `interface SurveyResult { folders: FolderSummary[]; truncated: boolean }`
  - `function surveyFiles(opts: { roots: string[]; limits?: Partial<SurveyLimits> }): SurveyResult`
  - `function formatFileSurvey(survey: SurveyResult, totalBytes?: number, home?: string): string`

- [ ] **Step 1: Write the failing test**

```typescript
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
    expect(top.fileCount).toBe(1) // 合同.pdf only
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun --bun vitest run src/lib/file-survey.test.ts`
Expected: FAIL — cannot resolve `./file-survey`.

- [ ] **Step 3: Export SKIP_DIRS from locate-files**

In `src/lib/locate-files.ts:51`, add `export`:

```typescript
export const SKIP_DIRS = new Set(['node_modules', '.git', 'Library', '.Trash', '.cache'])
```

- [ ] **Step 4: Create `file-survey.ts`**

```typescript
// src/lib/file-survey.ts
/**
 * file-survey — a cheap, scripted shallow directory map of the admin's files,
 * for the _overview synthesis (NOT a file search — that's locate-files.ts). Pure
 * (no daemon/cli imports). Returns folder structure + filename samples only;
 * never file contents. Also the single home of `defaultLifeDirs` so the lib
 * synthesis can use it without importing from src/daemon.
 */
import { readdirSync, statSync, type Dirent } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { SKIP_DIRS } from './locate-files'

/** The zero-config default survey/search roots. Single source of truth. */
export function defaultLifeDirs(home: string = homedir()): string[] {
  return [join(home, 'Desktop'), join(home, 'Documents'), join(home, 'Downloads')]
}

export interface FolderSummary {
  path: string        // absolute folder path
  fileCount: number   // files directly in this folder
  subdirs: string[]   // immediate child directory names (sorted, skip-filtered)
  sample: string[]    // up to samplePerFolder filenames, most-recent first
}

export interface SurveyLimits {
  maxDepth: number
  maxFolders: number
  samplePerFolder: number
  totalBytes: number
}

export const DEFAULT_SURVEY_LIMITS: SurveyLimits = {
  maxDepth: 3,
  maxFolders: 200,
  samplePerFolder: 8,
  totalBytes: 12_000,
}

export interface SurveyResult {
  folders: FolderSummary[]
  truncated: boolean
}

/** Bounded BFS shallow walk of `roots` → a directory map. */
export function surveyFiles(opts: { roots: string[]; limits?: Partial<SurveyLimits> }): SurveyResult {
  const limits = { ...DEFAULT_SURVEY_LIMITS, ...(opts.limits ?? {}) }
  const roots = [...new Set(opts.roots)]
  const folders: FolderSummary[] = []
  let truncated = false

  outer: for (const root of roots) {
    const queue: Array<[string, number]> = [[root, 0]]   // BFS: shallow folders first
    while (queue.length) {
      if (folders.length >= limits.maxFolders) { truncated = true; break outer }
      const [dir, depth] = queue.shift()!
      let entries: Dirent[]
      try { entries = readdirSync(dir, { withFileTypes: true }) } catch { continue }
      const files: Array<{ name: string; mtimeMs: number }> = []
      const subdirs: string[] = []
      for (const e of entries) {
        if (e.name.startsWith('.')) continue
        if (e.isDirectory()) {
          if (SKIP_DIRS.has(e.name)) continue
          subdirs.push(e.name)
          if (depth + 1 <= limits.maxDepth) queue.push([join(dir, e.name), depth + 1])
        } else if (e.isFile()) {
          let mtimeMs = 0
          try { mtimeMs = statSync(join(dir, e.name)).mtimeMs } catch { /* unstatable */ }
          files.push({ name: e.name, mtimeMs })
        }
      }
      files.sort((a, b) => b.mtimeMs - a.mtimeMs)
      folders.push({
        path: dir,
        fileCount: files.length,
        subdirs: subdirs.sort(),
        sample: files.slice(0, limits.samplePerFolder).map(f => f.name),
      })
    }
  }
  return { folders, truncated }
}

/** Render a survey to compact markdown, home-shortened and byte-capped. */
export function formatFileSurvey(
  survey: SurveyResult,
  totalBytes: number = DEFAULT_SURVEY_LIMITS.totalBytes,
  home: string = homedir(),
): string {
  if (survey.folders.length === 0) return ''
  const lines = survey.folders.map(f => {
    const shown = f.path.startsWith(home) ? `~${f.path.slice(home.length)}` : f.path
    const sample = f.sample.length ? `: ${f.sample.join(', ')}` : ''
    return `- ${shown}/ (${f.fileCount} 个文件)${sample}`
  })
  let body = lines.join('\n')
  if (survey.truncated) body += '\n…(截断)'
  if (body.length > totalBytes) body = `${body.slice(0, totalBytes)}\n…(截断)`
  return body
}
```

- [ ] **Step 5: Relocate `defaultLifeDirs` consumers**

In `src/daemon/internal-api/routes-files.ts`: delete the local `defaultLifeDirs` function (lines ~13-15) and its now-unused `homedir`/`join` imports if they become unused, and add the import:

```typescript
import { defaultLifeDirs } from '../../lib/file-survey'
```

(Keep `locateFiles` import and the handler unchanged — it still calls `defaultLifeDirs()`.)

In `src/daemon/internal-api/routes-files.test.ts`, change the import line so `defaultLifeDirs` comes from the lib module:

```typescript
import { fileRoutes } from './routes-files'
import { defaultLifeDirs } from '../../lib/file-survey'
```

- [ ] **Step 6: Run tests + typecheck**

Run: `bun --bun vitest run src/lib/file-survey.test.ts src/daemon/internal-api/routes-files.test.ts src/lib/locate-files.test.ts && npm run typecheck`
Expected: PASS (new survey tests; route test still green with the moved import; locate-files unaffected by the export), tsc clean.

- [ ] **Step 7: Full suite + commit**

Run: `bun --bun vitest run`
Expected: full suite PASS (the `defaultLifeDirs` move is import-only).

```bash
git add src/lib/file-survey.ts src/lib/file-survey.test.ts src/lib/locate-files.ts src/daemon/internal-api/routes-files.ts src/daemon/internal-api/routes-files.test.ts
git commit -m "feat(survey): file-survey lib (surveyFiles/formatFileSurvey) + move defaultLifeDirs to lib

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Fold the survey into `synthesizeOverview`

**Files:**
- Modify: `src/lib/memory-synthesis.ts`
- Test: `src/lib/memory-synthesis.test.ts`
- Modify: `src/daemon/wiring/pipeline-deps.ts:148`, `src/daemon/wiring/tick-bodies.ts:236`

**Interfaces:**
- Consumes: `surveyFiles`, `formatFileSurvey`, `defaultLifeDirs`, `SurveyResult` from `./file-survey` (Task 1).
- Produces:
  - `function gatherFileSurvey(opts: { stateDir: string; adminChatId: string; roots?: string[] }): SurveyResult`
  - `formatSynthesisPrompt(projects, life?, survey?)` — third optional arg
  - `SynthesizeDeps` gains `includeFileSurvey?: boolean` and `surveyRoots?: string[]`
  - `SynthesizeResult` gains `foldersScanned: number`

- [ ] **Step 1: Write the failing tests** (append to `src/lib/memory-synthesis.test.ts`)

```typescript
import { mkdtempSync as mkdtmp, mkdirSync as mkdir2, writeFileSync as wf2, rmSync as rm2 } from 'node:fs'
import { tmpdir as tmp2 } from 'node:os'
import { gatherFileSurvey } from './memory-synthesis'

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
    const dir = mkdtmp(join(tmp2(), 'wcc-syn-survey-'))
    const fileRoot = mkdtmp(join(tmp2(), 'wcc-syn-files-'))
    mkdir2(join(fileRoot, '工作'), { recursive: true })
    wf2(join(fileRoot, '工作', 'Q3预算.xlsx'), 'x')
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
    rm2(dir, { recursive: true, force: true }); rm2(fileRoot, { recursive: true, force: true })
  })

  it('gatherFileSurvey includes dirs parsed from locations.md', () => {
    const dir = mkdtmp(join(tmp2(), 'wcc-loc-'))
    const fileRoot = mkdtmp(join(tmp2(), 'wcc-loc-files-'))
    wf2(join(fileRoot, '报告.docx'), 'x')
    mkdir2(join(dir, 'memory', 'admin@im.wechat'), { recursive: true })
    wf2(join(dir, 'memory', 'admin@im.wechat', 'locations.md'), `- 报告 → ${join(fileRoot, '报告.docx')}\n`)
    const survey = gatherFileSurvey({ stateDir: dir, adminChatId: 'admin@im.wechat' })
    // fileRoot (dirname of the mapped file) is surveyed → its file appears
    expect(survey.folders.some(f => f.sample.includes('报告.docx'))).toBe(true)
    rm2(dir, { recursive: true, force: true }); rm2(fileRoot, { recursive: true, force: true })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun --bun vitest run src/lib/memory-synthesis.test.ts`
Expected: FAIL — `gatherFileSurvey` not exported; `formatSynthesisPrompt` ignores a 3rd arg; `includeFileSurvey`/`surveyRoots`/`foldersScanned` unknown (tsc errors too).

- [ ] **Step 3: Add imports + `parseLocationRoots` + `gatherFileSurvey`**

In `src/lib/memory-synthesis.ts`, add `dirname` to the path import and the file-survey import near the top (after the existing `import { writeMemoryFile } from './memory'`):

```typescript
import { dirname, join } from 'node:path'   // extend the existing `import { join } from 'node:path'`
import { surveyFiles, formatFileSurvey, defaultLifeDirs, type SurveyResult } from './file-survey'
```

Add these two functions (place them just above `formatSynthesisPrompt`):

```typescript
/**
 * Parse absolute directories from the admin's locations.md (sub-project 1's
 * learned file locations). File-ish paths (basename has an extension) collapse
 * to their parent dir; dir paths are used as-is. Best-effort: missing file → [].
 */
function parseLocationRoots(stateDir: string, adminChatId: string): string[] {
  try {
    const text = readFileSync(join(stateDir, 'memory', adminChatId, 'locations.md'), 'utf8')
    const out = new Set<string>()
    for (const m of text.matchAll(/\/[^\s,)）]+/g)) {
      const raw = m[0]
      out.add(/\.[^/]+$/.test(raw) ? dirname(raw) : raw.replace(/\/+$/, ''))
    }
    return [...out]
  } catch { return [] }
}

/**
 * Gather the file-side survey for the overview. Roots default to the life dirs
 * plus locations.md dirs; callers (tests) may override via `roots`. Best-effort:
 * any failure → empty survey (mirrors gatherLifeContext).
 */
export function gatherFileSurvey(opts: { stateDir: string; adminChatId: string; roots?: string[] }): SurveyResult {
  try {
    const roots = opts.roots ?? [...defaultLifeDirs(), ...parseLocationRoots(opts.stateDir, opts.adminChatId)]
    return surveyFiles({ roots })
  } catch { return { folders: [], truncated: false } }
}
```

- [ ] **Step 4: Extend `formatSynthesisPrompt`**

Replace the signature + header array + final return. New signature and header (note: source list is now "三类", a new `C)` line, a new requirement 5 for the file side, and the old "简洁" requirement renumbered to 6):

```typescript
export function formatSynthesisPrompt(projects: ProjectMemory[], life?: LifeContext | null, survey?: SurveyResult | null): string {
  const hasLife = !lifeIsEmpty(life ?? null)
  const hasSurvey = !!survey && survey.folders.length > 0
  const header = [
    '你是这台电脑主人(下称「管理员」)的个人助理。下面是关于管理员的记忆,分三类:',
    'A) 工作侧 —— 他在本机各项目里积累的记忆/笔记;',
    hasLife
      ? 'B) 生活侧 —— 你(bot)在微信里观察到的他这个人、在意的人和事、偏好、近况。'
      : '(本次没有生活侧数据。)',
    hasSurvey
      ? 'C) 文件侧 —— 他电脑常用目录里的文件夹结构与文件名概览(只有结构,没有内容)。'
      : '(本次没有文件侧数据。)',
    '请综合成一份「总体记忆」——让你整体「懂这个人」的精炼画像。工作、生活、电脑里在忙的东西不要分开看,他是一个完整的人。',
    '',
    '要求:',
    '1. 用中文输出一份 markdown,直接作为记忆内容,不要寒暄、不要解释你在做什么。',
    '2. 开头「整体理解」:这个人是谁、在做什么、在意什么、偏好 —— 工作和生活揉在一起写。',
    '3. 一节「## 项目地图」,每个工作项目一行: `- 项目名 — 一句话概述`(项目名用易读的名字)。',
    hasLife ? '4. 一节「## 生活与关系」:他在意的人/事、近况、性格偏好(只写生活侧有依据的)。' : '4. (无生活侧,跳过生活与关系一节。)',
    hasSurvey ? '5. 把文件侧也算进「他在做什么」——从文件夹和文件名推断他最近在忙什么,提炼信号,别逐个罗列文件。' : '5. (无文件侧,忽略。)',
    '6. 简洁,总长 ~600 字内。只写有依据的,别编造。',
    '',
    `工作侧:共 ${projects.length} 个项目`,
    '',
  ].join('\n')
```

Then, at the end of the function, add the survey block before the return and include it in the returned string. Replace:

```typescript
  return `${header}${blocks.join('\n')}${lifeBlock}\n`
```

with:

```typescript
  let surveyBlock = ''
  if (hasSurvey && survey) {
    const rendered = formatFileSurvey(survey)
    if (rendered) surveyBlock = truncate(`\n\n========== 文件侧(本机文件概览) ==========\n${rendered}`, TOTAL_CAP)
  }

  return `${header}${blocks.join('\n')}${lifeBlock}${surveyBlock}\n`
```

- [ ] **Step 5: Wire into `synthesizeOverview` + types**

In `SynthesizeDeps`, add:

```typescript
  /** When true, gather + fold the file-side survey into the overview. */
  includeFileSurvey?: boolean
  /** Override survey roots (tests). Defaults to life dirs + locations.md dirs. */
  surveyRoots?: string[]
```

In `SynthesizeResult`, add:

```typescript
  /** Folders included in the file-side survey (0 when not surveyed). */
  foldersScanned: number
```

In `synthesizeOverview`, after the `const life = ...` line, add the survey gather and thread it through prompt + base + guard:

```typescript
  const survey = deps.includeFileSurvey
    ? gatherFileSurvey({ stateDir: deps.stateDir, adminChatId: deps.adminChatId, roots: deps.surveyRoots })
    : null
  const prompt = formatSynthesisPrompt(projects, life, survey)
```

(Replace the existing `const prompt = formatSynthesisPrompt(projects, life)` line.)

Add `foldersScanned` to the `base` object:

```typescript
    foldersScanned: survey?.folders.length ?? 0,
```

Extend the skip guard to also require the survey empty:

```typescript
  if (deps.dryRun || (projects.length === 0 && lifeIsEmpty(life) && (!survey || survey.folders.length === 0))) return base
```

- [ ] **Step 6: Run synthesis tests + typecheck**

Run: `bun --bun vitest run src/lib/memory-synthesis.test.ts && npm run typecheck`
Expected: PASS — new survey tests pass; existing `synthesizeOverview` tests unaffected (they don't set `includeFileSurvey`, so `survey` is null and the prompt is byte-identical to before). tsc clean.

- [ ] **Step 7: Enable in production call sites**

In `src/daemon/wiring/pipeline-deps.ts:148`, add `includeFileSurvey: true` to the `synthesizeOverview({ ... })` call:

```typescript
      return synthesizeOverview({ stateDir, adminChatId, sdkEval: (p) => cheapEval(p), lifeStores: makeLifeStoresReader(db, stateDir), includeFileSurvey: true })
```

In `src/daemon/wiring/tick-bodies.ts:236`, add `includeFileSurvey: true` to its `synthesizeOverview({ ... })` call:

```typescript
        await synthesizeOverview({ stateDir: deps.stateDir, adminChatId: chatId, sdkEval, lifeStores: makeLifeStoresReader(deps.db, deps.stateDir), includeFileSurvey: true })
```

- [ ] **Step 8: Full suite + commit**

Run: `bun --bun vitest run && npm run typecheck`
Expected: full suite PASS, tsc clean.

```bash
git add src/lib/memory-synthesis.ts src/lib/memory-synthesis.test.ts src/daemon/wiring/pipeline-deps.ts src/daemon/wiring/tick-bodies.ts
git commit -m "feat(synthesis): fold file survey into _overview (third signal, opt-in)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-review

**Spec coverage:**
- Scripted gather, zero-token → Task 1 `surveyFiles` (no LLM). ✓
- Understanding via the existing single synthesis pass → Task 2 folds into `formatSynthesisPrompt`/`synthesizeOverview` (no new LLM call). ✓
- Raw map never per-turn → no change to `buildMemorySnapshot`; survey only in the synthesis prompt. ✓
- Shallow directory map, recency samples, byte-capped → Task 1 `surveyFiles`/`formatFileSurvey` + `DEFAULT_SURVEY_LIMITS`. ✓
- Roots = life dirs + locations.md dirs; synthesis is admin-side so reads locations.md → Task 2 `gatherFileSurvey`/`parseLocationRoots`. ✓
- Layering fix: `defaultLifeDirs` moved to lib, route imports it → Task 1 Step 5. ✓
- Best-effort per side; all-three-empty skips → Task 2 guard + try/caught gather. ✓
- No background timer/index/contents/embeddings; admin-only → nothing adds them; survey runs only inside synthesis, opt-in. ✓
- Production enablement → Task 2 Step 7 (both call sites). ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code; every run step shows command + expected output. ✓

**Type consistency:** `FolderSummary`/`SurveyLimits`/`DEFAULT_SURVEY_LIMITS`/`SurveyResult`/`surveyFiles`/`formatFileSurvey`/`defaultLifeDirs` used identically across tasks; `gatherFileSurvey`/`parseLocationRoots` and the `formatSynthesisPrompt(projects, life?, survey?)` shape, `includeFileSurvey`/`surveyRoots`/`foldersScanned` consistent between Task 2's source and tests. `SKIP_DIRS` exported in Task 1 and imported by `file-survey.ts`. ✓
