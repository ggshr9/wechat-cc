import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs'

export type LockResult = { ok: true } | { ok: false; reason: string; pid: number }

export function acquireInstanceLock(pidPath: string): LockResult {
  if (existsSync(pidPath)) {
    try {
      const raw = readFileSync(pidPath, 'utf8').trim()
      const pid = Number(raw)
      if (Number.isFinite(pid) && pid > 0 && isAlive(pid)) {
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

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}
