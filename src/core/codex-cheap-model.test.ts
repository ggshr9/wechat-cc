import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveCodexCheapModel } from './codex-cheap-model'

describe('resolveCodexCheapModel — PR F resolution chain', () => {
  let dir: string
  let cachePath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'codex-cheap-model-test-'))
    cachePath = join(dir, 'models_cache.json')
  })
  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
  })

  it('1. env override wins over cache', () => {
    writeFileSync(cachePath, JSON.stringify({
      models: [{ slug: 'gpt-5.4-mini', visibility: 'list', supported_in_api: true, priority: 4 }],
    }))
    const got = resolveCodexCheapModel({
      cachePath,
      env: { WECHAT_CODEX_CHEAP_MODEL: 'gpt-explicit-override' },
    })
    expect(got).toBe('gpt-explicit-override')
  })

  it('2. picks -mini variant from cache when present', () => {
    writeFileSync(cachePath, JSON.stringify({
      models: [
        { slug: 'gpt-5.5',      visibility: 'list', supported_in_api: true, priority: 0 },
        { slug: 'gpt-5.4',      visibility: 'list', supported_in_api: true, priority: 2 },
        { slug: 'gpt-5.4-mini', visibility: 'list', supported_in_api: true, priority: 4 },
        { slug: 'gpt-5.2',      visibility: 'list', supported_in_api: true, priority: 10 },
      ],
    }))
    const got = resolveCodexCheapModel({ cachePath, env: {} })
    expect(got).toBe('gpt-5.4-mini')
  })

  it('3. falls back to highest-priority eligible model when no -mini', () => {
    writeFileSync(cachePath, JSON.stringify({
      models: [
        { slug: 'gpt-5.5', visibility: 'list', supported_in_api: true, priority: 0 },
        { slug: 'gpt-5.4', visibility: 'list', supported_in_api: true, priority: 2 },
        { slug: 'gpt-5.2', visibility: 'list', supported_in_api: true, priority: 10 },  // largest priority → cheapest
      ],
    }))
    const got = resolveCodexCheapModel({ cachePath, env: {} })
    expect(got).toBe('gpt-5.2')
  })

  it('skips visibility=hide entries (internal/tool-only models)', () => {
    writeFileSync(cachePath, JSON.stringify({
      models: [
        { slug: 'gpt-internal-mini', visibility: 'hide', supported_in_api: true, priority: 99 },
        { slug: 'gpt-5.5',           visibility: 'list', supported_in_api: true, priority: 0 },
      ],
    }))
    const got = resolveCodexCheapModel({ cachePath, env: {} })
    // hidden mini ignored; falls to highest-priority eligible (only gpt-5.5)
    expect(got).toBe('gpt-5.5')
  })

  it('skips supported_in_api=false entries', () => {
    writeFileSync(cachePath, JSON.stringify({
      models: [
        { slug: 'gpt-mini-api-disabled', visibility: 'list', supported_in_api: false, priority: 99 },
        { slug: 'gpt-5.5',               visibility: 'list', supported_in_api: true,  priority: 0 },
      ],
    }))
    const got = resolveCodexCheapModel({ cachePath, env: {} })
    expect(got).toBe('gpt-5.5')
  })

  it('4. returns hardcoded fallback when cache file missing', () => {
    const got = resolveCodexCheapModel({ cachePath: join(dir, 'does-not-exist.json'), env: {} })
    expect(got).toBe('gpt-5.4-mini')
  })

  it('4. returns hardcoded fallback when cache file is malformed JSON', () => {
    writeFileSync(cachePath, '{not json{')
    const got = resolveCodexCheapModel({ cachePath, env: {} })
    expect(got).toBe('gpt-5.4-mini')
  })

  it('4. returns hardcoded fallback when cache has zero eligible rows', () => {
    writeFileSync(cachePath, JSON.stringify({
      models: [
        { slug: 'internal', visibility: 'hide', supported_in_api: false, priority: 0 },
      ],
    }))
    const got = resolveCodexCheapModel({ cachePath, env: {} })
    expect(got).toBe('gpt-5.4-mini')
  })

  it('env empty string is treated as unset (falls through to cache)', () => {
    writeFileSync(cachePath, JSON.stringify({
      models: [{ slug: 'gpt-5.4-mini', visibility: 'list', supported_in_api: true, priority: 4 }],
    }))
    const got = resolveCodexCheapModel({ cachePath, env: { WECHAT_CODEX_CHEAP_MODEL: '' } })
    expect(got).toBe('gpt-5.4-mini')
  })
})
