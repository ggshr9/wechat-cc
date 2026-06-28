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
  /** Cap statSync calls per folder — a pathological folder (50k files) would
   * otherwise stat every file just to pick the most recent few. fileCount stays
   * accurate; only the recency sample is drawn from the first this-many files. */
  maxFilesPerFolder: number
}

export const DEFAULT_SURVEY_LIMITS: SurveyLimits = {
  maxDepth: 3,
  maxFolders: 200,
  samplePerFolder: 8,
  totalBytes: 12_000,
  maxFilesPerFolder: 2_000,
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
  const seen = new Set<string>()
  let truncated = false

  outer: for (const root of roots) {
    const queue: Array<[string, number]> = [[root, 0]]   // BFS: shallow folders first
    while (queue.length) {
      if (folders.length >= limits.maxFolders) { truncated = true; break outer }
      const [dir, depth] = queue.shift()!
      if (seen.has(dir)) continue
      seen.add(dir)
      let entries: Dirent[]
      try { entries = readdirSync(dir, { withFileTypes: true }) } catch { continue }
      const files: Array<{ name: string; mtimeMs: number }> = []
      const subdirs: string[] = []
      let fileCount = 0
      for (const e of entries) {
        if (e.name.startsWith('.')) continue
        if (e.isDirectory()) {
          if (SKIP_DIRS.has(e.name)) continue
          subdirs.push(e.name)
          if (depth + 1 <= limits.maxDepth) queue.push([join(dir, e.name), depth + 1])
        } else if (e.isFile()) {
          fileCount++
          // Bound statSync: only the first maxFilesPerFolder files feed the
          // recency sample; fileCount above still counts them all.
          if (files.length < limits.maxFilesPerFolder) {
            let mtimeMs = 0
            try { mtimeMs = statSync(join(dir, e.name)).mtimeMs } catch { /* unstatable */ }
            files.push({ name: e.name, mtimeMs })
          }
        }
      }
      files.sort((a, b) => b.mtimeMs - a.mtimeMs)
      folders.push({
        path: dir,
        fileCount,
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
  let truncated = survey.truncated
  if (Buffer.byteLength(body, 'utf8') > totalBytes) {
    // Slicing at a byte boundary can cut a multibyte char in half; decoding
    // then yields a trailing U+FFFD. Strip it so the survey reads cleanly.
    body = Buffer.from(body, 'utf8').subarray(0, totalBytes).toString('utf8').replace(/�+$/, '')
    truncated = true
  }
  if (truncated) body += '\n…(截断)'
  return body
}
