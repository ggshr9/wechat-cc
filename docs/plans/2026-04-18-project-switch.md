# Multi-Project Switch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a WeChat user switch the active project their Claude Code session operates in via natural-language or `/project` commands, with lazy handoff pointers carrying context across switches.

**Architecture:** Extend the existing `.restart-flag` supervisor loop with a `cwd=` field. Add a `projects.json` registry (alias → path, plus a `current` pointer). Install the wechat-cc MCP server at user scope (`~/.claude.json`) so every project auto-inherits it. On switch: write a single `_handoff.md` pointer file into the target project's `memory/` dir (no eager context copy), update registry, write restart-flag, let supervisor `process.chdir()` and respawn claude. Natural language parsing lives in Claude (LLM) — server exposes only atomic `list_projects` / `switch_project` MCP tools.

**Tech Stack:** Bun 1.x, TypeScript (strict), vitest-compatible `bun test`, `@modelcontextprotocol/sdk`. All existing code in `/home/nategu/.claude/plugins/local/wechat/` on the `master` branch of `https://github.com/ggshr9/wechat-cc.git`.

**Pre-requisites for the implementer:**
- Spec: `docs/specs/2026-04-18-project-switch-design.md` (read it before starting — defines invariants like "last_active bumped on enter, not on exit")
- Baseline test count: 60 passing (as of commit `6c058b5`). Every task must keep all prior tests green + add its own.
- Work on branch `feature/project-switch` branching from `master`. Merge (squash or merge commit per maintainer preference) when all tasks complete + E2E smoke passes.
- Run tests with `bun test` (not `npm test`) from the repo root.

---

## File Structure

| File | Responsibility | Size target |
|---|---|---|
| `project-registry.ts` (NEW) | `projects.json` CRUD; alias + path validation; `setCurrent` with `last_active` semantics | ~100 LOC |
| `project-registry.test.ts` (NEW) | Unit tests for above | ~130 LOC |
| `handoff.ts` (NEW) | `_handoff.md` atomic write; MEMORY.md idempotent index; auto-`mkdir` memory/ | ~70 LOC |
| `handoff.test.ts` (NEW) | Unit tests for above | ~100 LOC |
| `install-user-mcp.ts` (NEW) | Merge wechat entry into `~/.claude.json.mcpServers` | ~60 LOC |
| `install-user-mcp.test.ts` (NEW) | Unit tests | ~80 LOC |
| `config.ts` (MODIFY) | Add `PROJECTS_FILE` constant | +2 LOC |
| `cli.ts` (MODIFY) | Parse `cwd=` in `.restart-flag`; `process.chdir()` before spawn; `install --user` flag | +35 LOC |
| `server.ts` (MODIFY) | New MCP tools `list_projects`, `switch_project`; `/project` command dispatcher; orchestrate switch flow | +150 LOC |
| `setup.ts` (MODIFY) | Post-QR soft suggestion for `wechat-cc install --user` | +8 LOC |
| `README.md` (MODIFY) | Multi-project section | +80 lines markdown |

---

## Task 0: Create feature branch

**Files:** (git only)

- [ ] **Step 1: Create branch from master**

```bash
cd /home/nategu/.claude/plugins/local/wechat
git checkout master
git pull origin master
git checkout -b feature/project-switch
```

- [ ] **Step 2: Verify baseline is green**

```bash
bun test 2>&1 | tail -5
```
Expected: `60 pass / 0 fail` (or greater).

---

## Task 1: Add PROJECTS_FILE constant to config.ts

**Files:**
- Modify: `/home/nategu/.claude/plugins/local/wechat/config.ts`

- [ ] **Step 1: Edit config.ts to add the constant**

Append after `MAX_TEXT_CHUNK` at end of file:

```ts
/** Project registry — alias → path mapping + current active project. */
export const PROJECTS_FILE = join(STATE_DIR, 'projects.json')
```

Full `config.ts` after edit should have `PROJECTS_FILE` exported alongside `STATE_DIR`, `MAX_TEXT_CHUNK`, etc.

- [ ] **Step 2: Verify the constant compiles (no test yet — no consumers)**

```bash
bun run -e "import { PROJECTS_FILE } from './config.ts'; console.log(PROJECTS_FILE)"
```
Expected: prints `/home/nategu/.claude/channels/wechat/projects.json`

- [ ] **Step 3: Commit**

```bash
git add config.ts
git commit -m "feat(config): add PROJECTS_FILE constant for multi-project registry"
```

---

## Task 2: project-registry.ts — types + addProject with validation

**Files:**
- Create: `/home/nategu/.claude/plugins/local/wechat/project-registry.ts`
- Create: `/home/nategu/.claude/plugins/local/wechat/project-registry.test.ts`

- [ ] **Step 1: Write failing tests**

Create `project-registry.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests — expect FAIL (module doesn't exist yet)**

```bash
bun test project-registry 2>&1 | tail -10
```
Expected: compile error, "Cannot find module './project-registry'".

- [ ] **Step 3: Implement project-registry.ts — just enough for Step 1 tests to pass**

Create `project-registry.ts`:

```ts
/**
 * project-registry.ts — manages ~/.claude/channels/wechat/projects.json.
 *
 * Single source of truth for alias → path routing. All writes are atomic
 * (tmp + rename). Tested via fixture files — callers pass the registry
 * path so tests can use tmpdir.
 */
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'fs'
import { isAbsolute } from 'path'

export const ALIAS_REGEX = /^[a-z0-9][a-z0-9_-]{1,19}$/

export interface ProjectEntry {
  path: string
  last_active: string  // ISO 8601
}

export interface ProjectRegistry {
  projects: Record<string, ProjectEntry>
  current: string | null
}

function emptyRegistry(): ProjectRegistry {
  return { projects: {}, current: null }
}

function loadRegistry(file: string): ProjectRegistry {
  if (!existsSync(file)) return emptyRegistry()
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<ProjectRegistry>
    return {
      projects: parsed.projects ?? {},
      current: parsed.current ?? null,
    }
  } catch {
    return emptyRegistry()
  }
}

function saveRegistry(file: string, reg: ProjectRegistry): void {
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(reg, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, file)
}

