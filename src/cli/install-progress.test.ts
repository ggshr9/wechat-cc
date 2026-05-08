import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readInstallProgress } from './install-progress'

let stateDir: string

beforeEach(() => { stateDir = mkdtempSync(join(tmpdir(), 'wechat-cc-iprog-')) })
afterEach(() => { rmSync(stateDir, { recursive: true, force: true }) })

// Why this helper exists: pre-2026-05-07 the cli.ts handler called
// `console.log(raw.trim() || '{}')` without parsing the file — so a
// stale/malformed install-progress.json would leak garbage to the GUI
// wizard. readInstallProgress() enforces the InstallProgressOutput
// schema and reduces every failure mode to a typed result. Producer
// is in src/cli/service-manager.ts (onProgress hook).
describe('readInstallProgress', () => {
  it('returns kind=empty when file is missing (fresh install dir)', () => {
    expect(readInstallProgress(stateDir)).toEqual({ kind: 'empty' })
  })

  it('returns kind=empty when file is whitespace-only', () => {
    writeFileSync(join(stateDir, 'install-progress.json'), '   \n\n')
    expect(readInstallProgress(stateDir)).toEqual({ kind: 'empty' })
  })

  it('returns kind=empty when file contains a literal {} (no install in flight)', () => {
    writeFileSync(join(stateDir, 'install-progress.json'), '{}')
    expect(readInstallProgress(stateDir)).toEqual({ kind: 'empty' })
  })

  it('returns kind=progress with parsed value when file matches the schema', () => {
    const payload = { step: 2, total: 4, label: 'launchctl bootstrap', ts: 1714900000000 }
    writeFileSync(join(stateDir, 'install-progress.json'), JSON.stringify(payload))
    expect(readInstallProgress(stateDir)).toEqual({ kind: 'progress', value: payload })
  })

  it('returns kind=invalid for malformed JSON', () => {
    writeFileSync(join(stateDir, 'install-progress.json'), '{step: 2, total:')
    const r = readInstallProgress(stateDir)
    expect(r.kind).toBe('invalid')
    if (r.kind !== 'invalid') return
    expect(r.error).toMatch(/JSON|parse/i)
  })

  it('returns kind=invalid when JSON is valid but shape is wrong (e.g. step is a string)', () => {
    writeFileSync(join(stateDir, 'install-progress.json'), JSON.stringify({ step: 'two', total: 4, label: 'x', ts: 0 }))
    const r = readInstallProgress(stateDir)
    expect(r.kind).toBe('invalid')
    if (r.kind !== 'invalid') return
    expect(r.error).toMatch(/step|number|expected/i)
  })

  it('returns kind=invalid when file is unreadable (permission error)', () => {
    if (process.platform === 'win32') return  // chmod semantics differ on Windows
    const path = join(stateDir, 'install-progress.json')
    writeFileSync(path, JSON.stringify({ step: 1, total: 2, label: 'x', ts: 0 }))
    chmodSync(path, 0o000)
    try {
      const r = readInstallProgress(stateDir)
      // Some test environments (root, container) bypass file mode checks; in
      // that case the read succeeds and returns kind=progress. Skip the
      // assertion in those cases — the real-world bug we care about is
      // shape mismatch + malformed JSON, which the prior tests cover.
      if (r.kind === 'progress') return
      expect(r.kind).toBe('invalid')
    } finally {
      chmodSync(path, 0o600)
    }
  })
})
