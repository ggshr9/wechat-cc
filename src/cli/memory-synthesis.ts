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
import type { Db } from '../lib/db'
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
 * Build the synthesis prompt. The model produces a single Chinese markdown
 * document = the admin's "overview memory" spanning WORK (project memory) AND
 * LIFE (companion observations/milestones/notes) as one whole person. Embedded
 * content is capped to keep the prompt bounded.
 */
export function formatSynthesisPrompt(projects: ProjectMemory[], life?: LifeContext | null): string {
  const hasLife = !lifeIsEmpty(life ?? null)
  const header = [
    '你是这台电脑主人(下称「管理员」)的个人助理。下面是关于管理员的记忆,分两类:',
    'A) 工作侧 —— 他在本机各项目里积累的记忆/笔记;',
    hasLife
      ? 'B) 生活侧 —— 你(bot)在微信里观察到的他这个人、在意的人和事、偏好、近况。'
      : '(本次没有生活侧数据。)',
    '请综合成一份「总体记忆」——让你整体「懂这个人」的精炼画像。工作和生活不要分开看,他是一个完整的人。',
    '',
    '要求:',
    '1. 用中文输出一份 markdown,直接作为记忆内容,不要寒暄、不要解释你在做什么。',
    '2. 开头「整体理解」:这个人是谁、在做什么、在意什么、偏好 —— 工作和生活揉在一起写。',
    '3. 一节「## 项目地图」,每个工作项目一行: `- 项目名 — 一句话概述`(项目名用易读的名字)。',
    hasLife ? '4. 一节「## 生活与关系」:他在意的人/事、近况、性格偏好(只写生活侧有依据的)。' : '4. (无生活侧,跳过生活与关系一节。)',
    '5. 简洁,总长 ~600 字内。只写有依据的,别编造。',
    '',
    `工作侧:共 ${projects.length} 个项目`,
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

  let lifeBlock = ''
  if (hasLife && life) {
    const parts: string[] = ['\n\n========== 生活侧(微信观察) ==========']
    if (life.observations.length) parts.push(`\n【近期观察】\n${life.observations.map(o => `- ${o}`).join('\n')}`)
    if (life.milestones.length) parts.push(`\n【里程碑】\n${life.milestones.map(m => `- ${m}`).join('\n')}`)
    for (const n of life.memoryNotes) {
      parts.push(`\n【记忆: ${n.name}】\n${truncate(n.content, PER_FILE_CAP)}`)
    }
    lifeBlock = truncate(parts.join('\n'), TOTAL_CAP)
  }

  return `${header}${blocks.join('\n')}${lifeBlock}\n`
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

/**
 * The "life" side of the admin — what the WeChat companion layer has gathered:
 * observations + milestones + the per-contact memory notes the bot wrote about
 * the admin. Folded into the overview alongside the work (project) memory so
 * the synthesized "CC 眼中的你" spans the whole person, not just their code.
 */
export interface LifeContext {
  observations: string[]
  milestones: string[]
  memoryNotes: Array<{ name: string; content: string }>
}

/** True when there's no life-side signal at all. */
function lifeIsEmpty(life: LifeContext | null): boolean {
  return !life || (life.observations.length === 0 && life.milestones.length === 0 && life.memoryNotes.length === 0)
}

/**
 * Gather the admin's life-side memory from the daemon's stores + their WeChat
 * memory dir. Best-effort: every source is independently try/caught so a
 * missing table / file degrades to empty rather than failing the synthesis.
 * Excludes `_overview.md` (our own output — never feed it back in).
 */
export async function gatherLifeContext(opts: { db: Db; stateDir: string; adminChatId: string }): Promise<LifeContext> {
  const { db, stateDir, adminChatId } = opts
  const memoryRoot = join(stateDir, 'memory')
  const out: LifeContext = { observations: [], milestones: [], memoryNotes: [] }
  // Stores return oldest→newest (ORDER BY ts ASC), so take the LAST N — the
  // most RECENT life context is what makes the overview feel current ("懂你"
  // is about now, not the first things ever noticed).
  try {
    const { makeObservationsStore } = await import('../daemon/observations/store')
    const store = makeObservationsStore(db, adminChatId, { migrateFromFile: join(memoryRoot, adminChatId, 'observations.jsonl') })
    out.observations = (await store.listActive()).map(o => o.body).filter(Boolean).slice(-20)
  } catch { /* best-effort */ }
  try {
    const { makeMilestonesStore } = await import('../daemon/milestones/store')
    const store = makeMilestonesStore(db, adminChatId, { migrateFromFile: join(memoryRoot, adminChatId, 'milestones.jsonl') })
    out.milestones = (await store.list()).map(m => m.body).filter(Boolean).slice(-20)
  } catch { /* best-effort */ }
  try {
    const dir = join(memoryRoot, adminChatId)
    for (const rel of listMd(dir)) {
      if (rel === OVERVIEW_FILENAME) continue  // don't feed our own output back
      try { out.memoryNotes.push({ name: rel, content: readFileSync(join(dir, rel), 'utf8') }) } catch { /* skip */ }
    }
  } catch { /* best-effort */ }
  return out
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
  /**
   * When provided, also fold in the "life" side (observations / milestones /
   * admin memory notes) so the overview spans work AND life. Callers that have
   * a db (CLI synthesize, daemon pipeline) pass it; unit tests omit it.
   */
  db?: Db
}

export interface SynthesizeResult {
  projectsFound: number
  projectNames: string[]
  filesScanned: number
  promptChars: number
  /** Life-side counts (0 when no db was passed). */
  observationsFound: number
  milestonesFound: number
  memoryNotesFound: number
  /** Synthesized overview text (omitted on dryRun or empty result). */
  overview?: string
  /** Write result (omitted on dryRun). */
  written?: { path: string; bytesWritten: number }
}

/**
 * Run the full synthesis: discover project memory (work) + gather life context
 * when a db is given → build prompt → (unless dryRun) eval → write
 * `_overview.md` under the admin's memory dir.
 */
export async function synthesizeOverview(deps: SynthesizeDeps): Promise<SynthesizeResult> {
  const projectsRoot = deps.projectsRoot ?? defaultClaudeProjectsRoot()
  const projects = discoverProjectMemory(projectsRoot)
  const filesScanned = projects.reduce((n, p) => n + (p.index ? 1 : 0) + p.files.length, 0)
  const life = deps.db ? await gatherLifeContext({ db: deps.db, stateDir: deps.stateDir, adminChatId: deps.adminChatId }) : null
  const prompt = formatSynthesisPrompt(projects, life)
  const base: SynthesizeResult = {
    projectsFound: projects.length,
    projectNames: projects.map(p => p.displayName),
    filesScanned,
    promptChars: prompt.length,
    observationsFound: life?.observations.length ?? 0,
    milestonesFound: life?.milestones.length ?? 0,
    memoryNotesFound: life?.memoryNotes.length ?? 0,
  }
  // Nothing to synthesize only when BOTH sides are empty.
  if (deps.dryRun || (projects.length === 0 && lifeIsEmpty(life))) return base

  const raw = await deps.sdkEval(prompt)
  const overview = raw.trim()
  if (overview.length === 0) return base

  const stamped = `<!-- 由 wechat-cc 从本机 Claude 记忆整理生成 · ${new Date().toISOString()} -->\n\n${overview}\n`
  const written = writeMemoryFile(deps.stateDir, deps.adminChatId, OVERVIEW_FILENAME, stamped)
  return { ...base, overview, written: { path: OVERVIEW_FILENAME, bytesWritten: written.bytesWritten } }
}
