/**
 * runtime-info.ts — single source of truth for "are we running as a
 * `bun build --compile`d desktop sidecar, or as the source-mode CLI?".
 *
 * Bun packs the entry script under `/$bunfs/root/...` in compiled binaries.
 * Three modules need to know this and previously each duplicated the
 * detection inline:
 *   - cli.ts         (service install path picks binaryPath vs bunPath+cli.ts)
 *   - cli.ts         (update command short-circuits when no .git available)
 *   - doctor.ts      (defaultServiceSnapshot resolves the service plan)
 *
 * The detection is brittle (literal `/$bunfs/` is a Bun internal that could
 * change). Centralizing here means one place to update if Bun ever rev's
 * the prefix, and one place to add a more durable check (e.g. probing
 * import.meta.dir existence) without touching downstream callers.
 */

import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// Internals exposed for tests (real process.argv / process.execPath aren't
// easy to spoof in vitest, so we factor pure decisions out and let the
// public API thread real values through them).
export const __testInternals = {
  // Two-stage detection:
  //   1. Primary — argv[1] starts with `/$bunfs/`. This is the documented
  //      Bun virtual-fs prefix in compiled binaries today and works
  //      reliably across all Bun launch modes we've tested.
  //   2. Fallback — module dir doesn't exist on disk. If Bun ever changes
  //      the virtual-fs prefix, the primary signal goes silent; the
  //      fallback catches it because import.meta.dir is still a virtual
  //      path that fails existsSync(). Source mode always has a real
  //      on-disk repo root, so the fallback returns false there.
  // Pass `moduleDir` as undefined to skip the fallback (used by tests and
  // when we know argv[1] is reliable for the call site).
  detectCompiledBundle(argv1: string | undefined, moduleDir?: string): boolean {
    if (typeof argv1 === 'string' && argv1.startsWith('/$bunfs/')) return true
    if (moduleDir && !existsSync(moduleDir)) return true
    return false
  },
  resolveCompiledBinaryPath(isCompiled: boolean, execPath: string): string | null {
    return isCompiled ? execPath : null
  },
  resolveCompiledRepoRoot(isCompiled: boolean, execPath: string): string | null {
    return isCompiled ? dirname(execPath) : null
  },
}

/** True when this process is the `wechat-cc-cli` sidecar inside a desktop bundle. */
export function isCompiledBundle(): boolean {
  // Pass import.meta.url's dirname so the fallback can probe whether the
  // module's source dir actually exists. Wrapped in try/catch for the
  // pathological case where fileURLToPath itself fails (non-file URL).
  let moduleDir: string | undefined
  try { moduleDir = dirname(fileURLToPath(import.meta.url)) } catch {}
  return __testInternals.detectCompiledBundle(process.argv[1], moduleDir)
}

/**
 * Path to the compiled wechat-cc-cli binary, or null in source mode. When
 * non-null, this is what the service unit's ExecStart should point at —
 * one self-contained binary, no external `bun` runtime needed.
 */
export function compiledBinaryPath(): string | null {
  return __testInternals.resolveCompiledBinaryPath(isCompiledBundle(), process.execPath)
}

/**
 * Best-guess "where would the binary expect to find its repo siblings".
 * In compiled mode this is the bundle's MacOS/ directory (no real git
 * repo present — `update` should short-circuit). In source mode, callers
 * should fall back to dirname(fileURLToPath(import.meta.url)) themselves
 * since that's a build-time concern.
 */
export function compiledRepoRoot(): string | null {
  return __testInternals.resolveCompiledRepoRoot(isCompiledBundle(), process.execPath)
}