export function addProject(file: string, alias: string, path: string): void {
  if (!ALIAS_REGEX.test(alias)) {
    throw new Error(`invalid alias '${alias}': must match ${ALIAS_REGEX}`)
  }
  if (!isAbsolute(path)) {
    throw new Error(`path must be absolute, got: ${path}`)
  }
  let stat
  try { stat = statSync(path) } catch { throw new Error(`path is not a directory: ${path}`) }
  if (!stat.isDirectory()) throw new Error(`path is not a directory: ${path}`)

  const reg = loadRegistry(file)
  if (reg.projects[alias]) {
    throw new Error(`alias '${alias}' already registered (${reg.projects[alias].path})`)
  }
  reg.projects[alias] = { path, last_active: new Date().toISOString() }
  saveRegistry(file, reg)
}
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
bun test project-registry 2>&1 | tail -5
```
Expected: all tests in `describe('addProject')` and `describe('ALIAS_REGEX')` pass.

- [ ] **Step 5: Commit**

```bash
git add project-registry.ts project-registry.test.ts
git commit -m "feat(registry): alias validation + addProject with path checks"
```

---

## Task 3: project-registry.ts — listProjects + setCurrent

**Files:**
- Modify: `/home/nategu/.claude/plugins/local/wechat/project-registry.ts`
- Modify: `/home/nategu/.claude/plugins/local/wechat/project-registry.test.ts`

- [ ] **Step 1: Append failing tests**

Append inside `project-registry.test.ts` (after the existing `describe` blocks):

```ts
import { listProjects, setCurrent } from './project-registry'

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
```

- [ ] **Step 2: Run tests — expect FAIL (functions don't exist)**

```bash
bun test project-registry 2>&1 | tail -10
```
Expected: errors for missing exports `listProjects`, `setCurrent`.

- [ ] **Step 3: Add implementations to project-registry.ts**

Append to `project-registry.ts`:

```ts
export interface ProjectView {
  alias: string
  path: string
  last_active: string
  is_current: boolean
}

export function listProjects(file: string): ProjectView[] {
  const reg = loadRegistry(file)
  const out: ProjectView[] = []
  for (const [alias, entry] of Object.entries(reg.projects)) {
    out.push({
      alias,
      path: entry.path,
      last_active: entry.last_active,
      is_current: reg.current === alias,
    })
  }
  out.sort((a, b) => b.last_active.localeCompare(a.last_active))
  return out
}

export function setCurrent(file: string, alias: string): void {
  const reg = loadRegistry(file)
  if (!reg.projects[alias]) {
    throw new Error(`alias '${alias}' is not registered`)
  }
  reg.current = alias
  reg.projects[alias]!.last_active = new Date().toISOString()
  saveRegistry(file, reg)
}
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
bun test project-registry 2>&1 | tail -5
```
Expected: all `listProjects` + `setCurrent` tests pass.

- [ ] **Step 5: Commit**

```bash
git add project-registry.ts project-registry.test.ts
git commit -m "feat(registry): listProjects + setCurrent with recency semantics"
```

---

## Task 4: project-registry.ts — removeProject + current-protect

**Files:**
- Modify: `/home/nategu/.claude/plugins/local/wechat/project-registry.ts`
- Modify: `/home/nategu/.claude/plugins/local/wechat/project-registry.test.ts`

- [ ] **Step 1: Append failing tests**

Append to `project-registry.test.ts`:

```ts
import { removeProject } from './project-registry'

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
```

- [ ] **Step 2: Run tests — expect FAIL (missing export)**

```bash
bun test project-registry 2>&1 | tail -5
```
Expected: errors for missing export `removeProject`.

- [ ] **Step 3: Add implementation**

Append to `project-registry.ts`:

```ts
export function removeProject(file: string, alias: string): void {
  const reg = loadRegistry(file)
  if (!reg.projects[alias]) {
    throw new Error(`alias '${alias}' is not registered`)
  }
  if (reg.current === alias) {
    throw new Error(`cannot remove current project '${alias}' — switch elsewhere first`)
  }
  delete reg.projects[alias]
  saveRegistry(file, reg)
}
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
bun test project-registry 2>&1 | tail -5
```
Expected: all tests pass; cumulative count up by 3 from previous task.

- [ ] **Step 5: Commit**

```bash
git add project-registry.ts project-registry.test.ts
git commit -m "feat(registry): removeProject with current-project protection"
```

---

## Task 5: project-registry.ts — resolveProject helper + corruption fallback

Callers need a single "give me this project or fail" lookup. Also verify that corrupted JSON doesn't crash the system.

**Files:**
- Modify: `/home/nategu/.claude/plugins/local/wechat/project-registry.ts`
- Modify: `/home/nategu/.claude/plugins/local/wechat/project-registry.test.ts`

- [ ] **Step 1: Append failing tests**

```ts
import { resolveProject } from './project-registry'

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
```

- [ ] **Step 2: Run tests — expect FAIL**

```bash
bun test project-registry 2>&1 | tail -5
```

- [ ] **Step 3: Add resolveProject export**

Append to `project-registry.ts`:

```ts
export function resolveProject(file: string, alias: string): ProjectEntry | null {
  const reg = loadRegistry(file)
  return reg.projects[alias] ?? null
}
```

The corruption tests should already pass because `loadRegistry` catches JSON.parse errors via try/catch (written in Task 2).

- [ ] **Step 4: Run tests — expect PASS**

```bash
bun test project-registry 2>&1 | tail -5
```
Expected: all 6 new tests pass; total registry tests ~14.

- [ ] **Step 5: Commit**

```bash
git add project-registry.ts project-registry.test.ts
git commit -m "feat(registry): resolveProject helper + corruption fallback coverage"
```

---

## Task 6: handoff.ts — writeHandoff atomic file creation

**Files:**
- Create: `/home/nategu/.claude/plugins/local/wechat/handoff.ts`
- Create: `/home/nategu/.claude/plugins/local/wechat/handoff.test.ts`

- [ ] **Step 1: Write failing tests**

Create `handoff.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { writeHandoff, type HandoffInput } from './handoff'

let tmpDir: string
let targetDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'wechat-cc-handoff-'))
  targetDir = join(tmpDir, 'target-project')
  mkdirSync(targetDir)
})

