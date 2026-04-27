import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { loadHearthApi, type HearthApi } from './hearth-adapter'

const api: HearthApi = {
  ingestFromChannel: async () => ({ ok: true, summary: 'ok', change_id: 'c1' }),
  listPending: () => ({ rendered: 'pending', items: [] }),
  showPending: () => ({ ok: true, rendered: 'show' }),
  applyForOwner: async () => ({ ok: true, rendered: 'applied' }),
  renderPlanMarkdown: () => ({ ok: true, title: 'Plan', markdown: '# Plan' }),
}

describe('hearth-adapter', () => {
  it('loads an explicitly configured HEARTH_MODULE without requiring package dependencies', async () => {
    const seen: string[] = []
    const result = await loadHearthApi({
      env: { HEARTH_MODULE: 'virtual-hearth' },
      cwd: '/tmp/wechat-cc',
      homeDir: '/tmp/home',
      importer: async (specifier) => {
        seen.push(specifier)
        return api
      },
    })

    expect(result.ok).toBe(true)
    expect(seen).toEqual(['virtual-hearth'])
  })

  it('discovers a local hearth repo through HEARTH_HOME src/index.ts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hearth-home-'))
    try {
      const src = join(root, 'src')
      mkdirSync(src)
      const index = join(src, 'index.ts')
      writeFileSync(index, 'export {}\n')
      const expectedSpecifier = pathToFileURL(index).href

      const result = await loadHearthApi({
        env: { HEARTH_HOME: root },
        cwd: '/tmp/wechat-cc',
        homeDir: '/tmp/home',
        importer: async (specifier) => {
          expect(specifier).toBe(expectedSpecifier)
          return api
        },
      })

      expect(result.ok).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('reports not_found when every candidate fails to import', async () => {
    const result = await loadHearthApi({
      env: {},
      cwd: '/tmp/wechat-cc',
      homeDir: '/tmp/home',
      importer: async () => {
        throw new Error('Cannot find package')
      },
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('not_found')
      expect(result.checked).toContain('node_modules:hearth')
    }
  })

  it('reports invalid_export only when a loaded module lacks the hearth API', async () => {
    const result = await loadHearthApi({
      env: { HEARTH_MODULE: 'virtual-hearth' },
      cwd: '/tmp/wechat-cc',
      homeDir: '/tmp/home',
      importer: async () => ({ listPending: () => ({ rendered: '', items: [] }) }),
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('invalid_export')
      expect(result.error).toContain('did not export')
    }
  })
})
