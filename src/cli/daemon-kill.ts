import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { platform } from 'node:os'

export interface KillDeps {
  // Returns the full cmdline string for the given pid, or null if the
  // process is gone / unreadable. Used to verify the target really is a
  // wechat-cc daemon before signaling.
  readCmdline: (pid: number) => string | null
  // process.kill(pid, signal). Throws if pid does not exist (signal 0
  // existence check is the standard idiom).
  killSignal: (pid: number, signal: number | string) => void
  sleep: (ms: number) => Promise<void>
}

export interface KillResidualDeps extends KillDeps {
  // Read trimmed file contents, or null if the file is absent / unreadable.
  // Path-handling stays in the caller; this dep keeps the helper testable
  // without touching real filesystem.
  readPidFile: (path: string) => string | null
}

export interface KillResult {
  killed: boolean
  pid: number
  message: string
}

// Match either the source-mode entrypoint (`bun cli.ts run …` or `bun
// src/daemon/main.ts`) or the compiled binary basename. Without the
// wechat-cc-cli alternative, `wechat-cc daemon kill <pid>` would refuse
// to signal a daemon launched from the deb-installed binary on either
// Linux (cmdline `/usr/bin/wechat-cc-cli run --dangerously`) or Windows
// (tasklist image `wechat-cc-cli.exe`).
const DAEMON_CMDLINE_RE = /(?:cli\.ts(?!\.))|(?:src[/\\]daemon[/\\]main\.ts)|(?:wechat-cc-cli(?:\.exe)?)/

export async function killDaemonByPid(deps: KillDeps, pid: number): Promise<KillResult> {
  if (!Number.isFinite(pid) || pid <= 0) {
    return { killed: false, pid, message: `invalid pid: ${pid}` }
  }
  const cmdline = deps.readCmdline(pid)
  if (!cmdline) {
    return { killed: false, pid, message: `pid ${pid} not found` }
  }
  if (!DAEMON_CMDLINE_RE.test(cmdline)) {
    return { killed: false, pid, message: `pid ${pid} does not look like a wechat-cc daemon (cmdline: ${cmdline.slice(0, 200)})` }
  }
  try { deps.killSignal(pid, 'SIGTERM') }
  catch (e) { return { killed: false, pid, message: `SIGTERM failed: ${(e as Error).message}` } }

  await deps.sleep(1500)
  if (!isAlive(deps, pid)) return { killed: true, pid, message: 'killed (SIGTERM)' }

  try { deps.killSignal(pid, 'SIGKILL') } catch { /* tolerate */ }
  await deps.sleep(500)
  return isAlive(deps, pid)
    ? { killed: false, pid, message: 'process still alive after SIGTERM + SIGKILL' }
    : { killed: true, pid, message: 'killed (SIGKILL after SIGTERM timeout)' }
}

function isAlive(deps: KillDeps, pid: number): boolean {
  try { deps.killSignal(pid, 0); return true } catch { return false }
}

/**
 * Read `server.pid` and forcefully terminate the daemon if it's alive.
 *
 * This is the cross-platform "kill whatever holds the lock" used by the
 * dashboard's restart button between `service stop` and `service start`.
 * `service stop` only terminates launchctl-managed processes; a manual
 * `wechat-cc run` started in a terminal is invisible to launchctl, holds
 * the same `server.pid` lock, and would refuse the next `service start`
 * with "another daemon already running". Without this step, the user's
 * symptoms include silent service-start failures + endless launchd
 * restart loops with the manual daemon still polling.
 *
 * Best-effort by design — the four "harmless" outcomes (no pid file,
 * malformed contents, dead pid, killed cleanly) all converge to "lock is
 * free for the next start". Only true unkillable processes report failure.
 */
export async function killResidualDaemon(
  deps: KillResidualDeps,
  pidFilePath: string,
): Promise<KillResult> {
  const raw = deps.readPidFile(pidFilePath)
  if (raw === null || raw === '') {
    return { killed: false, pid: 0, message: 'no server.pid file (lock already free)' }
  }
  const pid = Number.parseInt(raw, 10)
  if (!Number.isFinite(pid) || pid <= 0) {
    return { killed: false, pid: 0, message: `invalid pid in server.pid: ${raw}` }
  }
  return killDaemonByPid(deps, pid)
}

export function defaultResidualKillDeps(): KillResidualDeps {
  const base = defaultKillDeps()
  return {
    ...base,
    readPidFile(path) {
      try {
        if (!existsSync(path)) return null
        return readFileSync(path, 'utf8').trim()
      } catch { return null }
    },
  }
}

export function defaultKillDeps(): KillDeps {
  const isWindows = platform() === 'win32'
  return {
    readCmdline(pid) {
      try {
        if (isWindows) {
          // `ps` doesn't ship with Windows. tasklist's CSV output is
          // `"image","pid","session","#","mem"`. We use the image name as
          // a stand-in for cmdline — DAEMON_CMDLINE_RE accepts it.
          const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true })
          if (r.status !== 0 || !r.stdout) return null
          const head = r.stdout.split('\n')[0] ?? ''
          if (head.startsWith('INFO:') || !head) return null
          const m = head.match(/^"([^"]+)"/)
          return m ? m[1]! : null
        }
        // POSIX path — `ps -o args=` works on macOS + Linux.
        const r = spawnSync('ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf8', windowsHide: true })
        const out = r.stdout?.trim() ?? ''
        return r.status === 0 && out.length > 0 ? out : null
      } catch { return null }
    },
    killSignal: (pid, signal) => process.kill(pid, signal as NodeJS.Signals | number),
    sleep: (ms) => new Promise(resolve => setTimeout(resolve, ms)),
  }
}
