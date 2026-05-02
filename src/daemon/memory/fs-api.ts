/**
 * memory/fs-api.ts — sandboxed filesystem for Claude's long-term memory.
 *
 * Design philosophy: Claude is given a scratch directory it owns. We don't
 * prescribe file layout, names, or schema. We only enforce safety:
 *   - All paths resolve under a single root; `..` / absolute / symlink
 *     escapes are rejected.
 *   - Only `.md` extension — keeps content human-readable, renders in the
 *     future web UI, prevents accidental binary/exec surface.
 *   - Single file capped at 100 KB — protects against runaway writes.
 *   - Atomic writes via tmp + rename.
 *
 * Everything else (subfolders per chat_id, index files, consolidation
 * strategies) is Claude's decision, reflected at runtime via its own
 * memory_write calls, not wired into this module.
 */

import {
  existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

export interface MemoryFS {
  /** Read a memory file. Returns null if not present (no throw). */
  read(relPath: string): string | null
  /** Write (atomic). Creates parent dirs as needed. */
  write(relPath: string, content: string): void
  /** List all files (recursive). When `relDir` is given, lists under that subdir. */
  list(relDir?: string): string[]
  /** Delete a file. No-op if absent. */
  delete(relPath: string): void
  /** Absolute root dir — for diagnostics only, not for Claude. */
  rootDir(): string
}

export interface MemoryFSOptions {
  rootDir: string
  maxFileBytes?: number      // default 100_000
  allowedExt?: string[]      // default ['.md']
}

export class MemoryPathError extends Error {
  constructor(msg: string) {
    super(`memory: ${msg}`)
    this.name = 'MemoryPathError'
  }
}

export function makeMemoryFS(opts: MemoryFSOptions): MemoryFS {
  const root = resolve(opts.rootDir)
  const maxBytes = opts.maxFileBytes ?? 100_000
  const exts = new Set((opts.allowedExt ?? ['.md']).map(s => s.toLowerCase()))

  if (!existsSync(root)) mkdirSync(root, { recursive: true, mode: 0o700 })

  function resolveSafe(relPath: string): string {
    if (!relPath || typeof relPath !== 'string') throw new MemoryPathError('path is required')
    if (relPath.length > 500) throw new MemoryPathError('path too long (max 500 chars)')
    if (relPath.startsWith('/') || relPath.startsWith('\\')) {
      throw new MemoryPathError('absolute paths not allowed')
    }
    if (/^[a-zA-Z]:[\\/]/.test(relPath)) {
      throw new MemoryPathError('absolute paths not allowed')
    }
    if (relPath.includes('\0')) throw new MemoryPathError('null byte in path')

    const joined = resolve(root, relPath)
    const rel = relative(root, joined)
    if (rel === '' || rel.startsWith('..') || rel.startsWith(`..${/[\\/]/.source}`)) {
      throw new MemoryPathError(`escape attempt: ${relPath}`)
    }
    return joined
  }

  function extOf(p: string): string {
    const m = p.match(/\.[^./\\]+$/)
    return m ? m[0].toLowerCase() : ''
  }

  function checkExt(p: string): void {
    const ext = extOf(p)
    if (!exts.has(ext)) {
      throw new MemoryPathError(`extension not allowed: ${ext || '(none)'}; allowed: ${[...exts].join(', ')}`)
    }
  }

  return {
    rootDir: () => root,

    read(relPath) {
      const full = resolveSafe(relPath)
      checkExt(full)
      if (!existsSync(full)) return null
      return readFileSync(full, 'utf8')
    },

    write(relPath, content) {
      const full = resolveSafe(relPath)
      checkExt(full)
      if (typeof content !== 'string') throw new MemoryPathError('content must be a string')
      const bytes = Buffer.byteLength(content, 'utf8')
      if (bytes > maxBytes) {
        throw new MemoryPathError(`file too large: ${bytes} bytes > ${maxBytes} limit`)
      }
      const dir = dirname(full)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
      const tmp = `${full}.tmp-${process.pid}-${Date.now()}`
      writeFileSync(tmp, content, { mode: 0o600, encoding: 'utf8' })
      renameSync(tmp, full)
    },

    list(relDir) {
      const full = relDir ? resolveSafe(relDir) : root
      if (!existsSync(full)) return []
      const out: string[] = []
      const stack: string[] = [full]
      while (stack.length > 0) {
        const dir = stack.pop()!
        let entries: import('node:fs').Dirent[]
        try { entries = readdirSync(dir, { withFileTypes: true, encoding: 'utf8' }) } catch { continue }
        for (const entry of entries) {
          // Skip hidden entries and tmp files from interrupted atomic writes
          if (entry.name.startsWith('.') || entry.name.includes('.tmp-')) continue
          const p = join(dir, entry.name)
          if (entry.isDirectory()) stack.push(p)
          else if (entry.isFile() && exts.has(extOf(entry.name))) {
            // Normalize to POSIX so the public API (paths shown to Claude
            // and consumed by `memory_read`) is identical on Windows + POSIX.
            out.push(relative(root, p).split(sep).join('/'))
          }
        }
      }
      return out.sort()
    },

    delete(relPath) {
      const full = resolveSafe(relPath)
      checkExt(full)
      if (existsSync(full)) unlinkSync(full)
    },
  }
}