afterAll(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }) } catch {}
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
```

- [ ] **Step 2: Run tests — expect FAIL**

```bash
bun test handoff 2>&1 | tail -10
```
Expected: "Cannot find module './handoff'".

- [ ] **Step 3: Implement handoff.ts**

Create `handoff.ts`:

```ts
/**
 * handoff.ts — writes the cross-project handoff pointer.
 *
 * Single-file policy: exactly one `_handoff.md` per target project's
 * `memory/` dir. Overwrites on each switch. See the design spec for why
 * we don't accumulate history here.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'

export interface HandoffInput {
  targetDir: string       // absolute path to target project root
  sourceAlias: string
  sourcePath: string
  sourceJsonl: string     // absolute path to source session jsonl
  timestamp: string       // ISO 8601
  note: string | null
}

export const HANDOFF_FILENAME = '_handoff.md'

function renderHandoff(input: HandoffInput): string {
  const noteLine = input.note ?? '无'
  return `---
name: Cross-project handoff
description: Switched to current project at ${input.timestamp}; previous chat in source jsonl
type: reference
---

来源项目: ${input.sourceAlias} (${input.sourcePath})
切换时间: ${input.timestamp}
上段会话 jsonl: ${input.sourceJsonl}
用户备注: ${noteLine}

用户提到"刚才"/"之前"/"切过来之前"时，用 Read 工具读上面 jsonl 的尾部，
或 Grep 关键词按需检索。不主动引用。
`
}

function writeAtomic(file: string, content: string): void {
  const tmp = `${file}.tmp`
  writeFileSync(tmp, content, { mode: 0o600 })
  renameSync(tmp, file)
}

export function writeHandoff(input: HandoffInput): void {
  const memoryDir = join(input.targetDir, 'memory')
  if (!existsSync(memoryDir)) mkdirSync(memoryDir, { recursive: true })
  const handoffPath = join(memoryDir, HANDOFF_FILENAME)
  writeAtomic(handoffPath, renderHandoff(input))
}
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
bun test handoff 2>&1 | tail -5
```
Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add handoff.ts handoff.test.ts
git commit -m "feat(handoff): atomic single-file pointer writer with frontmatter"
```

---

## Task 7: handoff.ts — idempotent MEMORY.md index update

**Files:**
- Modify: `/home/nategu/.claude/plugins/local/wechat/handoff.ts`
- Modify: `/home/nategu/.claude/plugins/local/wechat/handoff.test.ts`

- [ ] **Step 1: Append failing tests**

```ts
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
```

- [ ] **Step 2: Run tests — expect FAIL**

```bash
bun test handoff 2>&1 | tail -10
```

- [ ] **Step 3: Extend handoff.ts with MEMORY.md updater**

Add to `handoff.ts` (modify imports to add `readFileSync` already present, and extend `writeHandoff`):

Replace the existing `writeHandoff` with:

```ts
function buildIndexLine(sourceAlias: string, timestamp: string): string {
  const date = timestamp.slice(0, 10)  // YYYY-MM-DD
  return `- [Cross-project handoff](${HANDOFF_FILENAME}) — 从 ${sourceAlias} 切过来 (${date})`
}

function updateMemoryIndex(memoryDir: string, sourceAlias: string, timestamp: string): void {
  const file = join(memoryDir, 'MEMORY.md')
  const newLine = buildIndexLine(sourceAlias, timestamp)
  if (!existsSync(file)) {
    writeAtomic(file, `# Memory\n\n${newLine}\n`)
    return
  }
  const existing = readFileSync(file, 'utf8')
  const lines = existing.split('\n')
  const idx = lines.findIndex(l => l.includes(`](${HANDOFF_FILENAME})`))
  if (idx >= 0) {
    lines[idx] = newLine
  } else {
    // Append as a new line at the end (before trailing newline)
    if (lines[lines.length - 1] === '') lines.splice(lines.length - 1, 0, newLine)
    else lines.push(newLine)
  }
  writeAtomic(file, lines.join('\n'))
}

export function writeHandoff(input: HandoffInput): void {
  const memoryDir = join(input.targetDir, 'memory')
  if (!existsSync(memoryDir)) mkdirSync(memoryDir, { recursive: true })
  const handoffPath = join(memoryDir, HANDOFF_FILENAME)
  writeAtomic(handoffPath, renderHandoff(input))
  updateMemoryIndex(memoryDir, input.sourceAlias, input.timestamp)
}
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
bun test handoff 2>&1 | tail -5
```
Expected: all 8 handoff tests pass (5 from Task 6 + 3 new).

- [ ] **Step 5: Commit**

```bash
git add handoff.ts handoff.test.ts
git commit -m "feat(handoff): idempotent MEMORY.md index line maintenance"
```

---

## Task 8: install-user-mcp.ts — merge wechat entry into ~/.claude.json

**Files:**
- Create: `/home/nategu/.claude/plugins/local/wechat/install-user-mcp.ts`
- Create: `/home/nategu/.claude/plugins/local/wechat/install-user-mcp.test.ts`

- [ ] **Step 1: Write failing tests**

Create `install-user-mcp.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { installUserMcp, type McpServerConfig } from './install-user-mcp'

let tmpDir: string
let configFile: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'wechat-cc-install-'))
  configFile = join(tmpDir, '.claude.json')
})

afterAll(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }) } catch {}
})

const wechatCfg: McpServerConfig = {
  command: '/home/u/.bun/bin/bun',
  args: ['run', '--cwd', '/home/u/.claude/plugins/local/wechat', '--silent', 'start'],
}

describe('installUserMcp', () => {
  it('creates ~/.claude.json when missing', () => {
    installUserMcp(configFile, 'wechat', wechatCfg)
    const raw = JSON.parse(readFileSync(configFile, 'utf8'))
    expect(raw.mcpServers.wechat).toEqual(wechatCfg)
  })

  it('adds wechat without touching other mcpServers', () => {
    writeFileSync(configFile, JSON.stringify({
      mcpServers: {
        other: { command: 'other-bin', args: [] },
      },
    }, null, 2))
    installUserMcp(configFile, 'wechat', wechatCfg)
    const raw = JSON.parse(readFileSync(configFile, 'utf8'))
    expect(raw.mcpServers.other).toEqual({ command: 'other-bin', args: [] })
    expect(raw.mcpServers.wechat).toEqual(wechatCfg)
  })

  it('replaces existing wechat entry', () => {
    writeFileSync(configFile, JSON.stringify({
      mcpServers: {
        wechat: { command: 'old-bin', args: ['old'] },
      },
    }))
    installUserMcp(configFile, 'wechat', wechatCfg)
    const raw = JSON.parse(readFileSync(configFile, 'utf8'))
    expect(raw.mcpServers.wechat).toEqual(wechatCfg)
  })

  it('preserves unrelated top-level keys', () => {
    writeFileSync(configFile, JSON.stringify({
      someOtherSetting: 'keep-me',
      mcpServers: {},
    }))
    installUserMcp(configFile, 'wechat', wechatCfg)
    const raw = JSON.parse(readFileSync(configFile, 'utf8'))
    expect(raw.someOtherSetting).toBe('keep-me')
    expect(raw.mcpServers.wechat).toEqual(wechatCfg)
  })

  it('is idempotent (running twice yields same file content)', () => {
    installUserMcp(configFile, 'wechat', wechatCfg)
    const first = readFileSync(configFile, 'utf8')
    installUserMcp(configFile, 'wechat', wechatCfg)
    const second = readFileSync(configFile, 'utf8')
    expect(first).toBe(second)
  })

  it('creates mcpServers object when top-level JSON has none', () => {
    writeFileSync(configFile, JSON.stringify({ other: 1 }))
    installUserMcp(configFile, 'wechat', wechatCfg)
    const raw = JSON.parse(readFileSync(configFile, 'utf8'))
    expect(raw.mcpServers.wechat).toEqual(wechatCfg)
    expect(raw.other).toBe(1)
  })
})
```

- [ ] **Step 2: Run tests — expect FAIL**

```bash
bun test install-user-mcp 2>&1 | tail -10
```

- [ ] **Step 3: Implement install-user-mcp.ts**

Create `install-user-mcp.ts`:

```ts
/**
 * install-user-mcp.ts — idempotently add wechat-cc to Claude Code's
 * user-scope MCP config (~/.claude.json).
 *
 * Installing at user scope (vs project scope .mcp.json) means the wechat
 * channel auto-attaches in every Claude Code session regardless of cwd,
 * which is required for the /project switch flow to work — the new
 * session needs the wechat MCP tool available immediately after chdir.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs'

export interface McpServerConfig {
  command: string
  args: string[]
  env?: Record<string, string>
}

interface ClaudeUserConfig {
  mcpServers?: Record<string, McpServerConfig>
  [key: string]: unknown
}

function readConfig(file: string): ClaudeUserConfig {
  if (!existsSync(file)) return {}
  try { return JSON.parse(readFileSync(file, 'utf8')) as ClaudeUserConfig }
  catch { return {} }
}

function writeConfig(file: string, cfg: ClaudeUserConfig): void {
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, file)
}

export function installUserMcp(file: string, name: string, entry: McpServerConfig): void {
  const cfg = readConfig(file)
  if (!cfg.mcpServers) cfg.mcpServers = {}
  cfg.mcpServers[name] = entry
  writeConfig(file, cfg)
}
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
bun test install-user-mcp 2>&1 | tail -5
```
Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add install-user-mcp.ts install-user-mcp.test.ts
git commit -m "feat(install): user-scope MCP config merger"
```

---

## Task 9: cli.ts — add `install --user` flag

**Files:**
- Modify: `/home/nategu/.claude/plugins/local/wechat/cli.ts` (existing `install()` function)

- [ ] **Step 1: Inspect the existing install function**

```bash
grep -n "^function install\b" /home/nategu/.claude/plugins/local/wechat/cli.ts
```

Expected output: `function install()` defined around line 64.

- [ ] **Step 2: Replace the existing `install()` function**

Open `cli.ts` and replace the current `install()` function (from `function install() {` through its closing `}`) with:

```ts
function install() {
  const bun = getBunPath()
  const wechatEntry = {
    command: bun,
    args: ['run', '--cwd', PLUGIN_DIR, '--silent', 'start'],
  }

  const scope = process.argv[3] === '--user' || process.argv[3] === '--scope=user'
    ? 'user'
    : 'project'

  if (scope === 'user') {
    // Lazy import so tests that don't need it don't drag fs in
    import('./install-user-mcp.ts').then(({ installUserMcp }) => {
      const configFile = join(homedir(), '.claude.json')
      installUserMcp(configFile, 'wechat', wechatEntry)
      console.log(`已更新用户级 MCP 配置: ${configFile}`)
      console.log('\n下一步: wechat-cc run 或在任意项目中启动 claude')
    }).catch(err => {
      console.error('install --user 失败:', err)
      process.exit(1)
    })
    return
  }

  // Default: project-scope .mcp.json (legacy behavior, unchanged)
  const mcpConfig = {
    mcpServers: {
      wechat: wechatEntry,
    },
  }
  const mcpPath = resolve(process.cwd(), '.mcp.json')
  if (existsSync(mcpPath)) {
    try {
      const existing = JSON.parse(readFileSync(mcpPath, 'utf-8'))
      existing.mcpServers = existing.mcpServers || {}
      existing.mcpServers.wechat = mcpConfig.mcpServers.wechat
      writeFileSync(mcpPath, JSON.stringify(existing, null, 2) + '\n', 'utf-8')
      console.log(`已更新: ${mcpPath}`)
    } catch {
      writeFileSync(mcpPath, JSON.stringify(mcpConfig, null, 2) + '\n', 'utf-8')
      console.log(`已创建: ${mcpPath}`)
    }
  } else {
    writeFileSync(mcpPath, JSON.stringify(mcpConfig, null, 2) + '\n', 'utf-8')
    console.log(`已创建: ${mcpPath}`)
  }
  console.log('\n下一步: wechat-cc run')
  console.log('\n提示: 想让 wechat 在所有项目中自动可用？试试 wechat-cc install --user')
}
```

- [ ] **Step 3: Also update the `help()` function**

Find the `help()` function in `cli.ts` and extend the install line from:
```
    install              在当前目录生成 .mcp.json
```
to:
```
    install              在当前目录生成 .mcp.json（项目级）
    install --user       注册到 ~/.claude.json（用户级，所有项目可用）
```

- [ ] **Step 4: Smoke test both modes**

```bash
cd /tmp && rm -f .mcp.json
bun run /home/nategu/.claude/plugins/local/wechat/cli.ts install
cat .mcp.json
```
Expected: shows mcpServers.wechat entry.

```bash
cp ~/.claude.json ~/.claude.json.bak-$(date +%s)  # backup before testing
bun run /home/nategu/.claude/plugins/local/wechat/cli.ts install --user
jq '.mcpServers.wechat' ~/.claude.json
```
Expected: shows the wechat entry with bun path + args.

- [ ] **Step 5: Run full test suite**

```bash
cd /home/nategu/.claude/plugins/local/wechat && bun test 2>&1 | tail -5
```
Expected: all tests green (60 baseline + new tests from Tasks 2-8).

- [ ] **Step 6: Commit**

```bash
git add cli.ts
git commit -m "feat(cli): install --user flag for user-scope MCP registration"
```

---

## Task 10: cli.ts — parse cwd= prefix in .restart-flag + chdir on respawn

**Files:**
- Modify: `/home/nategu/.claude/plugins/local/wechat/cli.ts` (existing `readRestartFlag` + `run` loop)

- [ ] **Step 1: Inspect current restart-flag handling**

```bash
grep -n "readRestartFlag\|RESTART_FLAG_PATH\|RestartFlag" /home/nategu/.claude/plugins/local/wechat/cli.ts
```

Note the current shape: `readRestartFlag` returns `{args: string[]}`. We'll extend to `{args, cwd}`.

- [ ] **Step 2: Update the RestartFlag type and parser**

Replace the existing `interface RestartFlag` and `readRestartFlag` function with:

```ts
interface RestartFlag {
  args: string[]   // empty = inherit current flags
  cwd: string | null  // non-null = chdir before respawn
}

// Atomically read + delete the flag file. Returns null if no restart requested.
// File format:
//   Line 1 may be "cwd=<absolute path>" (optional)
//   Rest is whitespace-separated claude flags (legacy format — single line also works)
function readRestartFlag(): RestartFlag | null {
  if (!existsSync(RESTART_FLAG_PATH)) return null
  let content = ''
  try { content = readFileSync(RESTART_FLAG_PATH, 'utf8').trim() } catch {}
  try { rmSync(RESTART_FLAG_PATH) } catch {}

  let cwd: string | null = null
  let argsText = content
  const lines = content.split('\n').map(l => l.trim())
  if (lines[0]?.startsWith('cwd=')) {
    const maybeCwd = lines[0].slice(4).trim()
    if (maybeCwd) cwd = maybeCwd
    argsText = lines.slice(1).join(' ').trim()
  }
  const args = argsText ? argsText.split(/\s+/) : []
  return { args, cwd }
}
```

- [ ] **Step 3: Update the main `run()` loop to call chdir on respawn**

Find the section in `run()` that reads the flag and respawns. Around:
```ts
    if (flag.args.length > 0) {
      currentFlags = parseRunArgs(flag.args)
    }
```

Replace with:

```ts
    if (flag.args.length > 0) {
      currentFlags = parseRunArgs(flag.args)
    }
    if (flag.cwd) {
      try {
        process.chdir(flag.cwd)
        console.error(`[wechat-cc] chdir → ${flag.cwd}`)
      } catch (err) {
        console.error(`[wechat-cc] chdir failed for ${flag.cwd}: ${err}. Staying in ${process.cwd()}`)
      }
    }
```

- [ ] **Step 4: Verify existing restart tests still pass**

```bash
cd /home/nategu/.claude/plugins/local/wechat && bun test cli 2>&1 | tail -10
```
Expected: existing cli.test.ts tests still pass (no regression).

- [ ] **Step 5: Smoke test — write a flag manually and verify parsing**

```bash
mkdir -p ~/.claude/channels/wechat
echo "cwd=/tmp" > ~/.claude/channels/wechat/.restart-flag
bun run -e "
const { readFileSync, rmSync, existsSync } = await import('fs')
const path = process.env.HOME + '/.claude/channels/wechat/.restart-flag'
const content = readFileSync(path, 'utf8').trim()
rmSync(path)
const lines = content.split('\n').map(l => l.trim())
const cwd = lines[0]?.startsWith('cwd=') ? lines[0].slice(4) : null
console.log('parsed cwd:', cwd)
"
```
Expected: `parsed cwd: /tmp`

- [ ] **Step 6: Commit**

```bash
git add cli.ts
git commit -m "feat(cli): parse cwd= prefix in .restart-flag and chdir on respawn"
```

---

## Task 11: server.ts — MCP tool `list_projects`

**Files:**
- Modify: `/home/nategu/.claude/plugins/local/wechat/server.ts`

- [ ] **Step 1: Import dependencies at top of server.ts**

Find the existing import block for `./config.ts` and add:

```ts
import { PROJECTS_FILE } from './config.ts'
import { listProjects, addProject, removeProject, resolveProject, setCurrent, type ProjectView } from './project-registry.ts'
import { writeHandoff } from './handoff.ts'
```

Note: `PROJECTS_FILE` is already added by Task 1; confirm it's in the import list.

- [ ] **Step 2: Register the `list_projects` MCP tool**

Find the `mcp.setRequestHandler(ListToolsRequestSchema, ...)` handler and add to the `tools` array:

```ts
{
  name: 'list_projects',
  description: 'List all registered projects with alias, absolute path, last_active timestamp, and is_current flag. Use this to match a user-provided alias against the registry (fuzzy/substring match) before calling switch_project.',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
},
```

- [ ] **Step 3: Handle the tool call**

In `mcp.setRequestHandler(CallToolRequestSchema, ...)`, add a case:

```ts
case 'list_projects': {
  const projects = listProjects(PROJECTS_FILE)
  return { content: [{ type: 'text', text: JSON.stringify(projects, null, 2) }] }
}
```

- [ ] **Step 4: Smoke test via a mock call**

```bash
# Set up a registry
mkdir -p ~/.claude/channels/wechat
cat > ~/.claude/channels/wechat/projects.json <<'EOF'
{
  "projects": {
    "test-alpha": { "path": "/tmp", "last_active": "2026-04-18T10:00:00.000Z" }
  },
  "current": "test-alpha"
}
EOF

# Run the module directly to verify the listProjects function resolves
cd /home/nategu/.claude/plugins/local/wechat
bun run -e "import {listProjects} from './project-registry.ts'; import {PROJECTS_FILE} from './config.ts'; console.log(listProjects(PROJECTS_FILE))"
```
Expected: array containing test-alpha with is_current=true.

- [ ] **Step 5: Cleanup test fixture**

```bash
rm ~/.claude/channels/wechat/projects.json
```

- [ ] **Step 6: Commit**

```bash
git add server.ts
git commit -m "feat(server): MCP tool list_projects"
```

---

## Task 12: server.ts — MCP tool `switch_project` (core orchestration)

**Files:**
- Modify: `/home/nategu/.claude/plugins/local/wechat/server.ts`

- [ ] **Step 1: Locate the Claude Code session jsonl path for the current cwd**

We need to know the source jsonl path so the handoff file can point to it. Claude Code stores per-project session files under `~/.claude/projects/<encoded-cwd>/`. The encoding replaces `/` with `-` and drops leading dash.

Add a helper function near the top of server.ts (after existing helpers, before `mcp.setRequestHandler`):

```ts
/**
 * Resolve the path to the current Claude Code session's .jsonl file, or
 * null if we can't determine it. Uses the encoded cwd convention.
 */
