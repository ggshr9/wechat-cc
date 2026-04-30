import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { platform } from 'node:os'
import { spawnSync } from 'node:child_process'

export type LockResult = { ok: true } | { ok: false; reason: string; pid: number }

export function acquireInstanceLock(pidPath: string): LockResult {
  if (existsSync(pidPath)) {
    try {
      const raw = readFileSync(pidPath, 'utf8').trim()
      const pid = Number(raw)
      if (Number.isFinite(pid) && pid > 0 && isOurDaemon(pid)) {
        return { ok: false, reason: 'another daemon already running', pid }
      }
    } catch {}
  }
  writeFileSync(pidPath, String(process.pid), 'utf8')
  return { ok: true }
}

export function releaseInstanceLock(pidPath: string): void {
  try {
    const raw = readFileSync(pidPath, 'utf8').trim()
    if (Number(raw) === process.pid) unlinkSync(pidPath)
  } catch {}
}

// Without /proc/PID/comm verification, a stale pidfile from a kernel-panic
// or OOM-kill blocks the next daemon start: `kill(pid, 0)` returns 0 for
// any process the kernel reused that PID for after reboot, so the lock
// looks held forever. Match against the running command name instead —
// only refuse start if a current process is actually our daemon.
function isOurDaemon(pid: number): boolean {
  if (!processExists(pid)) return false
  const pf = platform()
  if (pf === 'linux') return matchLinuxComm(pid)
  if (pf === 'win32') return matchWindowsImage(pid)
  // macOS / others: process exists check only — PID-reuse window is small
  // because launchd recycles slowly and there's no /proc-equivalent in
  // a stable cross-version path. Acceptable until a user reports a hit.
  return true
}

function matchLinuxComm(pid: number): boolean {
  try {
    const comm = readFileSync(`/proc/${pid}/comm`, 'utf8').trim()
    // The daemon runs as `bun src/daemon/main.ts` (dev), `wechat-cc-cli`
    // (compiled binary), or `node` (vitest runner during tests). Anything
    // else (sshd, bash, chrome, the user's just-booted login shell that
    // happened to grab pid 2553 again) means PID reuse → not our daemon.
    return comm === 'bun' || comm === 'wechat-cc-cli' || comm === 'node'
  } catch {
    // /proc entry vanished between exists check and read — process died.
    return false
  }
}

// Windows equivalent: query the image name via tasklist. Same hazard as
// Linux — after BSOD / forced power-off the pidfile survives, and on next
// boot some browser-tab / explorer process can land on the recycled PID
// and look "alive". tasklist's /FO CSV output is `"image","pid",...`.
function matchWindowsImage(pid: number): boolean {
  try {
    const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' })
    if (r.status !== 0 || !r.stdout) return false
    const head = r.stdout.split('\n')[0]
    if (!head) return false
    // INFO: ... means tasklist matched no rows.
    if (head.startsWith('INFO:')) return false
    const m = head.match(/^"([^"]+)"/)
    if (!m) return false
    const image = m[1]!.toLowerCase()
    return image === 'bun.exe' || image === 'wechat-cc-cli.exe' || image === 'node.exe'
  } catch {
    return false
  }
}

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}
