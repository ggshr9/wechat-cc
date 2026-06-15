/**
 * memory-synthesis — build a holistic "overview memory" for the admin from
 * their local Claude Code per-project memory.
 *
 * The admin's own claude/codex memory lives, per project, under
 *   ~/.claude/projects/<encoded-cwd>/memory/   (MEMORY.md index + *.md files)
 * That raw memory is owned by Claude Code (we never edit or copy-mirror it —
 * see the design note in the import-claude-codex memory). Instead, on demand
 * (desktop "刷新" button, or the admin asking the bot in WeChat), we run a
 * single cheap LLM pass that reads across ALL project memories and writes ONE
 * synthesized file —
 *   <stateDir>/memory/<adminChatId>/_overview.md
 * — capturing "who the admin is / what they're working on" plus a project map
 * (project name + one-liner each). buildMemorySnapshot() reads that dir, so
 * the overview is automatically fed to the bot as the admin's "懂我" context.
 * Only the synthesized overview is fed to the bot — the raw per-project memory
 * is kept out of the prompt to save tokens (it stays viewable in the desktop
 * memory pane as provenance).
 *
 * This module is provider-agnostic: the LLM call is an injected `sdkEval`
 * (same pattern as summarizer-runtime), so the CLI wires the admin's provider
 * (claude/codex) and tests pass a mock.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { writeMemoryFile } from './memory'

/** Default root for Claude Code's per-project memory dirs. */
export function defaultClaudeProjectsRoot(): string {
  return join(homedir(), '.claude', 'projects')
}

/** Filename of the synthesized overview written into the admin memory dir. */
export const OVERVIEW_FILENAME = '_overview.md'

// Keep the prompt bounded: cap per-project content and total embedded bytes
// so a project with a huge memory store can't blow up the eval. MEMORY.md
// (the index) is always kept; individual files are truncated past the cap.
const PER_FILE_CAP = 4_000
const PER_PROJECT_CAP = 12_000
const TOTAL_CAP = 40_000

export interface ProjectMemory {
  /** Encoded project dir name, e.g. "-Users-me-Documents-sec-company". */
  encodedDir: string
  /** Best-effort human project name, e.g. "sec-company". */
  displayName: string
  /** MEMORY.md index content, if present. */
  index: string | null
  /** Other .md files (excludes MEMORY.md), path relative to the memory dir. */
  files: Array<{ path: string; content: string }>
  /** Sum of bytes across index + files (pre-truncation). */
  totalBytes: number
}

// Path segments we treat as "containers" (drop the leading one so the name
// reads as the project, not its parent folder).
const CONTAINER_SEGMENTS = new Set([
  'documents', 'desktop', 'downloads', 'projects', 'project', 'code', 'src',
  'repos', 'repositories', 'workspace', 'work', 'git',
])

/**
 * Best-effort project name from the encoded dir. Claude encodes the absolute
 * cwd by replacing every non-alphanumeric char with '-' (so both '/' and '_'
 * collapse to '-' — not perfectly invertible). We strip the encoded home
 * prefix (re-encoding os.homedir() the same way) and a leading container
 * segment (Documents/projects/…), then re-join the rest with '-'. Falls back
 * to the trailing segment. The LLM also sees the memory content, so a rough
 * name here is fine — it can relabel from content.
 */
export function projectDisplayName(encodedDir: string, home: string = homedir()): string {
  const encode = (s: string): string => s.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  const encHome = encode(home)
  let rest = encodedDir.replace(/^-+/, '')
  if (encHome && rest.toLowerCase().startsWith(`${encHome.toLowerCase()}-`)) {
    rest = rest.slice(encHome.length).replace(/^-+/, '')
  }
  const segs = rest.split('-').filter(Boolean)
  if (segs.length > 1 && CONTAINER_SEGMENTS.has(segs[0].toLowerCase())) segs.shift()
  return segs.join('-') || encodedDir.replace(/^-+/, '') || encodedDir
}

function listMd(dir: string): string[] {
  const out: string[] = []
  const walk = (sub: string): void => {
    const here = sub ? join(dir, sub) : dir
    let entries: ReturnType<typeof readdirSync>
    try {
      entries = readdirSync(here, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name.includes('.tmp-')) continue
      const rel = sub ? `${sub}/${e.name}` : e.name
      if (e.isDirectory()) walk(rel)
      else if (e.isFile() && e.name.endsWith('.md')) out.push(rel)
    }
  }
  walk('')
  return out.sort()
}

/**
 * Scan `projectsRoot` for per-project memory dirs and read their .md files.
 * Projects with no memory dir (or an empty one) are skipped.
 */
export function discoverProjectMemory(projectsRoot: string): ProjectMemory[] {
  if (!existsSync(projectsRoot)) return []
  let projectDirs: string[]
  try {
    projectDirs = readdirSync(projectsRoot, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name)
  } catch {
    return []
  }
  const out: ProjectMemory[] = []
  for (const encodedDir of projectDirs) {
    const memDir = join(projectsRoot, encodedDir, 'memory')
    if (!existsSync(memDir)) continue
    const relPaths = listMd(memDir)
    if (relPaths.length === 0) continue
    let index: string | null = null
    const files: Array<{ path: string; content: string }> = []
    let totalBytes = 0
    for (const rel of relPaths) {
      let content: string
      let size: number
      try {
        const abs = join(memDir, rel)
        content = readFileSync(abs, 'utf8')
        size = statSync(abs).size
      } catch {
        continue
      }
      totalBytes += size
      if (rel === 'MEMORY.md') index = content
      else files.push({ path: rel, content })
    }
    if (index === null && files.length === 0) continue
    out.push({ encodedDir, displayName: projectDisplayName(encodedDir), index, files, totalBytes })
  }
  out.sort((a, b) => a.displayName.localeCompare(b.displayName))
  return out
}

