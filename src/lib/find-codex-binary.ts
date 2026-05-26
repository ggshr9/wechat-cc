/**
 * find-codex-binary — locate the user's codex CLI on PATH.
 *
 * Design (post Task #18): pure PATH + nvm lookup. No bundled-shim probes.
 *
 * Why no bundle: the codex SDK ↔ CLI protocol is version-locked. A bundled
 * CLI that lags the user's preferred version forces wechat-cc into "stale
 * bundle" UX ("I upgraded codex, why is wechat-cc still on the old one?").
 * Codex auth lives in `~/.codex/auth.json` regardless of which CLI binary
 * spawns it — so the user's globally-installed CLI is the natural source
 * of truth. When user's CLI version != our SDK SDK version, codex-autofix
 * (src/lib/codex-autofix.ts) realigns the SDK via `bun add`.
 *
 * If the user has never installed codex globally, this returns null and
 * the daemon refuses to register the codex provider with a clear error
 * pointing the user at `npm i -g @openai/codex@<X> && codex login`.
 *
 * The nvm fallback exists because `systemctl --user` services don't
 * source ~/.bashrc / ~/.zshrc — so NVM's PATH entries (which install
 * codex into the active node version's bin/) are missing from the
 * launched daemon's PATH. The fallback walks ~/.nvm/versions/node
 * newest-first.
 */

import { existsSync, readdirSync } from 'node:fs'
import { posix as posixPath, win32 as winPath } from 'node:path'
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
  // Drive `join` off the `platform` dep, not the host. Otherwise tests
  // that pass platform: 'linux' still get backslash-joined paths on a
  // Windows runner and never match their forward-slash fixtures.
  const platformPath = platform === 'win32' ? winPath : posixPath

  // 1. PATH lookup — the canonical place. Covers system-wide installs
  // (/usr/local/bin, /usr/bin, ~/.local/bin for npm-prefix-set-to-home),
  // and any shell that has nvm sourced before launching the daemon.
  for (const dir of pathEnv.split(sep)) {
    if (!dir) continue
    const candidate = platformPath.join(dir, exe)
    if (exists(candidate)) return candidate
  }

  // 2. nvm fallback — `systemctl --user` services don't source
  // ~/.bashrc / ~/.zshrc, so NVM's PATH entries (which install codex
  // into the active node version's bin/) are missing. Walk
  // ~/.nvm/versions/node newest-first so the most recently installed
  // version wins. This covers 90% of users running codex from npm.
  if (platform !== 'win32') {
    const nvmRoot = platformPath.join(homeDir, '.nvm', 'versions', 'node')
    if (exists(nvmRoot)) {
      let versions: string[] = []
      try { versions = readdir(nvmRoot).slice().sort().reverse() } catch { /* ignore */ }
      for (const v of versions) {
        const candidate = platformPath.join(nvmRoot, v, 'bin', exe)
        if (exists(candidate)) return candidate
      }
    }
  }

  return null
}
