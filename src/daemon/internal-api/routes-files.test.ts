// src/daemon/internal-api/routes-files.test.ts
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileRoutes } from './routes-files'
import { defaultLifeDirs } from '../../lib/file-survey'
import { minTierFor } from './route-tiers'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wcc-routes-files-'))
  writeFileSync(join(dir, '预算表.xlsx'), 'x')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('GET /v1/locate', () => {
  const handler = () => fileRoutes()['GET /v1/locate']!

  it('returns candidates from caller-supplied roots', async () => {
    const q = new URLSearchParams({ q: '预算', mode: 'name' })
    q.append('root', dir)
    const res = await handler()(q, undefined)
    expect(res.status).toBe(200)
    const body = res.body as { candidates: Array<{ name: string }>; truncated: boolean }
    expect(body.candidates.map(c => c.name)).toContain('预算表.xlsx')
  })

  it('ignores non-absolute roots and still searches valid ones', async () => {
    const q = new URLSearchParams({ q: '预算' })
    q.append('root', 'relative/path')   // dropped (not absolute)
    q.append('root', dir)               // kept
    const res = await handler()(q, undefined)
    expect(res.status).toBe(200)
    const body = res.body as { candidates: Array<{ name: string }> }
    expect(body.candidates.map(c => c.name)).toContain('预算表.xlsx')
  })

  it('default life dirs are Desktop/Documents/Downloads under home', () => {
    expect(defaultLifeDirs('/home/me')).toEqual(['/home/me/Desktop', '/home/me/Documents', '/home/me/Downloads'])
  })

  it('route is admin-tier', () => {
    expect(minTierFor('GET /v1/locate')).toBe('admin')
  })
})
