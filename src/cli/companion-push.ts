/**
 * companion-push — tell THIS machine's running daemon to fire a companion
 * push tick NOW, instead of waiting for the ~20min scheduler. Sends SIGUSR2,
 * which main.ts handles as fireTick('push'). Useful for testing the proactive
 * path on demand and for nudging a due follow-up immediately.
 *
 * (Unix only — SIGUSR2 isn't a thing on Windows, same as the daemon's SIGUSR1
 * reconcile handler.)
 */
import { join } from 'node:path'

export interface PushTickDeps {
  /** Read server.pid, or null if absent. */
  readPid: (path: string) => string | null
  /** process.kill(pid, signal). */
  kill: (pid: number, signal: string) => void
}

export function requestPushTick(deps: PushTickDeps, stateDir: string): { pid: number } {
  const raw = deps.readPid(join(stateDir, 'server.pid'))
  if (!raw) throw new Error('daemon 没在本机运行(无 server.pid)— 先启动本机 daemon')
  const pid = parseInt(raw.trim(), 10)
  if (!Number.isFinite(pid) || pid <= 0) throw new Error(`server.pid 内容无效: ${raw.trim()}`)
  deps.kill(pid, 'SIGUSR2')
  return { pid }
}
