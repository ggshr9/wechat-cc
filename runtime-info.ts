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

import { dirname } from 'node:path'

// Internals exposed for tests (real process.argv / process.execPath aren't
// easy to spoof in vitest, so we factor pure decisions out and let the
// public API thread real values through them).
export const __testInternals = {
  detectCompiledBundle(argv1: string | undefined): boolean {
    return typeof argv1 === 'string' && argv1.startsWith('/$bunfs/')
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
  return __testInternals.detectCompiledBundle(process.argv[1])
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