function truncate(s: string, cap: number): string {
  if (s.length <= cap) return s
  return `${s.slice(0, cap)}\n…(截断, 共 ${s.length} 字)`
}

/**
 * Build the synthesis prompt. The model is asked to produce a single Chinese
 * markdown document = the admin's "overview memory": a holistic understanding
 * plus a project map (name + one-liner per project). Embedded project content
 * is capped to keep the prompt bounded.
 */
export function formatSynthesisPrompt(projects: ProjectMemory[]): string {
  const header = [
    '你是这台电脑主人(下称「管理员」)的个人助理。下面是管理员在本机各个项目里积累的记忆/笔记。',
    '请把它们综合成一份「总体记忆」——一份让你(以及微信里的 bot)能整体「懂这个人」的精炼画像。',
    '',
    '要求:',
    '1. 用中文输出一份 markdown 文档,直接作为记忆内容,不要寒暄、不要解释你在做什么。',
    '2. 开头一段「整体理解」:这个人是谁、在做什么、关注点和偏好(从记忆里能推断的)。',
    '3. 然后一节「## 项目地图」,每个项目一行: `- 项目名 — 一句话概述`。项目名用易读的名字(可从内容里提炼,不必是目录名)。',
    '4. 简洁。总长度控制在 ~600 字以内。只写有依据的内容,别编造。',
    '',
    `共 ${projects.length} 个项目:`,
    '',
  ].join('\n')

  const blocks: string[] = []
  let budget = TOTAL_CAP
  for (const p of projects) {
    if (budget <= 0) {
      blocks.push(`\n--- 项目: ${p.displayName} (目录 ${p.encodedDir}) ---\n(略, prompt 长度已达上限)`)
      continue
    }
    const sections: string[] = [`\n--- 项目: ${p.displayName} (目录 ${p.encodedDir}) ---`]
    let projBudget = Math.min(PER_PROJECT_CAP, budget)
    if (p.index) {
      const t = truncate(p.index, Math.min(PER_FILE_CAP, projBudget))
      sections.push(`# MEMORY.md (索引)\n${t}`)
      projBudget -= t.length
    }
    for (const f of p.files) {
      if (projBudget <= 0) break
      const t = truncate(f.content, Math.min(PER_FILE_CAP, projBudget))
      sections.push(`# ${f.path}\n${t}`)
      projBudget -= t.length
    }
    const block = sections.join('\n')
    blocks.push(block)
    budget -= block.length
  }
  return `${header}${blocks.join('\n')}\n`
}

/** Read-only metadata view of one project's memory, for the desktop viewer. */
export interface ProjectMemorySummary {
  name: string
  encodedDir: string
  /** MEMORY.md index content, if present. */
  index: string | null
  files: Array<{ path: string; bytes: number; content: string }>
  totalBytes: number
}

/**
 * Lightweight read-only listing of all project memories — what the desktop
 * "项目记忆(原始素材)" layer renders. Content is included (the dirs are
 * local and small in practice); the bot never sees this — only the
 * synthesized overview is fed to the model.
 */
export function summarizeProjectMemories(projectsRoot?: string): ProjectMemorySummary[] {
  const projects = discoverProjectMemory(projectsRoot ?? defaultClaudeProjectsRoot())
  return projects.map(p => ({
    name: p.displayName,
    encodedDir: p.encodedDir,
    index: p.index,
    files: p.files.map(f => ({ path: f.path, bytes: Buffer.byteLength(f.content, 'utf8'), content: f.content })),
    totalBytes: p.totalBytes,
  }))
}

export interface SynthesizeDeps {
  stateDir: string
  /** Admin's chat_id (== userId); the overview is written under its memory dir. */
  adminChatId: string
  /** LLM call (injected; CLI wires admin's provider, tests pass a mock). */
  sdkEval: (prompt: string) => Promise<string>
  /** Defaults to ~/.claude/projects. */
  projectsRoot?: string
  /** When true, discover + build prompt but make no LLM call and no write. */
  dryRun?: boolean
}

export interface SynthesizeResult {
  projectsFound: number
  projectNames: string[]
  filesScanned: number
  promptChars: number
  /** Synthesized overview text (omitted on dryRun or empty result). */
  overview?: string
  /** Write result (omitted on dryRun). */
  written?: { path: string; bytesWritten: number }
}

/**
 * Run the full synthesis: discover project memory → build prompt → (unless
 * dryRun) eval → write `_overview.md` under the admin's memory dir.
 */
export async function synthesizeOverview(deps: SynthesizeDeps): Promise<SynthesizeResult> {
  const projectsRoot = deps.projectsRoot ?? defaultClaudeProjectsRoot()
  const projects = discoverProjectMemory(projectsRoot)
  const filesScanned = projects.reduce((n, p) => n + (p.index ? 1 : 0) + p.files.length, 0)
  const prompt = formatSynthesisPrompt(projects)
  const base: SynthesizeResult = {
    projectsFound: projects.length,
    projectNames: projects.map(p => p.displayName),
    filesScanned,
    promptChars: prompt.length,
  }
  if (deps.dryRun || projects.length === 0) return base

  const raw = await deps.sdkEval(prompt)
  const overview = raw.trim()
  if (overview.length === 0) return base

  const stamped = `<!-- 由 wechat-cc 从本机 Claude 记忆整理生成 · ${new Date().toISOString()} -->\n\n${overview}\n`
  const written = writeMemoryFile(deps.stateDir, deps.adminChatId, OVERVIEW_FILENAME, stamped)
  return { ...base, overview, written: { path: OVERVIEW_FILENAME, bytesWritten: written.bytesWritten } }
}