function currentSessionJsonl(): string | null {
  const home = process.env.HOME ?? homedir()
  const encoded = process.cwd().replace(/\//g, '-')
  const projectDir = join(home, '.claude', 'projects', encoded)
  if (!existsSync(projectDir)) return null
  // Session files are <uuid>.jsonl — pick the most recently modified
  try {
    const files = readdirSync(projectDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => ({ f, mtime: statSync(join(projectDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
    return files.length > 0 ? join(projectDir, files[0]!.f) : null
  } catch { return null }
}
```

Ensure `readdirSync`, `statSync`, `homedir` imports exist at top of file; if not, add.

- [ ] **Step 2: Register the `switch_project` MCP tool**

In the tools list:

```ts
{
  name: 'switch_project',
  description: 'Switch the active project. Triggers a restart of the Claude Code session in the target project\'s cwd. Writes a handoff pointer to <target>/memory/_handoff.md so the next session can look up prior context on demand. The switch is async — returns after writing the restart flag; actual respawn takes 5-10 seconds. Admin-only.',
  inputSchema: {
    type: 'object',
    properties: {
      alias: {
        type: 'string',
        description: 'Target project alias (must be registered via /project add first)',
      },
      note: {
        type: 'string',
        description: 'Optional short note from the user about what they are about to work on in the target project. Appears in the handoff file.',
      },
    },
    required: ['alias'],
  },
},
```

- [ ] **Step 3: Implement the switch_project handler**

In the CallTool handler, add:

```ts
case 'switch_project': {
  const alias = args.alias as string
  const note = (args.note as string | undefined) ?? null

  // Resolve target
  const entry = resolveProject(PROJECTS_FILE, alias)
  if (!entry) {
    const known = listProjects(PROJECTS_FILE).map(p => p.alias).join(', ') || '(none)'
    return { content: [{ type: 'text', text: `switch_project failed: alias '${alias}' not registered. Known: ${known}` }], isError: true }
  }

  // Validate target path still exists
  try {
    const st = statSync(entry.path)
    if (!st.isDirectory()) throw new Error('not a directory')
  } catch {
    return { content: [{ type: 'text', text: `switch_project failed: target path does not exist or is not a directory: ${entry.path}` }], isError: true }
  }

  // Find source info for handoff
  const reg = listProjects(PROJECTS_FILE)
  const currentEntry = reg.find(p => p.is_current)
  const sourceAlias = currentEntry?.alias ?? 'unknown'
  const sourcePath = currentEntry?.path ?? process.cwd()
  const sourceJsonl = currentSessionJsonl() ?? '(session jsonl not found)'

  // Write handoff (best-effort — non-fatal on failure)
  try {
    writeHandoff({
      targetDir: entry.path,
      sourceAlias,
      sourcePath,
      sourceJsonl,
      timestamp: new Date().toISOString(),
      note,
    })
  } catch (err) {
    log('HANDOFF_FAIL', `writeHandoff for ${alias}: ${err instanceof Error ? err.message : String(err)}`)
    // Continue — handoff is nice-to-have, not required
  }

  // Update registry current
  try {
    setCurrent(PROJECTS_FILE, alias)
  } catch (err) {
    return { content: [{ type: 'text', text: `switch_project failed at setCurrent: ${err instanceof Error ? err.message : String(err)}` }], isError: true }
  }

  // Write restart flag with cwd= prefix
  try {
    const flagPath = join(STATE_DIR, '.restart-flag')
    writeFileSync(flagPath, `cwd=${entry.path}\n`, { mode: 0o600 })
  } catch (err) {
    return { content: [{ type: 'text', text: `switch_project failed writing restart flag: ${err instanceof Error ? err.message : String(err)}` }], isError: true }
  }

  log('PROJECT_SWITCH', `${sourceAlias} → ${alias} (${entry.path})`)
  return { content: [{ type: 'text', text: `switch to ${alias} initiated — session will restart in ~10s` }] }
}
```

Ensure `writeFileSync` is imported at the top of server.ts (already likely is from earlier work).

- [ ] **Step 4: Run full test suite to verify no regression**

```bash
cd /home/nategu/.claude/plugins/local/wechat && bun test 2>&1 | tail -5
```
Expected: all tests green.

- [ ] **Step 5: Commit**

```bash
git add server.ts
git commit -m "feat(server): MCP tool switch_project with handoff + restart flag"
```

---

## Task 13: server.ts — `/project` command dispatcher

**Files:**
- Modify: `/home/nategu/.claude/plugins/local/wechat/server.ts`

The server.ts already has handling for WeChat commands like `/help`, `/restart`, `/users`. We'll add a `/project` sub-dispatcher that routes to add/list/switch/status/remove.

- [ ] **Step 1: Locate the existing command dispatch**

```bash
grep -n "case '/restart'\|case '/help'\|case '/status'" /home/nategu/.claude/plugins/local/wechat/server.ts
```

Note the location of the command handling block (likely a switch or sequential `if` chain inside the inbound message handler).

- [ ] **Step 2: Add a `/project` command parser**

Add a helper function near other helpers (e.g., near where `/restart` is handled):

```ts
/**
 * Parse and dispatch /project subcommands. Returns a WeChat reply string
 * or null if this isn't a /project command (caller falls through).
 *
 * All /project commands require admin — caller must check isAdmin() first.
 */
function handleProjectCommand(subcmd: string, args: string[]): string {
  switch (subcmd) {
    case 'add': {
      if (args.length < 2) return 'usage: /project add <absolute-path> <alias>'
      const [path, alias] = [args[0]!, args[1]!]
      try {
        addProject(PROJECTS_FILE, alias, path)
        return `✅ 已注册: ${alias} → ${path}`
      } catch (err) {
        return `❌ ${err instanceof Error ? err.message : String(err)}`
      }
    }
    case 'list': {
      const projects = listProjects(PROJECTS_FILE)
      if (projects.length === 0) return '还没注册任何项目。用 /project add <path> <alias> 添加。'
      const lines = projects.map(p => {
        const marker = p.is_current ? '→' : ' '
        const rel = relativeTime(p.last_active)
        return `${marker} ${p.alias}  (${p.path})  [${rel}]`
      })
      return '已注册项目:\n' + lines.join('\n')
    }
    case 'switch': {
      if (args.length < 1) return 'usage: /project switch <alias>'
      const alias = args[0]!
      const entry = resolveProject(PROJECTS_FILE, alias)
      if (!entry) {
        const known = listProjects(PROJECTS_FILE).map(p => p.alias).join(', ') || '(none)'
        return `❌ '${alias}' 未注册。已注册: ${known}`
      }
      const current = listProjects(PROJECTS_FILE).find(p => p.is_current)
      if (current?.alias === alias) return `你已经在 ${alias} 了`
      // Dispatch via the same code path as the MCP tool to keep single source of truth
      return switchProjectCore(alias, null)
    }
    case 'status': {
      const current = listProjects(PROJECTS_FILE).find(p => p.is_current)
      if (!current) return '当前没有活跃项目（registry 为空或无 current）。cwd = ' + process.cwd()
      return `当前: ${current.alias}\ncwd: ${current.path}\n上次切换: ${relativeTime(current.last_active)}`
    }
    case 'remove': {
      if (args.length < 1) return 'usage: /project remove <alias>'
      const alias = args[0]!
      try {
        removeProject(PROJECTS_FILE, alias)
        return `✅ 已移除: ${alias}`
      } catch (err) {
        return `❌ ${err instanceof Error ? err.message : String(err)}`
      }
    }
    default:
      return `未知子命令: ${subcmd}\n可用: add | list | switch | status | remove`
  }
}

/**
 * Format an ISO timestamp as "5 分钟前" / "昨天" / "Apr 10".
 */
function relativeTime(iso: string): string {
  const diff = Date.now() - Date.parse(iso)
  if (Number.isNaN(diff)) return iso
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days} 天前`
  return iso.slice(0, 10)
}
```

- [ ] **Step 3: Extract the switch core into a shared function**

Inside server.ts, extract the body of the `switch_project` MCP tool into a standalone helper so both the MCP tool and the WeChat command can call it:

Add this near other helpers:

```ts
/**
 * Shared switch implementation. Returns a user-facing message string.
 * Used by both MCP switch_project tool and WeChat /project switch command.
 */
function switchProjectCore(alias: string, note: string | null): string {
  const entry = resolveProject(PROJECTS_FILE, alias)
  if (!entry) {
    const known = listProjects(PROJECTS_FILE).map(p => p.alias).join(', ') || '(none)'
    return `❌ '${alias}' 未注册。已注册: ${known}`
  }
  try {
    const st = statSync(entry.path)
    if (!st.isDirectory()) throw new Error('not a directory')
  } catch {
    return `❌ target path invalid: ${entry.path}`
  }

  const reg = listProjects(PROJECTS_FILE)
  const currentEntry = reg.find(p => p.is_current)
  const sourceAlias = currentEntry?.alias ?? 'unknown'
  const sourcePath = currentEntry?.path ?? process.cwd()
  const sourceJsonl = currentSessionJsonl() ?? '(session jsonl not found)'

  try {
    writeHandoff({
      targetDir: entry.path,
      sourceAlias, sourcePath, sourceJsonl,
      timestamp: new Date().toISOString(), note,
    })
  } catch (err) {
    log('HANDOFF_FAIL', `writeHandoff for ${alias}: ${err instanceof Error ? err.message : String(err)}`)
  }

  try {
    setCurrent(PROJECTS_FILE, alias)
  } catch (err) {
    return `❌ setCurrent failed: ${err instanceof Error ? err.message : String(err)}`
  }

  try {
    writeFileSync(join(STATE_DIR, '.restart-flag'), `cwd=${entry.path}\n`, { mode: 0o600 })
  } catch (err) {
    return `❌ restart flag write failed: ${err instanceof Error ? err.message : String(err)}`
  }

  log('PROJECT_SWITCH', `${sourceAlias} → ${alias} (${entry.path})`)
  return `正在切换到 ${alias}... 大约 10 秒`
}
```

Then update the MCP `switch_project` case (from Task 12) to delegate:

```ts
case 'switch_project': {
  const alias = args.alias as string
  const note = (args.note as string | undefined) ?? null
  const msg = switchProjectCore(alias, note)
  const isError = msg.startsWith('❌')
  return { content: [{ type: 'text', text: msg }], isError }
}
```

- [ ] **Step 4: Hook /project into the inbound message handler**

Find where inbound text commands are dispatched (search for a handler matching `/` prefix):

```bash
grep -n "startsWith('/')" /home/nategu/.claude/plugins/local/wechat/server.ts
```

In the inbound message handler, add a branch for `/project`:

```ts
if (text.startsWith('/project')) {
  if (!isAdmin(fromUserId)) {
    await sendReplyToUser(fromUserId, '需要 admin 权限')
    return
  }
  const parts = text.split(/\s+/)
  const subcmd = parts[1] ?? 'status'
  const rest = parts.slice(2)
  const reply = handleProjectCommand(subcmd, rest)
  await sendReplyToUser(fromUserId, reply)
  return
}
```

`sendReplyToUser` is whatever the existing server.ts uses to send replies inside the inbound handler — inspect nearby code to use the same path.

- [ ] **Step 5: Run full test suite**

```bash
cd /home/nategu/.claude/plugins/local/wechat && bun test 2>&1 | tail -5
```
Expected: all tests green.

- [ ] **Step 6: Commit**

```bash
git add server.ts
git commit -m "feat(server): /project command dispatcher (add/list/switch/status/remove)"
```

---

## Task 14: setup.ts — soft-suggest `install --user` after QR scan

**Files:**
- Modify: `/home/nategu/.claude/plugins/local/wechat/setup.ts`

- [ ] **Step 1: Locate the end of the setup success path**

```bash
grep -n "setup 完成\|登录成功\|account.json\|绑定" /home/nategu/.claude/plugins/local/wechat/setup.ts | tail -5
```

- [ ] **Step 2: Add a soft suggestion after account saved**

Find the last `console.log` or success message in the setup success path and insert immediately after it:

```ts
console.log('')
console.log('💡 提示：你可以把 wechat 安装到用户级 MCP 配置，这样所有 Claude Code 会话')
console.log('   都能自动使用 wechat 通道（跨项目切换的前提）:')
console.log('     wechat-cc install --user')
console.log('')
console.log('   如果只想在当前项目使用，跳过这步，按下面方式继续:')
console.log('     wechat-cc install    # 生成 .mcp.json')
console.log('     wechat-cc run')
```

Make this a simple text nudge — don't automate the install step.

- [ ] **Step 3: Smoke test (manually run setup and verify the hint appears)**

Skip in CI — this is manual validation during release smoke.

- [ ] **Step 4: Commit**

```bash
git add setup.ts
git commit -m "feat(setup): soft-suggest install --user after QR scan"
```

---

## Task 15: README.md — document multi-project switching

**Files:**
- Modify: `/home/nategu/.claude/plugins/local/wechat/README.md`

- [ ] **Step 1: Add a new Features bullet**

Find the Features bullet list and after the existing CLI fallback line, add:

```markdown
- **Multi-project switching** — switch the active project by sending `切到 sidecar` in WeChat (or `/project switch sidecar`); wechat-cc respawns Claude in the target cwd and writes a lazy handoff pointer so you can keep conversations flowing
```

- [ ] **Step 2: Add a new section after CLI fallback**

Add after the CLI fallback section:

```markdown
### Multi-project switching

If you maintain several projects, register them once and switch between them from WeChat.

**One-time setup (install MCP at user scope so it works across all projects):**

```bash
wechat-cc install --user    # writes ~/.claude.json, no per-project .mcp.json needed
```

**Register your projects:**

In WeChat (admin only):

```
/project add /home/u/Documents/compass compass
/project add /home/u/Documents/compass-wechat-sidecar sidecar
```

**Switch between them (natural language or command):**

```
切到 sidecar                 # natural language — Claude parses intent
/project switch sidecar      # exact command form
/project list                # show all registered projects
/project status              # show current project
```

Switching takes ~5-10 seconds. WeChat messages sent during the window are buffered by ilink and delivered after reconnect — no messages lost.

**How handoff context works:** On switch, wechat-cc writes a small pointer file `<target>/memory/_handoff.md` referencing the source project's session transcript. If you later reference the prior conversation ("刚才聊的 xxx"), Claude looks up the pointer and reads the source jsonl on demand. Nothing is eagerly copied across projects.

See `docs/specs/2026-04-18-project-switch-design.md` for the full design.
```

- [ ] **Step 3: Update the Commands table**

Find the WeChat commands table and add:

```markdown
| `/project add <path> <alias>` | Register a project (admin-only) |
| `/project list` | List all registered projects |
| `/project switch <alias>` | Switch to a registered project (admin-only) |
| `/project status` | Show current project alias + cwd |
| `/project remove <alias>` | Unregister a project (admin-only) |
```

- [ ] **Step 4: Update the `wechat-cc` CLI commands list**

Find the CLI command list and add:

```markdown
wechat-cc install --user     # register wechat at user scope (works in every project)
```

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs(readme): multi-project switching usage + user-scope install"
```

---

## Task 16: Manual E2E smoke test

**Files:** (checklist — no code)

Run this list on a real machine before merging to master. Each bullet represents one manual verification step.

- [ ] **Step 1: Install at user scope from a clean state**

```bash
# Backup any existing config
cp ~/.claude.json ~/.claude.json.bak 2>/dev/null || true
wechat-cc install --user
jq '.mcpServers.wechat' ~/.claude.json
```
Expected: shows the wechat entry with bun path + `--cwd` pointing at the plugin dir.

- [ ] **Step 2: Register two real projects**

Open a terminal with `wechat-cc run` active. From WeChat (as admin):

```
/project add /absolute/path/to/projA projA
/project add /absolute/path/to/projB projB
/project list
```

Expected: `/project list` shows both, one marked current (whichever the session was started in).

- [ ] **Step 3: Natural-language switch**

From WeChat: `切到 projB`

Expected:
- Claude replies "好，切到 projB..." within 2 seconds
- Within 10 seconds, a message arrives confirming the switch
- `ls <projB>/memory/_handoff.md` exists
- `cat <projB>/memory/_handoff.md` shows source=projA + timestamp + jsonl pointer

- [ ] **Step 4: Reference prior context in new session**

In the new session (still in WeChat): "刚才我们聊了啥?"

Expected: Claude reads `_handoff.md`, follows jsonl pointer, and summarizes the prior conversation's topic. No hallucination.

- [ ] **Step 5: Switch back, verify handoff overwrites**

```
切回 projA
```

Expected: after switch, `<projA>/memory/_handoff.md` exists. Previous handoff in projB is still there (we don't delete, only overwrite on next switch to projB).

Switch to projB once more:

```
切到 projB
```

Expected: `<projB>/memory/_handoff.md` is updated with the latest timestamp (not accumulated).

- [ ] **Step 6: Unknown alias rejection**

```
切到 foobar
```

Expected: Claude replies listing known aliases; no switch happens.

- [ ] **Step 7: Non-admin rejection**

Have a non-admin WeChat user send `/project list`.

Expected: "需要 admin 权限".

- [ ] **Step 8: Current-project remove protection**

Admin sends `/project remove projB` while projB is current.

Expected: "不能 remove 当前活跃项目...".

- [ ] **Step 9: Corrupted projects.json degradation**

```bash
echo 'garbage' > ~/.claude/channels/wechat/projects.json
```

Then from WeChat: `/project list`

Expected: "还没注册任何项目..." or similar degraded-mode reply. No crash in server log.

Restore by re-running `/project add` for both projects.

- [ ] **Step 10: Verify 60 baseline + new tests all green**

```bash
cd /home/nategu/.claude/plugins/local/wechat && bun test 2>&1 | tail -5
```
Expected: total test count >= 60 + new tests (roughly 90+), 0 failures.

---

## Task 17: Merge back to master

- [ ] **Step 1: Final full test run**

```bash
cd /home/nategu/.claude/plugins/local/wechat && bun test 2>&1 | tail -5
```
All green.

- [ ] **Step 2: Merge**

```bash
git checkout master
git merge --no-ff feature/project-switch -m "feat: multi-project switching via /project command + NL

Lets WeChat users switch the active project without leaving WeChat. MCP
installs at user scope so every Claude Code session auto-attaches.
Handoff between projects is a lazy pointer file, not an eager copy.

See docs/specs/2026-04-18-project-switch-design.md for design rationale.
"
git push origin master
```

- [ ] **Step 3: Delete feature branch**

```bash
git branch -d feature/project-switch
git push origin --delete feature/project-switch
```

---

## Self-Review Summary (by plan author)

**Spec coverage check:**
- Architecture (new state files, reused state, new/modified modules) → Tasks 1-15
- Data flow (switch lifecycle) → Task 12 (switch_project) + Task 10 (cli chdir) + Task 13 (command dispatch)
- Commands & NL → Task 13 (dispatcher) + Task 11 (list_projects for NL matching)
- Error handling (user errors, runtime failures, concurrency) → Covered in Tasks 2-5 (registry validation), Task 12 (runtime fallback in switch), Task 10 (chdir failure log)
- Testing strategy (unit + manual E2E) → Tasks 2-8 (unit tests), Task 16 (manual E2E)
- Security (alias regex, admin gate, alias-only MCP tool API) → Tasks 2, 13 (admin gate), 12 (alias-only tool input)

**Placeholder scan:** None found. Every step has concrete code or exact commands.

**Type consistency:** `ProjectEntry`, `ProjectView`, `ProjectRegistry`, `HandoffInput`, `McpServerConfig` — all match between tasks that reference them. `PROJECTS_FILE` used consistently.

**Known deferrals (by design, not gaps):**
- No `/back` stack (deferred to v2)
- No handoff auto-expire (single-file overwrite handles staleness implicitly)
- No explicit rollback on switch failure (supervisor crash-loop guard tolerates it)
- No integration test that spawns real claude (too heavy; manual E2E covers this)
