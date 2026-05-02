import { spawnSync } from 'node:child_process'
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

export function defaultKillDeps(): KillDeps {
  const isWindows = platform() === 'win32'
  return {
    readCmdline(pid) {
      try {
        if (isWindows) {
          // `ps` doesn't ship with Windows. tasklist's CSV output is
          // `"image","pid","session","#","mem"`. We use the image name as
          // a stand-in for cmdline — DAEMON_CMDLINE_RE accepts it.
          const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' })
          if (r.status !== 0 || !r.stdout) return null
          const head = r.stdout.split('\n')[0] ?? ''
          if (head.startsWith('INFO:') || !head) return null
          const m = head.match(/^"([^"]+)"/)
          return m ? m[1]! : null
        }
        // POSIX path — `ps -o args=` works on macOS + Linux.
        const r = spawnSync('ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf8' })
        const out = r.stdout?.trim() ?? ''
        return r.status === 0 && out.length > 0 ? out : null
      } catch { return null }
    },
    killSignal: (pid, signal) => process.kill(pid, signal as NodeJS.Signals | number),
    sleep: (ms) => new Promise(resolve => setTimeout(resolve, ms)),
  }
}
