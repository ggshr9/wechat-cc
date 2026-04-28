import { describe, expect, it } from 'vitest'
import {
  isCompiledBundle,
  compiledBinaryPath,
  compiledRepoRoot,
  __testInternals,
} from './runtime-info'

const { detectCompiledBundle, resolveCompiledBinaryPath, resolveCompiledRepoRoot } = __testInternals

describe('detectCompiledBundle', () => {
  it('returns true when entry script lives under Bun virtual fs', () => {
    expect(detectCompiledBundle('/$bunfs/root/cli.ts')).toBe(true)
    expect(detectCompiledBundle('/$bunfs/root/anything')).toBe(true)
  })

  it('returns false when entry script is a real on-disk path', () => {
    expect(detectCompiledBundle('/Users/alice/wechat-cc/cli.ts')).toBe(false)
    expect(detectCompiledBundle('/opt/bun/bin/bun')).toBe(false)
  })

  it('returns false defensively when argv[1] is missing', () => {
    expect(detectCompiledBundle(undefined)).toBe(false)
    expect(detectCompiledBundle('')).toBe(false)
  })
})

describe('resolveCompiledBinaryPath', () => {
  it('returns process.execPath when compiled', () => {
    expect(resolveCompiledBinaryPath(true, '/Applications/wechat-cc.app/Contents/MacOS/wechat-cc-cli'))
      .toBe('/Applications/wechat-cc.app/Contents/MacOS/wechat-cc-cli')
  })

  it('returns null in source mode', () => {
    expect(resolveCompiledBinaryPath(false, '/opt/bun/bin/bun')).toBe(null)
  })
})

describe('resolveCompiledRepoRoot', () => {
  it('returns dirname(process.execPath) when compiled', () => {
    expect(resolveCompiledRepoRoot(true, '/Applications/wechat-cc.app/Contents/MacOS/wechat-cc-cli'))
      .toBe('/Applications/wechat-cc.app/Contents/MacOS')
  })

  it('returns null in source mode', () => {
    expect(resolveCompiledRepoRoot(false, '/opt/bun/bin/bun')).toBe(null)
  })
})

// Smoke-level: the public API just delegates to the internals using runtime
// process state. We don't try to spoof process.argv/execPath in vitest —
// these assertions just prove the public functions are wired up and return
// shape-correct values.
describe('public API (live process state)', () => {
  it('isCompiledBundle returns a boolean', () => {
    expect(typeof isCompiledBundle()).toBe('boolean')
  })

  it('compiledBinaryPath is null when isCompiledBundle is false (source mode)', () => {
    if (!isCompiledBundle()) expect(compiledBinaryPath()).toBe(null)
  })

  it('compiledRepoRoot is null when isCompiledBundle is false', () => {
    if (!isCompiledBundle()) expect(compiledRepoRoot()).toBe(null)
  })
})
