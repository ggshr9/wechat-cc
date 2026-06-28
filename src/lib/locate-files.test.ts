import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { locateFiles, DEFAULT_LIMITS } from './locate-files'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wcc-locate-'))
  mkdirSync(join(root, 'work'), { recursive: true })
  mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true })
  writeFileSync(join(root, 'work', 'Q3预算.xlsx'), 'col,val\nrevenue,100')
  writeFileSync(join(root, 'work', 'notes.txt'), '关于预算的讨论纪要')
  writeFileSync(join(root, 'random.pdf'), 'unrelated')
  writeFileSync(join(root, 'node_modules', 'pkg', '预算.js'), 'noise')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('locateFiles', () => {
  it('name mode matches on filename and ranks name-hits first', () => {
    const r = locateFiles({ roots: [root], query: '预算', mode: 'name' })
    const names = r.candidates.map(c => c.name)
    expect(names).toContain('Q3预算.xlsx')
    expect(names).not.toContain('notes.txt')        // body match, not name → excluded in name mode
    expect(names).not.toContain('预算.js')           // under node_modules → skipped
    expect(r.candidates[0]!.name).toBe('Q3预算.xlsx') // name hit ranks first
  })

  it('content mode falls back to body matches when filename misses', () => {
    const r = locateFiles({ roots: [root], query: '讨论纪要', mode: 'content' })
    expect(r.candidates.map(c => c.name)).toContain('notes.txt')
  })

  it('browse mode lists immediate children (files + dirs), no recursion', () => {
    const r = locateFiles({ roots: [root], mode: 'browse' })
    const names = r.candidates.map(c => c.name)
    expect(names).toEqual(expect.arrayContaining(['work', 'random.pdf']))
    expect(r.candidates.find(c => c.name === 'work')!.isDir).toBe(true)
    expect(names).not.toContain('Q3预算.xlsx')        // child of work/, not listed (depth 0 only)
    expect(names).not.toContain('node_modules')      // SKIP_DIRS pruned even at depth 0
  })

  it('tolerates a missing root and truncates on maxEntries', () => {
    const r = locateFiles({
      roots: [join(root, 'does-not-exist'), root],
      query: 'x', mode: 'name', limits: { maxEntries: 1 },
    })
    expect(r.truncated).toBe(true)
    expect(r.scannedEntries).toBeGreaterThan(0)
  })

  it('searches caller-supplied roots before defaults are appended by the route (order preserved)', () => {
    const r = locateFiles({ roots: [join(root, 'work'), root], query: '预算', mode: 'name' })
    expect(r.candidates[0]!.name).toBe('Q3预算.xlsx')
  })

  it('truncates when the injected clock passes the deadline mid-walk', () => {
    let calls = 0
    // 1st call sets the deadline (start); every later call reads as past it.
    const now = () => (calls++ === 0 ? 0 : DEFAULT_LIMITS.timeoutMs + 1)
    const r = locateFiles({ roots: [root], query: '预算', mode: 'name', now })
    expect(r.truncated).toBe(true)
  })
})
