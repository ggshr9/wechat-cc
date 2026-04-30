import { describe, it, expect, afterEach } from 'vitest'
import { acquireInstanceLock, releaseInstanceLock } from './single-instance'
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'wcc-lock-'))
const pidPath = join(dir, 'server.pid')

afterEach(() => { releaseInstanceLock(pidPath) })

describe('single-instance', () => {
  it('acquires when no pid file exists', () => {
    const r = acquireInstanceLock(pidPath)
    expect(r.ok).toBe(true)
    expect(existsSync(pidPath)).toBe(true)
  })

  it('steals lock when pid file refers to dead process', () => {
    writeFileSync(pidPath, '999999999', 'utf8')
    const r = acquireInstanceLock(pidPath)
    expect(r.ok).toBe(true)
  })

  it('refuses when pid file refers to live process (self)', () => {
    writeFileSync(pidPath, String(process.pid), 'utf8')
    const r = acquireInstanceLock(pidPath)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/already running/i)
  })

  it('steals lock when pid file refers to a live but unrelated process (post-reboot PID reuse)', () => {
    // Reproduces the post-kernel-panic scenario: the pidfile points at a
    // PID that IS alive after reboot, but it belongs to some other
    // process (sshd, login shell, etc.) — not our daemon.
    // pid 1 (init/systemd) is always alive and never our daemon.
    writeFileSync(pidPath, '1', 'utf8')
    const r = acquireInstanceLock(pidPath)
    expect(r.ok).toBe(true)
  })
})
