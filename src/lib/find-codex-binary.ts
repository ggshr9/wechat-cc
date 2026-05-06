/**
 * find-codex-binary.ts — best-effort lookup for the `codex` CLI binary.
 *
 * Why this exists: through v0.5.5 the daemon registered the Codex provider
 * unconditionally and let `@openai/codex-sdk`'s internal `findCodexPath()`
 * resolve the platform binary at dispatch time. That worked in source
 * mode (`bun src/daemon/main.ts`) because `import.meta.url` resolves to a
 * real on-disk path inside `node_modules/`, so `createRequire(...)` could
 * find `@openai/codex-linux-x64`'s vendored binary. In compiled-binary
 * mode (`bun build --compile cli.ts`), `import.meta.url` is `/$bunfs/...`
 * — `createRequire(...)` from a virtual path can't reach the real
 * node_modules, so `findCodexPath()` throws and every codex dispatch
 * fails silently with FALLBACK_REPLY (no reply ever reaches the user).
 *
 * Fix: at daemon boot, find a real `codex` executable (PATH first, then
 * nvm fallback for systemd-user-service environments that ship without
 * NVM PATH). When found, pass it to the SDK as `codexPathOverride` —
 * that bypasses `findCodexPath()` entirely. When not found, the daemon
 * skips registering the codex provider, so `validateMode(codex)` rejects
 * the switch up front (dashboard catches the 4xx + visibly reverts the
 * dropdown with an error border) instead of silently swallowing dispatch
 * errors per turn.
 *
 * Deps are injectable for tests so we can drive the fixture matrix
 * without touching the real filesystem or process.env.
 */

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export interface FindCodexBinaryDeps {
  /** Defaults to `existsSync`. */
  exists?: (p: string) => boolean
  /** Defaults to `readdirSync`. Used only for nvm directory enumeration. */
  readdir?: (p: string) => string[]
  /** Defaults to `process.env.PATH ?? ''`. */
  pathEnv?: string
  /** Defaults to `os.homedir()`. */
  homeDir?: string
  /** Defaults to `process.platform`. */
  platform?: NodeJS.Platform
}

export function findCodexBinary(deps: FindCodexBinaryDeps = {}): string | null {
  const exists = deps.exists ?? existsSync
  const readdir = deps.readdir ?? readdirSync
  const pathEnv = deps.pathEnv ?? (process.env.PATH ?? '')
  const homeDir = deps.homeDir ?? homedir()
  const platform = deps.platform ?? process.platform
  const exe = platform === 'win32' ? 'codex.exe' : 'codex'
  const sep = platform === 'win32' ? ';' : ':'

  // 1. PATH lookup — covers system-wide installs (`/usr/local/bin`,
  // `/usr/bin`, `~/.local/bin` for npm-prefix-set-to-home), and any shell
  // that has nvm sourced before launching the daemon.
  for (const dir of pathEnv.split(sep)) {
    if (!dir) continue
    const candidate = join(dir, exe)
    if (exists(candidate)) return candidate
  }

  // 2. nvm fallback — `systemctl --user` services don't source ~/.bashrc
  // / ~/.zshrc, so NVM's PATH entries (which install codex into the
  // active node version's `bin/`) are missing. Walk `~/.nvm/versions/node`
  // newest-first so the most recently installed version wins. This covers
  // 90% of users running codex from npm.
  if (platform !== 'win32') {
    const nvmRoot = join(homeDir, '.nvm', 'versions', 'node')
    if (exists(nvmRoot)) {
      let versions: string[] = []
      try { versions = readdir(nvmRoot).slice().sort().reverse() } catch { /* ignore */ }
      for (const v of versions) {
        const candidate = join(nvmRoot, v, 'bin', exe)
        if (exists(candidate)) return candidate
      }
    }
  }

  return null
}
