import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { platform } from 'node:os'
import { spawnSync } from 'node:child_process'

export type LockResult = { ok: true } | { ok: false; reason: string; pid: number }

export interface AcquireOpts {
  /**
   * Liveness→health upgrade. `isOurDaemon(pid)` only proves a process that
   * LOOKS like our daemon is alive — not that it's actually serving. A
   * wedged or half-started daemon (e.g. a desktop/launchd instance that
   * never bound an account) holds the pidfile while doing nothing, which
   * made the CLI refuse to start with "another daemon already running".
   *
   * When supplied, this probe is consulted for an alive-and-ours holder: if
   * it returns `false`, the lock is treated as STALE and taken over. Omit
   * for the legacy behaviour (any alive-and-ours holder refuses). The daemon
   * wires this to a heartbeat-freshness check (see main.ts); tests inject
   * a stub.
   */
  isHealthy?: (pid: number) => boolean
}

export function acquireInstanceLock(pidPath: string, opts?: AcquireOpts): LockResult {
  if (existsSync(pidPath)) {
    try {
      const raw = readFileSync(pidPath, 'utf8').trim()
      const pid = Number(raw)
      if (Number.isFinite(pid) && pid > 0 && isOurDaemon(pid)) {
        // Alive and looks like our daemon. Refuse — UNLESS a health probe
        // says the holder isn't actually serving, in which case fall through
        // and steal the stale lock rather than wedge the user behind a dead
        // placeholder.
        if (!opts?.isHealthy || opts.isHealthy(pid)) {
          return { ok: false, reason: 'another daemon already running', pid }
        }
      }
    } catch {}
  }
  writeFileSync(pidPath, String(process.pid), 'utf8')
  return { ok: true }
}

/**
 * How long a heartbeat may go un-refreshed before the holder is considered
 * wedged. Must comfortably exceed the ilink long-poll round-trip + retry
 * backoff (a healthy daemon writes the heartbeat once per poll cycle), so a
 * legitimately slow poll never trips a false steal. 120s ≈ 2–4× a normal
 * long-poll window.
 */
export const HEARTBEAT_STALE_MS = 120_000

/** Heartbeat filename under stateDir. Shared by the producer (poll-cycle
 *  writer, wired in lifecycle-deps) and consumer (instance-lock health
 *  check, in main.ts) so both agree on the path. */
export const HEARTBEAT_FILE = 'server.heartbeat'

/** Stamp the heartbeat file with `now`. Called once per successful poll
 *  cycle (the "I am actually serving" signal) and once at startup. Best
 *  effort — a write failure must never crash the daemon. */
export function writeHeartbeat(heartbeatPath: string, now: number = Date.now()): void {
  try { writeFileSync(heartbeatPath, String(now), 'utf8') } catch { /* best-effort */ }
}

/**
 * True if the heartbeat was refreshed within `staleMs`. A missing,
 * unreadable, or non-numeric heartbeat returns `true` (FRESH) on purpose:
 * absence is not proof of a wedge (the holder may predate heartbeats or have
 * just started and not written one yet), and stealing on unproven staleness
 * would risk two live daemons. Only a heartbeat that EXISTS and is older than
 * the window counts as a wedged holder.
 */
export function isHeartbeatFresh(heartbeatPath: string, staleMs: number = HEARTBEAT_STALE_MS, now: number = Date.now()): boolean {
  try {
    const ts = Number(readFileSync(heartbeatPath, 'utf8').trim())
    if (!Number.isFinite(ts)) return true
    return now - ts < staleMs
  } catch {
    return true
  }
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
  if (pf === 'darwin') return matchDarwinComm(pid)
  // Other Unixes — process exists check only; PID-reuse is the same hazard
  // but no portable comm lookup. Acceptable until a user reports a hit.
  return true
}

// macOS: ps -p $pid -o comm= prints the process's executable command path,
// trimmed of header. Mirrors Linux's /proc/PID/comm. Without this, a stale
// pidfile from a power-loss leaves the daemon unable to start until the
// user manually deletes server.pid — because PID reuse on macOS is common
// enough that some Spotlight / WindowServer process eventually inherits
// the recycled PID and looks "alive" via kill(pid, 0).
function matchDarwinComm(pid: number): boolean {
  try {
    const r = spawnSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8', windowsHide: true })
    if (r.status !== 0 || !r.stdout) return false
    // `ps -o comm=` returns the full path on macOS (e.g.
    // `/Users/x/.bun/bin/bun`); take basename for the match.
    const full = r.stdout.trim()
    if (!full) return false
    const basename = full.split('/').pop() ?? full
    return basename === 'bun' || basename === 'wechat-cc-cli' || basename === 'node'
  } catch {
    return false
  }
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
    const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true })
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
