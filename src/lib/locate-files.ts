/**
 * locate-files — stateless bounded filesystem search for the admin's own files.
 * Pure (no daemon/cli imports); the internal-api route wraps it. No index, no
 * embeddings — a live walk each call. Returns metadata only, never file bodies.
 */
import { readdirSync, statSync, openSync, readSync, closeSync, type Dirent } from 'node:fs'
import { join } from 'node:path'

export interface Candidate {
  path: string   // absolute file/dir path
  name: string   // basename
  dir: string    // absolute parent dir
  bytes: number  // 0 for dirs
  mtime: string  // ISO; '' if unstatable
  isDir: boolean
  score: number
}

export interface LocateLimits {
  maxDepth: number
  maxEntries: number
  maxResults: number
  timeoutMs: number
  grepMaxFiles: number
  grepMaxBytesPerFile: number
}

export const DEFAULT_LIMITS: LocateLimits = {
  maxDepth: 6,
  maxEntries: 20_000,
  maxResults: 10,
  timeoutMs: 4_000,
  grepMaxFiles: 200,
  grepMaxBytesPerFile: 256 * 1024,
}

export interface LocateOpts {
  roots: string[]
  query?: string
  mode: 'name' | 'content' | 'browse'
  limits?: Partial<LocateLimits>
  now?: () => number
}

export interface LocateResult {
  candidates: Candidate[]
  scannedEntries: number
  truncated: boolean
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'Library', '.Trash', '.cache'])

function meta(path: string, name: string, dir: string, isDir: boolean, score: number): Candidate {
  let bytes = 0
  let mtime = ''
  try { const st = statSync(path); bytes = isDir ? 0 : st.size; mtime = st.mtime.toISOString() } catch { /* unstatable */ }
  return { path, name, dir, bytes, mtime, isDir, score }
}

function scoreName(query: string, name: string, rel: string): number {
  const q = query.toLowerCase()
  if (name.toLowerCase().includes(q)) return 3
  if (rel.toLowerCase().includes(q)) return 1
  return 0
}

function grepHit(path: string, query: string, maxBytes: number): boolean {
  let fd = -1
  try {
    fd = openSync(path, 'r')
    const buf = Buffer.allocUnsafe(maxBytes)
    const n = readSync(fd, buf, 0, maxBytes, 0)
    return buf.subarray(0, n).toString('utf8').toLowerCase().includes(query.toLowerCase())
  } catch { return false } finally { if (fd >= 0) try { closeSync(fd) } catch { /* */ } }
}

export function locateFiles(opts: LocateOpts): LocateResult {
  const limits = { ...DEFAULT_LIMITS, ...(opts.limits ?? {}) }
  const nowFn = opts.now ?? Date.now
  const deadline = nowFn() + limits.timeoutMs
  const query = (opts.query ?? '').trim()
  const roots = [...new Set(opts.roots)]
  const out: Candidate[] = []
  let scanned = 0
  let truncated = false
  let grepped = 0

  // browse: list immediate children (files + dirs) of each root, no recursion.
  if (opts.mode === 'browse') {
    for (const r of roots) {
      let entries: Dirent[]
      try { entries = readdirSync(r, { withFileTypes: true }) } catch { continue }
      for (const e of entries) {
        if (e.name.startsWith('.')) continue
        if (e.isDirectory() && SKIP_DIRS.has(e.name)) continue
        scanned++
        if (scanned > limits.maxEntries || nowFn() > deadline) { truncated = true; break }
        out.push(meta(join(r, e.name), e.name, r, e.isDirectory(), 0))
      }
    }
    out.sort((a, b) => b.mtime.localeCompare(a.mtime))
    return { candidates: out.slice(0, limits.maxResults), scannedEntries: scanned, truncated: truncated || out.length > limits.maxResults }
  }

  // name / content: recursive bounded walk; only matches are returned.
  outer: for (const r of roots) {
    const stack: Array<[string, number]> = [[r, 0]]
    while (stack.length) {
      const [dir, depth] = stack.pop()!
      let entries: Dirent[]
      try { entries = readdirSync(dir, { withFileTypes: true }) } catch { continue }
      for (const e of entries) {
        if (e.name.startsWith('.')) continue
        scanned++
        if (scanned > limits.maxEntries || nowFn() > deadline) { truncated = true; break outer }
        const full = join(dir, e.name)
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name) && depth + 1 <= limits.maxDepth) stack.push([full, depth + 1])
          continue
        }
        if (!e.isFile() || !query) continue
        const rel = full.slice(r.length).replace(/^[/\\]+/, '')
        let score = scoreName(query, e.name, rel)
        if (score === 0 && opts.mode === 'content' && grepped < limits.grepMaxFiles) {
          grepped++
          if (grepHit(full, query, limits.grepMaxBytesPerFile)) score = 1
        }
        if (score > 0) out.push(meta(full, e.name, dir, false, score))
      }
    }
  }
  out.sort((a, b) => b.score - a.score || b.mtime.localeCompare(a.mtime))
  return { candidates: out.slice(0, limits.maxResults), scannedEntries: scanned, truncated: truncated || out.length > limits.maxResults }
}
