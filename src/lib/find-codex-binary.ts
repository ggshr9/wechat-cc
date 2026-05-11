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
// Pull both flavors so the `platform` dep can drive separator + join
// semantics independently of the runner OS. Without this the Linux test
// fixtures fail on the Windows CI runner because the host's `join` swaps
// `/` for `\` even when the test explicitly passes platform: 'linux'.
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
  /** Defaults to `process.env.WECHAT_CC_ROOT`. */
  wechatCcRoot?: string | undefined
  /** Defaults to `process.execPath`. Used to derive the desktop installer's
   *  .app bundle Resources path so a version-matched codex shipped inside
   *  the bundle wins over a stale global codex on PATH. */
  execPath?: string
}

/** Derive `<bundle>.app/Contents/Resources/` from `execPath` when the
 *  daemon was launched as a Tauri sidecar. Returns null in source mode
 *  (or any other non-`.app` launch context) so we never falsely probe a
 *  parent directory that has nothing to do with the bundle. macOS only
 *  for now — Linux .deb and Windows .nsis have their own conventions
 *  that a follow-up can wire when desktop builds need them. */
function appResourcesFrom(
  execPath: string,
  p: typeof posixPath,
): string | null {
  // execPath = .../wechat-cc.app/Contents/MacOS/<binary>
  // → Resources at .../wechat-cc.app/Contents/Resources
  const macOSDir = p.dirname(execPath)               // .../Contents/MacOS
  const contentsDir = p.dirname(macOSDir)            // .../Contents
  const bundleDir = p.dirname(contentsDir)           // .../wechat-cc.app
  if (p.basename(macOSDir) !== 'MacOS') return null
  if (p.basename(contentsDir) !== 'Contents') return null
  if (!bundleDir.endsWith('.app')) return null
  return p.join(contentsDir, 'Resources')
}

// Common on-disk locations of wechat-cc's own source clone — the README
// recommends `~/.claude/plugins/local/wechat/` for the desktop installer;
// `~/.local/share/wechat-cc/` is the alternative the docs mention. Anything
// else can be set via `WECHAT_CC_ROOT`.
function wechatCcSourceProbeRoots(
  homeDir: string,
  override: string | undefined,
  p: typeof posixPath,
): string[] {
  const roots: string[] = []
  if (override) roots.push(override)
  roots.push(p.join(homeDir, '.claude', 'plugins', 'local', 'wechat'))
  roots.push(p.join(homeDir, '.local', 'share', 'wechat-cc'))
  return roots
}

export function findCodexBinary(deps: FindCodexBinaryDeps = {}): string | null {
  const exists = deps.exists ?? existsSync
  const readdir = deps.readdir ?? readdirSync
  const pathEnv = deps.pathEnv ?? (process.env.PATH ?? '')
  const homeDir = deps.homeDir ?? homedir()
  const platform = deps.platform ?? process.platform
  const wechatCcRoot = 'wechatCcRoot' in deps ? deps.wechatCcRoot : process.env.WECHAT_CC_ROOT
  const execPath = deps.execPath ?? process.execPath
  const exe = platform === 'win32' ? 'codex.exe' : 'codex'
  const sep = platform === 'win32' ? ';' : ':'
  // Drive `join` off the `platform` dep, not the host. Otherwise tests
  // that pass platform: 'linux' still get backslash-joined paths on a
  // Windows runner and never match their forward-slash fixtures.
  const platformPath = platform === 'win32' ? winPath : posixPath

  // 0. Tauri .app bundle Resources (highest priority). When the daemon was
  // launched as the desktop installer's sidecar, execPath looks like
  // /<...>/wechat-cc.app/Contents/MacOS/wechat-cc-cli. The Tauri bundle
  // ships `Contents/Resources/codex/bin/codex.js` (the matching @openai/codex
  // package — see apps/desktop/src-tauri/tauri.conf.json). Finding it here
  // guarantees version match regardless of what global codex the user has.
  // We pattern-match the parent-of-parent on `.app/Contents` so we don't
  // false-positive on source-mode (`bun` on PATH) launches.
  const bundleResources = appResourcesFrom(execPath, platformPath)
  if (bundleResources) {
    const shim = platformPath.join(bundleResources, 'codex', 'bin', 'codex.js')
    if (exists(shim)) return shim
  }

  // 1. wechat-cc's bundled, SDK-version-matched JS shim (highest priority).
  // The Codex wire protocol changes across versions: a globally-installed
  // codex 0.125.0 paired with SDK 0.128.0 silently emits events the SDK
  // doesn't decode, so dispatch returns empty `assistantText` and no reply
  // gets sent. Preferring our own `node_modules/@openai/codex/bin/codex.js`
  // pins the codex CLI version to the SDK we ship with.
  for (const root of wechatCcSourceProbeRoots(homeDir, wechatCcRoot, platformPath)) {
    const shim = platformPath.join(root, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
    if (exists(shim)) return shim
  }

  // 2. PATH lookup — covers system-wide installs (`/usr/local/bin`,
  // `/usr/bin`, `~/.local/bin` for npm-prefix-set-to-home), and any shell
  // that has nvm sourced before launching the daemon.
  for (const dir of pathEnv.split(sep)) {
    if (!dir) continue
    const candidate = platformPath.join(dir, exe)
    if (exists(candidate)) return candidate
  }

  // 3. nvm fallback — `systemctl --user` services don't source ~/.bashrc
  // / ~/.zshrc, so NVM's PATH entries (which install codex into the
  // active node version's `bin/`) are missing. Walk `~/.nvm/versions/node`
  // newest-first so the most recently installed version wins. This covers
  // 90% of users running codex from npm.
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
