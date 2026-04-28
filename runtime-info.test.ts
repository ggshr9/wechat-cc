import { describe, expect, it } from 'vitest'
import {
  isCompiledBundle,
  compiledBinaryPath,
  compiledRepoRoot,
  __testInternals,
} from './runtime-info'

const { detectCompiledBundle, resolveCompiledBinaryPath, resolveCompiledRepoRoot } = __testInternals

describe('detectCompiledBundle — primary (argv[1] /$bunfs/ prefix)', () => {
  it('returns true when entry script lives under Bun virtual fs', () => {
    expect(detectCompiledBundle('/$bunfs/root/cli.ts')).toBe(true)
    expect(detectCompiledBundle('/$bunfs/root/anything')).toBe(true)
  })

  it('returns false when entry script is a real on-disk path', () => {
    expect(detectCompiledBundle('/Users/alice/wechat-cc/cli.ts')).toBe(false)
    expect(detectCompiledBundle('/opt/bun/bin/bun')).toBe(false)
  })

  it('returns false defensively when argv[1] is missing AND no dir hint', () => {
    expect(detectCompiledBundle(undefined)).toBe(false)
    expect(detectCompiledBundle('')).toBe(false)
  })
})

describe('detectCompiledBundle — fallback (import.meta.dir existence)', () => {
  it('falls back to true when argv[1] is unrecognized but module dir does not exist on disk', () => {
    // Future-proofing: if Bun changes the virtual-fs prefix from /$bunfs/
    // to something else, the primary check fails. The fallback probes
    // import.meta.dir — in any compiled mode that path is virtual and
    // doesn't exist on the real filesystem.
    expect(detectCompiledBundle('/some/new/bun-virtual/cli.ts', '/some/new/bun-virtual')).toBe(true)
    expect(detectCompiledBundle('/$bunjs/root/cli.ts', '/$bunjs/root')).toBe(true)
  })

  it('returns false when module dir is a real on-disk path (source mode)', () => {
    // Source mode: import.meta.dir is the actual repo root, exists on disk.
    // Use process.cwd() — guaranteed to exist on every test host.
    expect(detectCompiledBundle('/some/non-bunfs/path', process.cwd())).toBe(false)
  })

  it('primary prefix wins over fallback — returns true even if module dir DOES exist', () => {
    // Defensive: primary signal is unambiguous, secondary is just a backup.
    expect(detectCompiledBundle('/$bunfs/root/cli.ts', '/tmp')).toBe(true)
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
