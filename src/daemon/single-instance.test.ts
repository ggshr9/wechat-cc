import { describe, it, expect, afterEach } from 'vitest'
import { acquireInstanceLock, releaseInstanceLock, writeHeartbeat, isHeartbeatFresh } from './single-instance'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs'
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

  it('steals lock when the live daemon holder fails the health check (wedged/half-started placeholder)', () => {
    // The reported desktop scenario: launchd auto-starts a daemon that holds
    // the pidfile (process alive, comm=bun) but never actually serves — so
    // the CLI used to refuse with "already running" and the user had to kill
    // it by hand. With an injected health probe that reports the holder is
    // not serving, acquire treats the lock as stale and takes it over.
    writeFileSync(pidPath, String(process.pid), 'utf8') // self → looks like our daemon
    const r = acquireInstanceLock(pidPath, { isHealthy: () => false })
    expect(r.ok).toBe(true)
  })

  it('still refuses when the live daemon holder passes the health check', () => {
    writeFileSync(pidPath, String(process.pid), 'utf8')
    const r = acquireInstanceLock(pidPath, { isHealthy: () => true })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/already running/i)
  })

  it('writes our own pid into the file after stealing a dead holder', () => {
    // The atomic-claim refactor (exclusive `wx` create for a fresh start, then
    // inspect+steal on EEXIST) must still leave OUR pid in the file when it
    // steals a dead holder — otherwise releaseInstanceLock would never clean up.
    writeFileSync(pidPath, '999999999', 'utf8')
    const r = acquireInstanceLock(pidPath)
    expect(r.ok).toBe(true)
    expect(readFileSync(pidPath, 'utf8').trim()).toBe(String(process.pid))
  })

  it('does not overwrite a healthy holder\'s pid when it refuses', () => {
    // Exclusive-create + refuse-before-write: a refused acquire must leave the
    // holder's pidfile untouched (no clobber of the live daemon's identity).
    writeFileSync(pidPath, String(process.pid), 'utf8')
    const before = readFileSync(pidPath, 'utf8')
    const r = acquireInstanceLock(pidPath, { isHealthy: () => true })
    expect(r.ok).toBe(false)
    expect(readFileSync(pidPath, 'utf8')).toBe(before)
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

describe('heartbeat (daemon health signal for the instance lock)', () => {
  const hbPath = join(dir, 'server.heartbeat')
  afterEach(() => { try { unlinkSync(hbPath) } catch { /* may not exist */ } })

  it('is fresh immediately after a write', () => {
    writeHeartbeat(hbPath, 1000)
    expect(isHeartbeatFresh(hbPath, 5000, 2000)).toBe(true)
  })

  it('is stale once older than the threshold', () => {
    writeHeartbeat(hbPath, 1000)
    expect(isHeartbeatFresh(hbPath, 5000, 10_000)).toBe(false)
  })

  it('treats a missing heartbeat as fresh — never steal a lock we cannot prove is stale', () => {
    expect(isHeartbeatFresh(join(dir, 'no-such.heartbeat'), 5000, 10_000)).toBe(true)
  })
})
